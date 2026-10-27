/**
 * Cleanup before phase 4: one text rule for message content (stored raw on every path,
 * escaped only when the frontend renders it), the legacy un-escape script, live
 * "delete for everyone", socket error events and 401-only logout.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const jwt = require('jsonwebtoken');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const ME = 1;
const OTHER = 2;
const MY_CHAT = 5;
const SECOND_CHAT = 6;
const FOREIGN_CHAT = 9;

const SCRIPT_PAYLOAD = '<script>alert(1)</script>';
const IMG_PAYLOAD = '<img src=x onerror="alert(\'xss\')">';
const PAYLOADS = [SCRIPT_PAYLOAD, IMG_PAYLOAD];

/**
 * Small in-memory database for the send / edit / forward / delete queries
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const bool = (v) => pg ? !!v : (v ? 1 : 0);
    const written = () => pg ? [] : { affectedRows: 1 };
    const inserted = (id, sql) => pg ? (/ RETURNING id$/.test(sql) ? [{ id }] : []) : { insertId: id };
    const world = {
        messages: {
            10: { id: 10, chat_id: MY_CHAT, sender_id: ME, message_type: 'text', content: 'hello', created_at: new Date() },
            11: { id: 11, chat_id: MY_CHAT, sender_id: OTHER, message_type: 'text', content: 'hi', created_at: new Date() },
            20: { id: 20, chat_id: FOREIGN_CHAT, sender_id: ME, message_type: 'text', content: 'left', created_at: new Date() }
        },
        memberships: new Set([MY_CHAT, SECOND_CHAT]),
        nextId: 100
    };
    const isMember = (chatId) => world.memberships.has(Number(chatId));

    const fullRow = (m) => ({
        id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, username: `user${m.sender_id}`, full_name: null,
        message_type: m.message_type, content: m.content, file_id: m.file_id || null, status: 'sent',
        created_at: m.created_at, edited_at: m.edited_at || null, is_forwarded: bool(m.is_forwarded),
        reply_to_message_id: null
    });

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        if (/^SELECT id FROM group_members WHERE chat_id = \? AND user_id = \?/.test(sql)) return isMember(params[0]) ? [{ id: 1 }] : [];
        if (/^SELECT chat_id FROM group_members WHERE user_id = \? AND chat_id IN/.test(sql)) {
            return params.slice(1).filter(isMember).map(chat_id => ({ chat_id }));
        }

        // Edit
        if (/AS within_window FROM messages m JOIN group_members gm/.test(sql)) {
            const m = world.messages[params[2]];
            if (!m || !isMember(m.chat_id)) return [];
            return [{ id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, message_type: m.message_type,
                is_forwarded: bool(m.is_forwarded), deleted_for_everyone: bool(m.deleted_for_everyone), deleted_for_me: 0, within_window: 1 }];
        }
        if (/^UPDATE messages SET content = \?, edited_at = CURRENT_TIMESTAMP/.test(sql)) {
            const m = world.messages[params[1]];
            if (m && m.sender_id === params[2]) { m.content = params[0]; m.edited_at = new Date(); }
            return written();
        }
        if (/^SELECT content, edited_at FROM messages WHERE id = \?/.test(sql)) {
            const m = world.messages[params[0]];
            return m ? [{ content: m.content, edited_at: m.edited_at }] : [];
        }

        // Forward
        if (/^SELECT m.id, m.message_type, m.content, m.file_id, m.deleted_for_everyone, f.id AS file_row_id, f.mime_type AS file_mime_type, f.upload_path AS file_upload_path FROM messages m JOIN group_members gm/.test(sql)) {
            return params.slice(2).map(id => world.messages[id])
                .filter(m => m && isMember(m.chat_id))
                .map(m => ({ id: m.id, message_type: m.message_type, content: m.content, file_id: m.file_id || null, deleted_for_everyone: bool(m.deleted_for_everyone) }));
        }

        // Delete
        if (/^SELECT \* FROM messages WHERE id = \?/.test(sql)) {
            const m = world.messages[params[0]];
            return m ? [{ ...m }] : [];
        }
        if (/^UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = \?, deleted_for_everyone = TRUE WHERE id = \?/.test(sql)) {
            world.messages[params[1]].deleted_for_everyone = true;
            return written();
        }
        if (/^INSERT INTO deleted_messages/.test(sql)) {
            world.deletedForMe = Number(params[0]);
            return written();
        }

        // Inserts and the shared message SELECT
        if (/^INSERT INTO messages/.test(sql)) {
            const id = world.nextId++;
            const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c => c.trim());
            const row = { id, created_at: new Date() };
            let p = 0;
            for (const col of cols) {
                if (col === 'is_forwarded') { row.is_forwarded = true; continue; }
                row[col] = params[p++];
            }
            row.chat_id = Number(row.chat_id);
            world.messages[id] = row;
            return inserted(id, sql);
        }
        if (/FROM messages m JOIN users u ON m.sender_id = u.id/.test(sql) && /WHERE m.id = \?/.test(sql)) {
            const m = world.messages[params[0]];
            return m ? [fullRow(m)] : [];
        }

        // recordNewMessage / markChatRead bookkeeping
        if (/^UPDATE/.test(sql)) return written();
        if (/^SELECT last_read_message_id FROM group_members/.test(sql)) return [{ last_read_message_id: 0 }];
        if (/^SELECT id FROM messages WHERE id = /.test(sql)) return world.messages[params[0]] ? [{ id: Number(params[0]) }] : [];
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 0 }];

        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

function setup(dbType) {
    const world = createWorld(dbType);
    const fake = setupFakeDb(dbType, world.handler);
    return { world, ...fake, controller: fake.load('controllers/messageController.js') };
}

async function call(handler, req) {
    const res = fakeRes();
    const io = fakeIo();
    await handler({ user: { id: ME }, params: {}, query: {}, body: {}, io, ...req }, res);
    return { res, io };
}

/**
 * Run socket handlers against the real server.js connection handler
 */
