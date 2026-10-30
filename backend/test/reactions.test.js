/**
 * Reactions on both databases, REST and socket: one reaction per user per message.
 * A different emoji replaces it, the same emoji removes it, non-members are refused,
 * and the frontend's live handler shows add/replace/remove correctly to other users.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const ME = 1;
const OTHER = 2;
const MY_CHAT = 5;       // ME is a member
const FOREIGN_CHAT = 9;  // ME is not a member
const MY_MESSAGE = 10;
const FOREIGN_MESSAGE = 20;

/**
 * In-memory message_reactions keyed on (message_id, user_id), like the real unique key
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        messages: { [MY_MESSAGE]: MY_CHAT, [FOREIGN_MESSAGE]: FOREIGN_CHAT },
        members: { [MY_CHAT]: new Set([ME, OTHER]), [FOREIGN_CHAT]: new Set([OTHER]) },
        reactions: new Map(),
        upserts: []
    };
    const key = (messageId, userId) => `${messageId}:${userId}`;
    const written = () => pg ? [] : { affectedRows: 1 };

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        if (/^SELECT m\.id, m\.chat_id FROM messages m JOIN group_members gm ON m\.chat_id = gm\.chat_id WHERE m\.id = \? AND gm\.user_id = \? AND m\.message_type <> 'system'$/.test(sql)) {
            const [messageId, userId] = params;
            const chatId = world.messages[messageId];
            return chatId && world.members[chatId].has(userId) ? [{ id: messageId, chat_id: chatId }] : [];
        }
        if (sql === 'SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?') {
            const emoji = world.reactions.get(key(params[0], params[1]));
            return emoji ? [{ emoji }] : [];
        }
        if (sql === 'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?') {
            const [messageId, userId, emoji] = params;
            if (world.reactions.get(key(messageId, userId)) === emoji) world.reactions.delete(key(messageId, userId));
            return written();
        }
        if (sql === 'UPDATE message_reactions SET emoji = ? WHERE message_id = ? AND user_id = ?') {
            const [emoji, messageId, userId] = params;
            if (world.reactions.has(key(messageId, userId))) world.reactions.set(key(messageId, userId), emoji);
            return written();
        }
        if (/^INSERT INTO message_reactions \(message_id, user_id, emoji\) VALUES \(\?, \?, \?\)/.test(sql)) {
            world.upserts.push(sql);
            // The conflict target must be the real unique key, or PostgreSQL rejects the statement
            const expected = pg
                ? / ON CONFLICT \(message_id, user_id\) DO UPDATE SET emoji = EXCLUDED\.emoji$/
                : / ON DUPLICATE KEY UPDATE emoji = VALUES\(emoji\)$/;
            if (!expected.test(sql)) throw new Error(`unexpected reaction upsert: ${sql}`);
            const [messageId, userId, emoji] = params;
            world.reactions.set(key(messageId, userId), emoji);
            return pg ? [] : { insertId: 1 };
        }
        return [];
    };
    return world;
}

function reactionsOf(world, messageId) {
    return [...world.reactions].filter(([k]) => k.startsWith(`${messageId}:`)).map(([k, emoji]) => ({ userId: Number(k.split(':')[1]), emoji }));
}

/**
 * Drives the REST controller the way the router does (params already validated)
 */
function restPath(dbType) {
    const world = createWorld(dbType);
    const { load } = setupFakeDb(dbType, world.handler);
    const controller = load('controllers/messageController.js');
    const io = fakeIo();

    return {
        world,
        io,
        close: async () => {},
        async react(messageId, emoji, userId = ME) {
            const res = fakeRes();
            await controller.addReaction({ params: { messageId }, body: { emoji }, user: { id: userId, username: `user${userId}` }, io }, res);
            return { status: res.statusCode, body: res.body };
        },
        async remove(messageId, emoji, userId = ME) {
            const res = fakeRes();
            await controller.removeReaction({ params: { messageId }, body: { emoji }, user: { id: userId, username: `user${userId}` }, io }, res);
            return { status: res.statusCode, body: res.body };
        }
    };
}

/**
 * Drives the real server.js socket handlers
 */
