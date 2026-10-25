/**
 * Every send path must get the new message id on both databases and push the
 * message to the chat room (REST POST /api/messages and the send_message socket event).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const CHAT_ID = 5;
const SENDER_ID = 1;
const NEW_MESSAGE_ID = 42;
const NEW_FILE_ID = 7;

// Answers the queries a send makes, the way each database would
function sendHandler(dbType) {
    const pg = dbType === 'postgresql';
    const inserted = (id, sql) => pg ? (/ RETURNING id$/.test(sql) ? [{ id }] : []) : { insertId: id };
    const written = () => pg ? [] : { affectedRows: 1 };

    return (sql, params) => {
        if (/^SELECT id FROM group_members WHERE chat_id/.test(sql)) return [{ id: 1 }];
        if (/^INSERT INTO files/.test(sql)) return inserted(NEW_FILE_ID, sql);
        if (/^INSERT INTO messages/.test(sql)) return inserted(NEW_MESSAGE_ID, sql);
        if (/^UPDATE/.test(sql)) return written();
        if (/^SELECT last_read_message_id FROM group_members/.test(sql)) return [{ last_read_message_id: NEW_MESSAGE_ID - 1 }];
        if (/^SELECT id FROM messages WHERE id = /.test(sql)) return params[0] === NEW_MESSAGE_ID ? [{ id: NEW_MESSAGE_ID }] : [];
        if (/^SELECT MAX\(id\) AS id FROM messages/.test(sql)) return [{ id: NEW_MESSAGE_ID }];
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 0 }];
        if (/FROM messages m JOIN users u ON m.sender_id = u.id/.test(sql)) {
            return params[0] === NEW_MESSAGE_ID
                ? [{ id: NEW_MESSAGE_ID, chat_id: CHAT_ID, sender_id: SENDER_ID, content: 'hello', message_type: 'text' }]
                : [];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`send paths (${dbType})`, () => {
        test('insertAndGetId returns the new id', async () => {
            const { calls, load } = setupFakeDb(dbType, sendHandler(dbType));
            const { insertAndGetId } = load('config/database.js');

            const id = await insertAndGetId('INSERT INTO messages (chat_id) VALUES (?)', [CHAT_ID]);

            assert.equal(id, NEW_MESSAGE_ID);
            assert.equal(/RETURNING id$/.test(calls[0].sql), dbType === 'postgresql');
        });

        test('POST /api/messages returns the message and emits new_message', async () => {
            const { load } = setupFakeDb(dbType, sendHandler(dbType));
            const { sendMessage } = load('controllers/messageController.js');
            const io = fakeIo();
            const res = fakeRes();

            await sendMessage({
                user: { id: SENDER_ID },
                body: { chatId: CHAT_ID, content: 'hello', messageType: 'text' },
                io
            }, res);

            assert.equal(res.statusCode, 201);
            assert.equal(res.body.data.id, NEW_MESSAGE_ID);

            const pushed = io.emitted.filter(e => e.event === 'new_message');
            assert.equal(pushed.length, 1);
            assert.equal(pushed[0].room, `chat_${CHAT_ID}`);
            assert.equal(pushed[0].data.id, NEW_MESSAGE_ID);

            // The sender's read position moves to exactly this message
            const read = io.emitted.find(e => e.event === 'read_position_updated');
            assert.equal(read.data.lastReadMessageId, NEW_MESSAGE_ID);
        });

        describe('send_message socket event', () => {
            async function sendViaSocket(data) {
                const fake = setupFakeDb(dbType, sendHandler(dbType));
                process.env.PORT = '0';
                stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });

                const log = console.log;
                console.log = () => {};
                const { io } = fake.load('server.js');
                const recorder = fakeIo();
                io.to = recorder.to; // the handler broadcasts through this same io instance

                const handlers = {};
                const socketErrors = [];
                const socket = {
                    id: 'test-socket',
                    userId: SENDER_ID,
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
                return { ...fake, emitted: recorder.emitted, socketErrors };
            }

            test('text message is stored and broadcast', async () => {
                const { emitted, socketErrors } = await sendViaSocket({ chatId: CHAT_ID, messageType: 'text', content: 'hello' });

                assert.deepEqual(socketErrors, []);
                const pushed = emitted.filter(e => e.event === 'new_message');
                assert.equal(pushed.length, 1);
                assert.equal(pushed[0].data.id, NEW_MESSAGE_ID);
            });

            test('file message stores the file id on the message', async () => {
                const { calls, emitted, socketErrors } = await sendViaSocket({
                    chatId: CHAT_ID,
                    messageType: 'file',
                    content: null,
                    fileData: { originalName: 'a.pdf', storedName: 'x.pdf', fileType: '.pdf', fileSize: 1, mimeType: 'application/pdf', uploadPath: 'uploads/x.pdf' }
                });

                assert.deepEqual(socketErrors, []);
                const messageInsert = calls.find(c => /^INSERT INTO messages/.test(c.sql));
                assert.equal(messageInsert.params[4], NEW_FILE_ID);
                assert.equal(emitted.filter(e => e.event === 'new_message').length, 1);
            });
        });
    });
}