async function withSocket(dbType, world, fn) {
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
        id: 's1', userId: ME, data: {}, join() {},
        on(event, fn) { handlers[event] = fn; },
        emit(event, payload) { if (event === 'error') socketErrors.push(payload); }
    };

    try {
        io.sockets.listeners('connection')[0](socket);
        await fn(handlers);
    } finally {
        await new Promise(resolve => io.close(() => resolve()));
        console.log = log;
    }
    return { emitted: recorder.emitted, socketErrors };
}

/**
 * The frontend render helpers, loaded from the real files into a sandbox
 * (escapeHtml from chat.js, message rendering from messages.js)
 */
function loadFrontendRenderer() {
    const frontend = path.join(__dirname, '..', '..', 'frontend', 'js');
    const chatJs = fs.readFileSync(path.join(frontend, 'chat.js'), 'utf8');
    const escapeSource = chatJs.match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/)[0];

    const sandbox = {
        console: { log() {}, error() {} },
        getCurrentUser: () => ({ userId: ME }),
        formatTime: () => '12:00',
        FORWARD_ICON_SVG: '',
        CONFIG: { SOCKET_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000/api' }
    };
    vm.createContext(sandbox);
    vm.runInContext(escapeSource, sandbox);
    vm.runInContext(fs.readFileSync(path.join(frontend, 'messages.js'), 'utf8'), sandbox);
    return sandbox;
}

// No executable markup survives: no tags, and quotes can't close an attribute
function assertInert(html, payload) {
    assert.ok(!/<script/i.test(html), `script tag in: ${html}`);
    assert.ok(!/<img[^>]*onerror/i.test(html), `img onerror in: ${html}`);
    assert.ok(!html.includes(payload), 'payload rendered verbatim');
}