function socketPath(dbType) {
    const world = createWorld(dbType);
    const { load } = setupFakeDb(dbType, world.handler);
    process.env.PORT = '0';
    stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });

    const log = console.log;
    console.log = () => {};
    const { io: realIo } = load('server.js');
    const io = fakeIo();
    realIo.to = io.to;

    const sockets = {};
    const errors = [];
    const connect = (userId) => {
        if (sockets[userId]) return sockets[userId];
        const handlers = {};
        const socket = {
            id: `s${userId}`, userId, username: `user${userId}`, data: {}, rooms: new Set(), join() {},
            on(event, fn) { handlers[event] = fn; },
            emit(event, payload) { if (event === 'error') errors.push(payload); }
        };
        realIo.sockets.listeners('connection')[0](socket);
        return (sockets[userId] = handlers);
    };

    return {
        world,
        io,
        errors,
        close: async () => {
            await new Promise(resolve => realIo.close(() => resolve()));
            console.log = log;
        },
        async react(messageId, emoji, userId = ME) {
            await connect(userId).add_reaction({ messageId, emoji });
        },
        async remove(messageId, emoji, userId = ME) {
            await connect(userId).remove_reaction({ messageId, emoji });
        }
    };
}

for (const dbType of ['mysql', 'postgresql']) {
    for (const [pathName, makePath] of [['REST', restPath], ['socket', socketPath]]) {
        describe(`${dbType} ${pathName} reactions`, () => {
            test('add: first reaction is stored and broadcast to the chat', async () => {
                const p = makePath(dbType);
                try {
                    const out = await p.react(MY_MESSAGE, '👍');
                    if (out) {
                        assert.equal(out.status, 200);
                        assert.equal(out.body.data.action, 'added');
                    }
                    assert.deepEqual(reactionsOf(p.world, MY_MESSAGE), [{ userId: ME, emoji: '👍' }]);
                    assert.equal(p.world.upserts.length, 1);
                    assert.deepEqual(p.io.emitted, [{
                        room: `chat_${MY_CHAT}`,
                        event: 'reaction_added',
                        data: { messageId: MY_MESSAGE, userId: ME, username: `user${ME}`, emoji: '👍', previousEmoji: null }
                    }]);
                } finally {
                    await p.close();
                }
            });

            test('replace: a different emoji replaces the user\'s reaction (still one row)', async () => {
                const p = makePath(dbType);
                try {
                    await p.react(MY_MESSAGE, '👍');
                    await p.react(MY_MESSAGE, '❤️');
                    assert.deepEqual(reactionsOf(p.world, MY_MESSAGE), [{ userId: ME, emoji: '❤️' }]);
                    const last = p.io.emitted.at(-1);
                    assert.equal(last.event, 'reaction_added');
                    assert.equal(last.data.emoji, '❤️');
                    assert.equal(last.data.previousEmoji, '👍');
                } finally {
                    await p.close();
                }
            });

            test('toggle-off: the same emoji again removes it', async () => {
                const p = makePath(dbType);
                try {
                    await p.react(MY_MESSAGE, '👍');
                    const out = await p.react(MY_MESSAGE, '👍');
                    if (out) assert.equal(out.body.data.action, 'removed');
                    assert.deepEqual(reactionsOf(p.world, MY_MESSAGE), []);
                    assert.deepEqual(p.io.emitted.at(-1), {
                        room: `chat_${MY_CHAT}`,
                        event: 'reaction_removed',
                        data: { messageId: MY_MESSAGE, userId: ME, emoji: '👍' }
                    });
                } finally {
                    await p.close();
                }
            });

            test('other users\' reactions are untouched', async () => {
                const p = makePath(dbType);
                try {
                    await p.react(MY_MESSAGE, '🎉', OTHER);
                    await p.react(MY_MESSAGE, '👍');
                    await p.react(MY_MESSAGE, '❤️');
                    await p.react(MY_MESSAGE, '❤️');
                    assert.deepEqual(reactionsOf(p.world, MY_MESSAGE), [{ userId: OTHER, emoji: '🎉' }]);
                } finally {
                    await p.close();
                }
            });

            test('remove: only the user\'s current emoji is removed', async () => {
                const p = makePath(dbType);
                try {
                    await p.react(MY_MESSAGE, '👍');
                    await p.remove(MY_MESSAGE, '❤️'); // stale: not the current reaction
                    assert.deepEqual(reactionsOf(p.world, MY_MESSAGE), [{ userId: ME, emoji: '👍' }]);
                    await p.remove(MY_MESSAGE, '👍');
                    assert.deepEqual(reactionsOf(p.world, MY_MESSAGE), []);
                    assert.equal(p.io.emitted.at(-1).event, 'reaction_removed');
                } finally {
                    await p.close();
                }
            });

            test('a non-member is refused and nothing is written or broadcast', async () => {
                const p = makePath(dbType);
                try {
                    const out = await p.react(FOREIGN_MESSAGE, '👍');
                    const outRemove = await p.remove(FOREIGN_MESSAGE, '👍');
                    if (out) {
                        assert.equal(out.status, 404);
                        assert.equal(outRemove.status, 404);
                    } else {
                        assert.deepEqual(p.errors.map(e => e.event), ['add_reaction', 'remove_reaction']);
                    }
                    assert.deepEqual(reactionsOf(p.world, FOREIGN_MESSAGE), []);
                    assert.equal(p.world.upserts.length, 0);
                    assert.deepEqual(p.io.emitted, []);
                } finally {
                    await p.close();
                }
            });

            test('bad input is refused before touching the database', async () => {
                const p = makePath(dbType);
                try {
                    for (const bad of ['', 'x'.repeat(11), 'a b', { $gt: '' }, null]) {
                        const out = await p.react(MY_MESSAGE, bad);
                        if (out) assert.equal(out.status, 400);
                    }
                    const outId = await p.react('abc', '👍');
                    if (outId) assert.equal(outId.status, 400);
                    if (!outId) assert.equal(p.errors.length, 6);
                    assert.equal(p.world.upserts.length, 0);
                    assert.deepEqual(p.io.emitted, []);
                } finally {
                    await p.close();
                }
            });
        });
    }
}

