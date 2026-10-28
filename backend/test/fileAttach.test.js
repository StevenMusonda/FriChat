/**
 * Files are attached to messages only by the id the upload endpoint returned.
 * Forged client file records, other users' files and already-used files are refused on the
 * send_message socket event and on POST /api/messages; upload-then-send still works; and the
 * uploads folder can't be escaped through stored paths or the /uploads static route.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const CHAT_ID = 5;
const ME = 1;
const OTHER = 2;
const NEW_MESSAGE_ID = 42;

const MY_FILE = 7;          // uploaded by ME, not attached yet
const OTHERS_FILE = 8;      // uploaded by OTHER, not attached yet
const USED_FILE = 9;        // uploaded by ME, already attached to a message
const OUTSIDE_FILE = 10;    // a row (e.g. written before the fix) whose path leaves the uploads folder

/**
 * In-memory files table plus the queries a send makes, the way each database answers them
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const files = {
        [MY_FILE]: { id: MY_FILE, mime_type: 'application/pdf', upload_path: path.join('uploads', 'files', 'mine.pdf'), uploaded_by: ME, attached_at: null },
        [OTHERS_FILE]: { id: OTHERS_FILE, mime_type: 'image/png', upload_path: path.join('uploads', 'images', 'theirs.png'), uploaded_by: OTHER, attached_at: null },
        [USED_FILE]: { id: USED_FILE, mime_type: 'image/png', upload_path: path.join('uploads', 'images', 'used.png'), uploaded_by: ME, attached_at: new Date() },
        [OUTSIDE_FILE]: { id: OUTSIDE_FILE, mime_type: 'text/plain', upload_path: '../../.env', uploaded_by: ME, attached_at: null }
    };
    const world = { files, nextFileId: 100 };
    const inserted = (id, sql) => pg ? (/ RETURNING id$/.test(sql) ? [{ id }] : []) : { insertId: id };
    const written = (n = 1) => pg ? [] : { affectedRows: n };

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        if (/^SELECT id FROM group_members WHERE chat_id/.test(sql)) return [{ id: 1 }];
        if (/^SELECT gm.id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c ON c.id = gm.chat_id WHERE gm.chat_id = \? AND gm.user_id = \?/.test(sql)) return [{ id: 1, role: 'member', chat_type: 'group', announcement_only: false }];

        // Files
        if (/^INSERT INTO files/.test(sql)) {
            const id = world.nextFileId++;
            const [original_name, stored_name, , file_size, mime_type, upload_path, uploaded_by] = params;
            files[id] = { id, original_name, stored_name, file_size, mime_type, upload_path, uploaded_by, attached_at: /attached_at/.test(sql) ? new Date() : null };
            return inserted(id, sql);
        }
        if (/^SELECT id, mime_type, upload_path, uploaded_by, attached_at FROM files WHERE id = \?$/.test(sql)) {
            const f = files[params[0]];
            return f ? [{ ...f }] : [];
        }
        if (/^UPDATE files SET attached_at = CURRENT_TIMESTAMP WHERE id = \? AND uploaded_by = \? AND attached_at IS NULL/.test(sql)) {
            const f = files[params[0]];
            const ok = f && f.uploaded_by === params[1] && !f.attached_at;
            if (ok) f.attached_at = new Date();
            if (pg) return ok && / RETURNING id$/.test(sql) ? [{ id: f.id }] : [];
            return written(ok ? 1 : 0);
        }
        if (/^UPDATE files SET attached_at = NULL WHERE id = \?$/.test(sql)) {
            if (files[params[0]]) files[params[0]].attached_at = null;
            return written();
        }

        // Message insert and the bookkeeping after it
        if (/^INSERT INTO messages/.test(sql)) return inserted(NEW_MESSAGE_ID, sql);
        if (/^UPDATE/.test(sql)) return written();
        if (/^SELECT last_read_message_id FROM group_members/.test(sql)) return [{ last_read_message_id: NEW_MESSAGE_ID - 1 }];
        if (/^SELECT id FROM messages WHERE id = /.test(sql)) return [{ id: NEW_MESSAGE_ID }];
        if (/^SELECT MAX\(id\) AS id FROM messages/.test(sql)) return [{ id: NEW_MESSAGE_ID }];
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 0 }];
        if (/FROM messages m JOIN users u ON m.sender_id = u.id/.test(sql)) {
            return [{ id: NEW_MESSAGE_ID, chat_id: CHAT_ID, sender_id: ME, content: null, message_type: 'file' }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };

    return world;
}

// Loads server.js against the fake driver and fires one send_message from user ME
async function sendViaSocket(dbType, world, data) {
    const fake = setupFakeDb(dbType, world.handler);
    process.env.PORT = '0';
    stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });

    const log = console.log;
    console.log = () => {};
    const { io } = fake.load('server.js');
    const recorder = fakeIo();
    io.to = recorder.to;

    const handlers = {};
    const socketErrors = [];
    const socket = {
        id: 'test-socket',
        userId: ME,
        data: {},
        join() {},
        on(event, fn) { handlers[event] = fn; },
        emit(event, payload) { if (event === 'error') socketErrors.push(payload); }
    };

    try {
        io.sockets.listeners('connection')[0](socket);
        await handlers.send_message(data);
    } finally {
        await new Promise(resolve => io.close(() => resolve()));
        console.log = log;
    }
    return { calls: fake.calls, emitted: recorder.emitted, socketErrors };
}

const messageInserts = (calls) => calls.filter(c => /^INSERT INTO messages/.test(c.sql));
const fileInserts = (calls) => calls.filter(c => /^INSERT INTO files/.test(c.sql));

for (const dbType of ['mysql', 'postgresql']) {
    describe(`file attachments (${dbType})`, () => {
        describe('send_message socket event', () => {
            async function expectRejected(data, message) {
                const world = createWorld(dbType);
                const { calls, emitted, socketErrors } = await sendViaSocket(dbType, world, { chatId: CHAT_ID, ...data });

                assert.equal(socketErrors.length, 1);
                assert.equal(socketErrors[0].event, 'send_message');
                if (message) assert.equal(socketErrors[0].message, message);
                assert.equal(fileInserts(calls).length, 0, 'no files row is written');
                assert.equal(messageInserts(calls).length, 0, 'no message is written');
                assert.equal(emitted.filter(e => e.event === 'new_message').length, 0);
                return world;
            }

            test('a forged fileData record is rejected', async () => {
                await expectRejected({
                    messageType: 'file',
                    fileData: { path: '../../.env', uploadPath: '../../.env', originalName: '.env', mimeType: 'image/png', fileSize: 1 }
                }, 'Attach files by fileId from the upload endpoint');
            });

            test('fileData is rejected even next to a valid fileId', async () => {
                const world = await expectRejected({ messageType: 'file', fileId: MY_FILE, fileData: { uploadPath: '../../.env' } });
                assert.equal(world.files[MY_FILE].attached_at, null, 'the upload is still usable');
            });

            test("another user's file id is rejected", async () => {
                const world = await expectRejected({ messageType: 'image', fileId: OTHERS_FILE }, 'File not found');
                assert.equal(world.files[OTHERS_FILE].attached_at, null);
            });

            test('an already used file id is rejected', async () => {
                await expectRejected({ messageType: 'image', fileId: USED_FILE }, 'File is already attached to a message');
            });

            test('a file row whose path leaves the uploads folder is rejected', async () => {
                await expectRejected({ messageType: 'file', fileId: OUTSIDE_FILE }, 'File not found');
            });

            test('a missing or malformed file id is rejected', async () => {
                await expectRejected({ messageType: 'file', fileId: 999 }, 'File not found');
                await expectRejected({ messageType: 'file', fileId: '../x' }, 'Invalid file reference');
            });

            test('a media type without a file is rejected', async () => {
                await expectRejected({ messageType: 'image', content: 'hi' }, 'A file is required for this message type');
            });

            test('upload then send attaches the file once, typed from the server record', async () => {
                const world = createWorld(dbType);

                // 1. Upload only (no chatId) through the real controller
                const upload = setupFakeDb(dbType, world.handler);
                const { uploadFile } = upload.load('controllers/messageController.js');
                const res = fakeRes();
                await uploadFile({
                    user: { id: ME },
                    body: {},
                    io: fakeIo(),
                    file: {
                        originalname: 'report.pdf',
                        filename: 'report-123.pdf',
                        size: 2048,
                        mimetype: 'application/pdf',
                        path: path.join('uploads', 'files', 'report-123.pdf')
                    }
                }, res);

                assert.equal(res.statusCode, 201);
                const { fileId } = res.body.data;
                assert.ok(fileId);
                assert.equal(world.files[fileId].attached_at, null);
                assert.equal(messageInserts(upload.calls).length, 0, 'upload-only creates no message');

                // 2. Send it; the client's messageType is ignored in favour of the stored mime type
                const sent = await sendViaSocket(dbType, world, { chatId: CHAT_ID, messageType: 'image', content: 'the report', fileId });

                assert.deepEqual(sent.socketErrors, []);
                const [insert] = messageInserts(sent.calls);
                assert.equal(insert.params[2], 'file');
                assert.equal(insert.params[3], 'the report');
                assert.equal(insert.params[4], fileId);
                assert.ok(world.files[fileId].attached_at);
                assert.equal(sent.emitted.filter(e => e.event === 'new_message').length, 1);

                // 3. The same id can't be used a second time
                const again = await sendViaSocket(dbType, world, { chatId: CHAT_ID, messageType: 'file', fileId });
                assert.equal(again.socketErrors[0].message, 'File is already attached to a message');
                assert.equal(messageInserts(again.calls).length, 0);
            });
        });

        describe('POST /api/messages', () => {
            async function send(world, body) {
                const fake = setupFakeDb(dbType, world.handler);
                const { sendMessage } = fake.load('controllers/messageController.js');
                const res = fakeRes();
                await sendMessage({ user: { id: ME }, body: { chatId: CHAT_ID, ...body }, io: fakeIo() }, res);
                return { res, calls: fake.calls };
            }

            test("another user's, a used and an outside file are refused", async () => {
                for (const fileId of [OTHERS_FILE, USED_FILE, OUTSIDE_FILE]) {
                    const { res, calls } = await send(createWorld(dbType), { messageType: 'file', fileId });
                    assert.equal(res.statusCode, 400, `file ${fileId}`);
                    assert.equal(messageInserts(calls).length, 0);
                }
            });

            test('a media type without a file is refused', async () => {
                const { res, calls } = await send(createWorld(dbType), { messageType: 'video', content: 'x' });
                assert.equal(res.statusCode, 400);
                assert.equal(messageInserts(calls).length, 0);
            });

            test('an uploaded file is attached by id', async () => {
                const world = createWorld(dbType);
                const { res, calls } = await send(world, { messageType: 'text', fileId: MY_FILE });

                assert.equal(res.statusCode, 201);
                const [insert] = messageInserts(calls);
                assert.equal(insert.params[2], 'file');
                assert.equal(insert.params[4], MY_FILE);
                assert.ok(world.files[MY_FILE].attached_at);
            });
        });

        test('upload with chatId stores the file as already attached', async () => {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            const { uploadFile } = fake.load('controllers/messageController.js');
            const res = fakeRes();
            await uploadFile({
                user: { id: ME },
                body: { chatId: CHAT_ID },
                io: fakeIo(),
                file: { originalname: 'a.png', filename: 'a-1.png', size: 10, mimetype: 'image/png', path: path.join('uploads', 'images', 'a-1.png') }
            }, res);

            assert.equal(res.statusCode, 201);
            const [insert] = fileInserts(fake.calls);
            assert.match(insert.sql, /attached_at/);
            assert.equal(messageInserts(fake.calls).length, 1);
        });
    });
}

describe('uploads folder containment', () => {
    const { resolveUploadPath, guardStaticPath, UPLOAD_DIR } = require('../utils/uploads');

    test('stored paths must resolve inside the uploads folder', () => {
        assert.equal(resolveUploadPath(path.join('uploads', 'images', 'a.png')), path.join(UPLOAD_DIR, 'images', 'a.png'));
        for (const bad of ['../../.env', 'uploads/../.env', 'uploads/images/../../server.js', 'uploads', '', null, 42, 'uploads/a\0.png', path.resolve('/etc/passwd')]) {
            assert.equal(resolveUploadPath(bad), null, String(bad));
        }
        // A sibling folder that merely starts with the same name is outside
        assert.equal(resolveUploadPath('uploads-evil/a.png'), null);
    });

    test('the static guard refuses traversal and malformed paths', () => {
        const guard = guardStaticPath(path.join(__dirname, '..', 'uploads'));
        const run = (p) => {
            const res = fakeRes();
            res.end = () => res;
            let passed = false;
            guard({ path: p }, res, () => { passed = true; });
            return passed ? 'next' : res.statusCode;
        };

        assert.equal(run('/images/a.png'), 'next');
        assert.equal(run('/..%2f..%2f.env'), 404);
        assert.equal(run('/images/%2e%2e/%2e%2e/server.js'), 404);
        assert.equal(run('/a%00.png'), 404);
        assert.equal(run('/%E0%A4%A'), 400);
        if (path.sep === '\\') {
            assert.equal(run('/..%5c..%5c.env'), 404);
        }
    });

    test('GET /uploads serves files inside and refuses encoded traversal', async () => {
        const fake = setupFakeDb('mysql', () => { throw new Error('no database expected'); });
        process.env.PORT = '0';
        stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });
        const log = console.log;
        console.log = () => {};
        const { app, io } = fake.load('server.js');

        const dir = path.join(__dirname, '..', 'uploads', 'files');
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `guard-test-${process.pid}.txt`);
        fs.writeFileSync(probe, 'ok');

        const server = http.createServer(app).listen(0);
        const get = (urlPath) => new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            }).on('error', reject);
        });

        try {
            assert.equal(await get(`/uploads/files/${path.basename(probe)}`), 200);
            assert.equal(await get('/uploads/..%2f..%2fserver.js'), 404);
            assert.equal(await get('/uploads/..%2f.gitkeep'), 404);
            assert.equal(await get('/uploads/files/%2e%2e%2f%2e%2e%2f.env'), 404);
        } finally {
            fs.unlinkSync(probe);
            await new Promise(resolve => server.close(resolve));
            await new Promise(resolve => io.close(() => resolve()));
            console.log = log;
        }
    });
});