describe('cleanMessageText', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { cleanMessageText, stripControlChars } = load('utils/messageText.js');

    test('keeps HTML exactly as typed (no escaping on write)', () => {
        for (const payload of PAYLOADS) {
            assert.deepEqual(cleanMessageText(payload, { required: true }), { ok: true, text: payload });
        }
        assert.equal(cleanMessageText('Tom & Jerry 1/2 "quoted"').text, 'Tom & Jerry 1/2 "quoted"');
    });

    test('strips control characters, normalizes line endings and trims', () => {
        assert.equal(cleanMessageText('  a\u0000b\u0007c\u001B[31m\u007F\u0085d\r\ne\rf\tg  ').text, 'abc[31md\ne\nf\tg');
        assert.equal(stripControlChars('x\u0008y'), 'xy');
    });

    test('enforces type, emptiness and length', () => {
        assert.equal(cleanMessageText({ $gt: '' }).ok, false);
        assert.equal(cleanMessageText(42).ok, false);
        assert.equal(cleanMessageText('   ', { required: true }).ok, false);
        assert.equal(cleanMessageText('\u0000\u0001', { required: true }).ok, false);
        assert.deepEqual(cleanMessageText(null), { ok: true, text: null });
        assert.deepEqual(cleanMessageText('  '), { ok: true, text: null });
        assert.equal(cleanMessageText('a'.repeat(5000)).ok, true);
        assert.equal(cleanMessageText('a'.repeat(5001)).ok, false);
    });
});

for (const dbType of ['mysql', 'postgresql']) {
    describe(`XSS payloads are stored raw on every write path (${dbType})`, () => {
        for (const payload of PAYLOADS) {
            test(`REST send: ${payload}`, async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.sendMessage, {
                    body: { chatId: MY_CHAT, content: `  ${payload}\u0000 `, messageType: 'text' }
                });

                assert.equal(res.statusCode, 201);
                assert.equal(world.messages[res.body.data.id].content, payload);
                assert.equal(io.emitted.find(e => e.event === 'new_message').data.content, payload);
            });

            test(`socket send_message: ${payload}`, async () => {
                const world = createWorld(dbType);
                const { emitted, socketErrors } = await withSocket(dbType, world, async (handlers) => {
                    await handlers.send_message({ chatId: MY_CHAT, messageType: 'text', content: `${payload}\u0007` });
                });

                assert.deepEqual(socketErrors, []);
                const pushed = emitted.find(e => e.event === 'new_message');
                assert.equal(pushed.data.content, payload);
                assert.equal(world.messages[pushed.data.id].content, payload);
            });

            test(`edit: ${payload}`, async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.editMessage, { params: { messageId: 10 }, body: { content: payload } });

                assert.equal(res.statusCode, 200);
                assert.equal(world.messages[10].content, payload);
                assert.equal(io.emitted.find(e => e.event === 'message_edited').data.content, payload);
            });

            test(`forward: ${payload}`, async () => {
                const { world, controller } = setup(dbType);
                world.messages[11].content = payload;
                const { res } = await call(controller.forwardMessages, { body: { messageIds: [11], chatIds: [SECOND_CHAT] } });

                assert.equal(res.statusCode, 201);
                assert.equal(res.body.data[0].content, payload);
                assert.equal(world.messages[res.body.data[0].id].content, payload);
            });
        }

        test('empty or non-string text is refused on REST, edit and socket', async () => {
            const { controller } = setup(dbType);
            const sent = await call(controller.sendMessage, { body: { chatId: MY_CHAT, content: '\u0000 ', messageType: 'text' } });
            assert.equal(sent.res.statusCode, 400);
            const edited = await call(controller.editMessage, { params: { messageId: 10 }, body: { content: ['x'] } });
            assert.equal(edited.res.statusCode, 400);

            const { emitted, socketErrors } = await withSocket(dbType, createWorld(dbType), async (handlers) => {
                await handlers.send_message({ chatId: MY_CHAT, messageType: 'text', content: '   ' });
                await handlers.send_message({ chatId: MY_CHAT, messageType: 'text', content: 'a'.repeat(5001) });
                await handlers.send_message({ chatId: MY_CHAT, messageType: 'sticker', content: 'x' });
                await handlers.send_message(null);
            });
            assert.equal(emitted.filter(e => e.event === 'new_message').length, 0);
            assert.equal(socketErrors.length, 4);
            assert.ok(socketErrors.every(e => e.event === 'send_message' && typeof e.message === 'string'));
        });

        test('socket errors name the event so the client can show them', async () => {
            const { socketErrors } = await withSocket(dbType, createWorld(dbType), async (handlers) => {
                await handlers.send_message({ chatId: FOREIGN_CHAT, messageType: 'text', content: 'x' });
            });
            assert.deepEqual(socketErrors, [{ event: 'send_message', message: 'Access denied' }]);
        });
    });

    describe(`delete for everyone is broadcast (${dbType})`, () => {
        test('the chat room gets message_deleted', async () => {
            const { world, controller } = setup(dbType);
            const { res, io } = await call(controller.deleteMessage, { params: { messageId: 10 } });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.deletedForEveryone, true);
            assert.ok(world.messages[10].deleted_for_everyone);
            assert.deepEqual(io.emitted, [{
                room: `chat_${MY_CHAT}`, event: 'message_deleted',
                data: { messageId: 10, chatId: MY_CHAT, deletedForEveryone: true }
            }]);
        });

        test('delete for me is not broadcast', async () => {
            const { world, controller } = setup(dbType);
            world.messages[10].created_at = new Date(Date.now() - 5 * 60 * 1000);
            const { res, io } = await call(controller.deleteMessage, { params: { messageId: 10 } });

            assert.equal(res.body.deletedForEveryone, false);
            assert.equal(world.deletedForMe, 10);
            assert.equal(io.emitted.length, 0);
        });

        test('someone else\'s message, or a chat the user left, is refused without a broadcast', async () => {
            const { world, controller } = setup(dbType);
            const notMine = await call(controller.deleteMessage, { params: { messageId: 11 } });
            assert.equal(notMine.res.statusCode, 403);
            assert.equal(notMine.io.emitted.length, 0);

            const leftChat = await call(controller.deleteMessage, { params: { messageId: 20 } });
            assert.equal(leftChat.res.statusCode, 404);
            assert.equal(leftChat.io.emitted.length, 0);
            assert.ok(!world.messages[20].deleted_for_everyone);
        });
    });
}