describe('emoji rule', () => {
    // Through the fake driver so loading the module never connects to a real database
    const isValidEmoji = (emoji) => setupFakeDb('mysql', () => []).load('utils/reactions.js').isValidEmoji(emoji);

    test('accepts single and multi-code-point emoji up to 10 characters', () => {
        for (const ok of ['👍', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈']) assert.ok(isValidEmoji(ok), ok);
    });

    test('rejects blanks, whitespace, control characters, non-strings and long input', () => {
        for (const bad of ['', ' ', '👍 ', '\n', '\u0000', 'x'.repeat(11), 42, null, undefined, ['👍']]) {
            assert.ok(!isValidEmoji(bad), JSON.stringify(bad));
        }
    });
});

describe('frontend live reaction handler', () => {
    function loadMessages(messages) {
        const frontend = path.join(__dirname, '..', '..', 'frontend', 'js');
        const rerendered = [];
        const sandbox = {
            console: { log() {}, error() {} },
            getCurrentUser: () => ({ userId: ME }),
            document: { querySelector: () => null }
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.join(frontend, 'messages.js'), 'utf8'), sandbox);
        sandbox.__messages = messages;
        vm.runInContext('currentMessages = __messages; rerenderMessage = (m) => __rerendered.push(m.id);', Object.assign(sandbox, { __rerendered: rerendered }));
        return { sandbox, rerendered };
    }
    const counts = (message) => {
        const byEmoji = {};
        for (const r of message.reactions) byEmoji[r.emoji] = (byEmoji[r.emoji] || 0) + 1;
        return byEmoji;
    };

    test('add, replace and remove from another user keep counts right', () => {
        const message = { id: MY_MESSAGE, reactions: JSON.stringify([{ userId: ME, username: 'me', emoji: '👍' }]) };
        const { sandbox, rerendered } = loadMessages([message]);

        sandbox.handleReactionUpdate({ messageId: MY_MESSAGE, userId: OTHER, username: 'other', emoji: '👍', previousEmoji: null }, 'add');
        assert.deepEqual(counts(message), { '👍': 2 });

        sandbox.handleReactionUpdate({ messageId: MY_MESSAGE, userId: OTHER, username: 'other', emoji: '❤️', previousEmoji: '👍' }, 'add');
        assert.deepEqual(counts(message), { '👍': 1, '❤️': 1 });

        sandbox.handleReactionUpdate({ messageId: MY_MESSAGE, userId: OTHER, emoji: '❤️' }, 'remove');
        assert.deepEqual(counts(message), { '👍': 1 });

        assert.deepEqual(rerendered, [MY_MESSAGE, MY_MESSAGE, MY_MESSAGE]);
    });

    test('an update for a message not on screen is ignored', () => {
        const { sandbox, rerendered } = loadMessages([]);
        sandbox.handleReactionUpdate({ messageId: 999, userId: OTHER, username: 'other', emoji: '👍' }, 'add');
        assert.deepEqual(rerendered, []);
    });
});