describe('frontend renders stored payloads as plain text', () => {
    const r = loadFrontendRenderer();

    test('escapeHtml escapes markup and both quote types', () => {
        assert.equal(r.escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
        assert.equal(r.escapeHtml(null), '');
        assert.equal(r.escapeHtml(0), '0');
    });

    for (const payload of PAYLOADS) {
        test(`message body, reply quote, file name and reactions: ${payload}`, () => {
            const body = r.renderMessageContent({ id: 1, message_type: 'text', content: payload });
            assertInert(body, payload);
            assert.ok(body.includes(r.escapeHtml(payload)));

            const quote = r.renderReplyQuote({ id: 2, deleted: false, sender_name: payload, message_type: 'text', snippet: payload });
            assertInert(quote, payload);

            const file = r.renderMessageContent({ id: 3, message_type: 'file', file_name: `x" onerror="alert(1)${payload}`, upload_path: 'uploads/files/x' });
            assertInert(file, payload);
            assert.ok(!file.includes('x" onerror'), 'attribute breakout');

            const full = r.renderMessageHtml({
                id: 4, sender_id: OTHER, username: payload, message_type: 'text', content: payload, created_at: new Date(),
                reactions: [{ userId: OTHER, username: payload, emoji: payload }],
                reply_to: { id: 2, deleted: false, sender_name: payload, message_type: 'text', snippet: payload }
            });
            assertInert(full, payload);
        });
    }
});

describe('legacy un-escape script', () => {
    const { looksLegacyEscaped, unescapeLegacyHtml, parseArgs } = require('../scripts/unescape-legacy-messages');

    // What the old REST path stored
    const sanitizeHtml = (text) => text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;');

    test('exactly reverses sanitizeHtml', () => {
        for (const original of [...PAYLOADS, `Tom & Jerry's "1/2" <3`, 'I typed &lt; myself', 'a && b']) {
            const stored = sanitizeHtml(original);
            assert.ok(looksLegacyEscaped(stored), stored);
            assert.equal(unescapeLegacyHtml(stored), original);
        }
    });

    test('leaves raw text alone', () => {
        for (const raw of ['hello', 'Tom & Jerry', '<b>hi</b>', 'see https://x.test/a&amp;b', 'it\'s &amp;', 'a &copy; b', '&amp']) {
            assert.equal(looksLegacyEscaped(raw), false, raw);
        }
        assert.equal(looksLegacyEscaped(null), false);
    });

    test('running twice is NOT safe for text that was itself entity-like (documented risk)', () => {
        const once = unescapeLegacyHtml(sanitizeHtml('&lt;b&gt;'));
        assert.equal(once, '&lt;b&gt;');
        assert.equal(looksLegacyEscaped(once), true);
        assert.equal(unescapeLegacyHtml(once), '<b>');
    });

    test('arguments: dry run by default, --before required by main()', () => {
        assert.deepEqual(parseArgs(['--before', '2026-10-26']), { apply: false, chatNames: false, before: '2026-10-26' });
        assert.deepEqual(parseArgs(['--before=2026-10-26', '--apply', '--chat-names']), { apply: true, chatNames: true, before: '2026-10-26' });
        assert.throws(() => parseArgs(['--yes']));
    });
});

describe('auth middleware: bad tokens are 401 so the frontend logs out only then', () => {
    async function authenticate(dbType, token, users = []) {
        process.env.JWT_SECRET = 'test-secret';
        const { load } = setupFakeDb(dbType, () => users);
        const { authenticateToken } = load('middleware/auth.js');
        const res = fakeRes();
        return new Promise(resolve => {
            const done = () => resolve({ res, nextCalled: res.body === undefined });
            const json = res.json.bind(res);
            res.json = (body) => { json(body); done(); return res; };
            authenticateToken({ headers: token ? { authorization: `Bearer ${token}` } : {} }, res, done);
        });
    }

    for (const dbType of ['mysql', 'postgresql']) {
        test(`missing, invalid, expired and orphaned tokens (${dbType})`, async () => {
            assert.equal((await authenticate(dbType, null)).res.statusCode, 401);
            assert.equal((await authenticate(dbType, 'not-a-jwt')).res.statusCode, 401);

            const expired = jwt.sign({ userId: ME, exp: Math.floor(Date.now() / 1000) - 60 }, 'test-secret');
            assert.equal((await authenticate(dbType, expired)).res.statusCode, 401);

            const valid = jwt.sign({ userId: ME }, 'test-secret');
            assert.equal((await authenticate(dbType, valid, [])).res.statusCode, 401);

            const ok = await authenticate(dbType, valid, [{ id: ME, username: 'me' }]);
            assert.equal(ok.nextCalled, true);
        });
    }
});

describe('frontend apiRequest logs out on 401 only', () => {
    async function request(status, withToken = true) {
        const authJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'auth.js'), 'utf8');
        const state = { loggedOut: false, href: 'chat.html' };
        const sandbox = {
            console: { log() {}, error() {} },
            CONFIG: { API_BASE_URL: '', STORAGE_KEYS: { AUTH_TOKEN: 't' } },
            localStorage: { getItem: () => (withToken ? 'token' : null), removeItem() {}, setItem() {} },
            window: { location: state },
            fetch: async () => ({ status, json: async () => ({ success: false, message: `status ${status}` }) })
        };
        vm.createContext(sandbox);
        vm.runInContext(authJs, sandbox);
        sandbox.logout = async () => { state.loggedOut = true; };

        let result;
        let error;
        try {
            result = await sandbox.apiRequest('/x');
        } catch (e) {
            error = e;
        }
        return { result, error, loggedOut: state.loggedOut };
    }

    test('403 is returned to the caller and keeps the session', async () => {
        const { result, loggedOut } = await request(403);
        assert.equal(loggedOut, false);
        assert.equal(result.message, 'status 403');
    });

    test('401 with a token logs out', async () => {
        const { error, loggedOut } = await request(401);
        assert.equal(loggedOut, true);
        assert.ok(error);
    });

    test('401 without a token (wrong password on the login page) does not', async () => {
        const { result, loggedOut } = await request(401, false);
        assert.equal(loggedOut, false);
        assert.equal(result.success, false);
    });
});
