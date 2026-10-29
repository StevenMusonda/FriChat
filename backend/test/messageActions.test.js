/**
 * Phase 3 message actions on both databases: replies (REST and socket), editing
 * (ownership, edit window, deleted/forwarded/media rules), forwarding (membership of
 * source and target chats, file reuse), stars, the starred list and input validation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const ME = 1;
const OTHER = 2;
const MY_CHAT = 5;       // ME is a member
const SECOND_CHAT = 6;   // ME is a member
const FOREIGN_CHAT = 9;  // ME is not a member

function baseMessages() {
    return {
        10: { id: 10, chat_id: MY_CHAT, sender_id: ME, message_type: 'text', content: 'hello', file_id: null, within_window: 1 },
        11: { id: 11, chat_id: MY_CHAT, sender_id: OTHER, message_type: 'text', content: 'hi back', file_id: null, within_window: 1 },
        12: { id: 12, chat_id: MY_CHAT, sender_id: ME, message_type: 'image', content: null, file_id: 77, file_name: 'cat.png', within_window: 1 },
        13: { id: 13, chat_id: MY_CHAT, sender_id: ME, message_type: 'text', content: 'old', file_id: null, within_window: 0 },
        14: { id: 14, chat_id: MY_CHAT, sender_id: ME, message_type: 'text', content: 'gone', file_id: null, within_window: 1, deleted_for_everyone: 1 },
        15: { id: 15, chat_id: MY_CHAT, sender_id: ME, message_type: 'text', content: 'fwd', file_id: null, within_window: 1, is_forwarded: 1 },
        16: { id: 16, chat_id: MY_CHAT, sender_id: ME, message_type: 'image', content: null, file_id: 78, file_name: '.env', within_window: 1 },
        20: { id: 20, chat_id: FOREIGN_CHAT, sender_id: OTHER, message_type: 'text', content: 'secret', file_id: null, within_window: 1 }
    };
}

/**
 * A tiny in-memory database that answers the queries the message action code makes
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        messages: baseMessages(),
        memberships: new Set([MY_CHAT, SECOND_CHAT]),
        stars: new Set(),
        files: {
            77: { id: 77, mime_type: 'image/png', upload_path: path.join('uploads', 'images', 'cat.png') },
            78: { id: 78, mime_type: 'image/png', upload_path: '../../.env' } // written from a client path before the fix
        },
        nextId: 100
    };
    const bool = (v) => pg ? !!v : (v ? 1 : 0);
    const isMember = (chatId) => world.memberships.has(Number(chatId));
    const written = () => pg ? [] : { affectedRows: 1 };
    const inserted = (id, sql) => pg ? (/ RETURNING id$/.test(sql) ? [{ id }] : []) : { insertId: id };

    const fullRow = (m) => {
        const reply = m.reply_to_message_id ? world.messages[m.reply_to_message_id] : null;
        return {
            id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, username: `user${m.sender_id}`, full_name: null,
            message_type: m.message_type, content: m.content, file_id: m.file_id, file_name: m.file_name || null,
            status: 'sent', created_at: new Date(), edited_at: m.edited_at || null,
            is_forwarded: bool(m.is_forwarded), reply_to_message_id: m.reply_to_message_id || null,
            reply_sender_id: reply ? reply.sender_id : null,
            reply_username: reply ? `user${reply.sender_id}` : null,
            reply_full_name: null,
            reply_message_type: reply ? reply.message_type : null,
            reply_content: reply ? reply.content : null,
            reply_file_name: reply ? (reply.file_name || null) : null,
            reply_deleted: reply ? bool(reply.deleted_for_everyone) : null
        };
    };

    world.handler = (rawSql, params) => {
        // Match both drivers with the same patterns ($1, $2 on PostgreSQL)
        const sql = rawSql.replace(/\$\d+/g, '?');

        // Membership checks
        if (/^SELECT id FROM group_members WHERE chat_id = \? AND user_id = \?/.test(sql)) {
            return isMember(params[0]) ? [{ id: 1 }] : [];
        }
        if (/^SELECT chat_id FROM group_members WHERE user_id = \? AND chat_id IN/.test(sql)) {
            return params.slice(1).filter(isMember).map(chat_id => ({ chat_id }));
        }
        // Posting checks (utils/groups.js): send, and forward targets
        if (/^SELECT gm.id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c ON c.id = gm.chat_id WHERE gm.chat_id = \? AND gm.user_id = \?/.test(sql)) {
            return isMember(params[0]) ? [{ id: 1, role: 'member', chat_type: 'group', announcement_only: false }] : [];
        }
        if (/^SELECT gm.chat_id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c ON c.id = gm.chat_id WHERE gm.user_id = \? AND gm.chat_id IN/.test(sql)) {
            return params.slice(1).filter(isMember).map(chat_id => ({ chat_id, role: 'member', chat_type: 'group', announcement_only: false }));
        }

        // Reply target check
        if (/^SELECT id, deleted_for_everyone FROM messages WHERE id = \? AND chat_id = \?/.test(sql)) {
            const m = world.messages[params[0]];
            return m && m.chat_id === Number(params[1]) ? [{ id: m.id, deleted_for_everyone: bool(m.deleted_for_everyone) }] : [];
        }

        // Edit lookup
        if (/AS within_window FROM messages m JOIN group_members gm/.test(sql)) {
            world.editWindowSql = sql;
            const m = world.messages[params[2]];
            if (!m || !isMember(m.chat_id)) return [];
            return [{
                id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, message_type: m.message_type,
                is_forwarded: bool(m.is_forwarded), deleted_for_everyone: bool(m.deleted_for_everyone),
                deleted_for_me: 0, within_window: m.within_window
            }];
        }
        if (/^UPDATE messages SET content = \?, edited_at = CURRENT_TIMESTAMP/.test(sql)) {
            const m = world.messages[params[1]];
            if (m && m.sender_id === params[2]) {
                m.content = params[0];
                m.edited_at = new Date();
            }
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
                .map(m => {
                    const f = m.file_id ? world.files[m.file_id] : null;
                    return {
                        id: m.id, message_type: m.message_type, content: m.content, file_id: m.file_id, deleted_for_everyone: bool(m.deleted_for_everyone),
                        file_row_id: f ? f.id : null, file_mime_type: f ? f.mime_type : null, file_upload_path: f ? f.upload_path : null
                    };
                });
        }

        // Stars
        if (/^SELECT m.id, m.chat_id, m.deleted_for_everyone FROM messages m JOIN group_members gm/.test(sql)) {
            const m = world.messages[params[1]];
            return m && isMember(m.chat_id) ? [{ id: m.id, chat_id: m.chat_id, deleted_for_everyone: bool(m.deleted_for_everyone) }] : [];
        }
        if (/^INSERT INTO starred_messages/.test(sql)) {
            world.starSql = sql;
            world.stars.add(Number(params[1]));
            return written();
        }
        if (/^SELECT m.chat_id FROM starred_messages sm/.test(sql)) {
            return world.stars.has(Number(params[1])) ? [{ chat_id: world.messages[params[1]].chat_id }] : [];
        }
        if (/^DELETE FROM starred_messages/.test(sql)) {
            world.stars.delete(Number(params[1]));
            return written();
        }
        if (/FROM starred_messages sm JOIN messages m/.test(sql)) {
            world.starredListSql = sql;
            world.starredListParams = params;
            return [...world.stars].map(id => ({
                ...fullRow(world.messages[id]), star_id: id, starred_at: new Date(),
                chat_type: 'direct', chat_name: null, direct_partner_name: 'Bob'
            }));
        }

        // Inserts and the shared message SELECT
        if (/^INSERT INTO messages/.test(sql)) {
            const id = world.nextId++;
            const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c => c.trim());
            const row = { id, within_window: 1 };
            let p = 0;
            for (const col of cols) {
                if (col === 'is_forwarded') { row.is_forwarded = 1; continue; } // literal TRUE
                row[col] = params[p++];
            }
            row.chat_id = Number(row.chat_id);
            world.messages[id] = row;
            world.lastInsertSql = sql;
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

        // Phase 6 block checks: nobody is blocked in these tests

        // Phase 9 tables: no rows = default privacy settings, no message requests
        if (/privacy_settings|message_requests/.test(sql)) return [];
        if (/user_blocks/.test(sql)) return [];

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

for (const dbType of ['mysql', 'postgresql']) {
    describe(`message actions (${dbType})`, () => {
        describe('reply', () => {
            test('a reply in the same chat is stored and carries the quoted original', async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.sendMessage, {
                    body: { chatId: MY_CHAT, content: 'agreed', messageType: 'text', replyToMessageId: 11 }
                });

                assert.equal(res.statusCode, 201);
                assert.match(world.lastInsertSql, /reply_to_message_id/);
                const pushed = io.emitted.find(e => e.event === 'new_message');
                assert.deepEqual(pushed.data.reply_to, {
                    id: 11, deleted: false, sender_id: OTHER, sender_name: 'user2',
                    message_type: 'text', snippet: 'hi back', file_name: null
                });
                assert.equal(pushed.data.reply_sender_id, undefined, 'flat reply_* columns are removed');
            });

            test('replying to a message from another chat is rejected', async () => {
                const { controller } = setup(dbType);
                const { res, io } = await call(controller.sendMessage, {
                    body: { chatId: MY_CHAT, content: 'leak?', messageType: 'text', replyToMessageId: 20 }
                });

                assert.equal(res.statusCode, 400);
                assert.equal(io.emitted.length, 0);
            });

            test('replying to a deleted message is rejected', async () => {
                const { controller } = setup(dbType);
                const { res } = await call(controller.sendMessage, {
                    body: { chatId: MY_CHAT, content: 'x', messageType: 'text', replyToMessageId: 14 }
                });
                assert.equal(res.statusCode, 400);
            });

            test('a reply whose original was later deleted shows only a placeholder', () => {
                const { load } = setupFakeDb(dbType, () => []);
                const { shapeMessage } = load('utils/messageQueries.js');
                const shaped = shapeMessage({
                    id: 30, reply_to_message_id: 11, reply_sender_id: OTHER, reply_username: 'bob',
                    reply_message_type: 'text', reply_content: 'secret words', reply_deleted: dbType === 'mysql' ? 1 : true,
                    is_forwarded: 0
                });
                assert.deepEqual(shaped.reply_to, {
                    id: 11, deleted: true, sender_id: null, sender_name: null, message_type: null, snippet: null, file_name: null
                });
            });

            test('media originals give no snippet but keep the type and long text is truncated', () => {
                const { load } = setupFakeDb(dbType, () => []);
                const { shapeMessage } = load('utils/messageQueries.js');
                const media = shapeMessage({ reply_to_message_id: 12, reply_message_type: 'image', reply_file_name: 'cat.png', reply_username: 'me' });
                assert.equal(media.reply_to.snippet, null);
                assert.equal(media.reply_to.message_type, 'image');

                const long = shapeMessage({ reply_to_message_id: 1, reply_message_type: 'text', reply_content: 'a'.repeat(500), reply_username: 'me' });
                assert.equal(long.reply_to.snippet.length, 120);
                assert.ok(long.reply_to.snippet.endsWith('…'));
            });

            test('send_message socket event rejects a reply target from another chat', async () => {
                const { load } = setupFakeDb(dbType, createWorld(dbType).handler);
                process.env.PORT = '0';
                stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });

                const log = console.log;
                console.log = () => {};
                const { io } = load('server.js');
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
                    await handlers.send_message({ chatId: MY_CHAT, messageType: 'text', content: 'x', replyToMessageId: 20 });
                    await handlers.send_message({ chatId: MY_CHAT, messageType: 'text', content: 'x', replyToMessageId: 'abc' });
                    await handlers.send_message({ chatId: MY_CHAT, messageType: 'text', content: 'ok', replyToMessageId: 10 });
                } finally {
                    await new Promise(resolve => io.close(() => resolve()));
                    console.log = log;
                }

                assert.equal(socketErrors.length, 2);
                const pushed = recorder.emitted.filter(e => e.event === 'new_message');
                assert.equal(pushed.length, 1);
                assert.equal(pushed[0].data.reply_to.id, 10);
            });
        });

        describe('edit', () => {
            test('the sender can edit within the window and the chat is told', async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.editMessage, { params: { messageId: 10 }, body: { content: 'hello there' } });

                assert.equal(res.statusCode, 200);
                assert.equal(world.messages[10].content, 'hello there');
                const edited = io.emitted.find(e => e.event === 'message_edited');
                assert.equal(edited.room, `chat_${MY_CHAT}`);
                assert.equal(edited.data.messageId, 10);
                assert.equal(edited.data.content, 'hello there');
                assert.ok(edited.data.editedAt);
            });

            test('the window comes from config and is checked in SQL for this database', async () => {
                const { world, controller } = setup(dbType);
                await call(controller.editMessage, { params: { messageId: 10 }, body: { content: 'x' } });
                const expected = dbType === 'postgresql' ? "INTERVAL '15 minutes'" : 'INTERVAL 15 MINUTE';
                assert.ok(world.editWindowSql.includes(expected), world.editWindowSql);
            });

            const rejected = [
                ['someone else\'s message', 11, 403],
                ['a message older than the window', 13, 400],
                ['a deleted message', 14, 400],
                ['a forwarded message', 15, 400],
                ['a media message', 12, 400],
                ['a message in a chat the user is not in', 20, 404],
                ['a message that does not exist', 999, 404]
            ];
            for (const [label, messageId, status] of rejected) {
                test(`editing ${label} is refused with ${status}`, async () => {
                    const { world, controller } = setup(dbType);
                    const before = world.messages[messageId] && world.messages[messageId].content;
                    const { res, io } = await call(controller.editMessage, { params: { messageId }, body: { content: 'changed' } });

                    assert.equal(res.statusCode, status);
                    assert.equal(io.emitted.length, 0);
                    if (world.messages[messageId]) assert.equal(world.messages[messageId].content, before);
                });
            }
        });

        describe('forward', () => {
            test('copies every message to every target chat, marked forwarded, reusing files', async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.forwardMessages, {
                    body: { messageIds: [12, 10], chatIds: [SECOND_CHAT, MY_CHAT] }
                });

                assert.equal(res.statusCode, 201);
                assert.equal(res.body.data.length, 4);

                // Original order within each chat (10 before 12), file reference reused
                const copies = res.body.data;
                assert.deepEqual(copies.map(m => [m.chat_id, m.message_type]), [
                    [SECOND_CHAT, 'text'], [SECOND_CHAT, 'image'], [MY_CHAT, 'text'], [MY_CHAT, 'image']
                ]);
                assert.ok(copies.every(m => m.is_forwarded === true && m.sender_id === ME));
                assert.equal(copies[1].file_id, 77);
                assert.equal(copies[0].reply_to, null);

                const broadcasts = io.emitted.filter(e => e.event === 'new_message');
                assert.deepEqual(broadcasts.map(e => e.room), [
                    `chat_${SECOND_CHAT}`, `chat_${SECOND_CHAT}`, `chat_${MY_CHAT}`, `chat_${MY_CHAT}`
                ]);
                assert.match(world.lastInsertSql, /is_forwarded/);
            });

            test('a target chat the user is not in is refused and nothing is sent', async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.forwardMessages, {
                    body: { messageIds: [10], chatIds: [SECOND_CHAT, FOREIGN_CHAT] }
                });

                assert.equal(res.statusCode, 404);
                assert.equal(io.emitted.length, 0);
                assert.equal(world.nextId, 100);
            });

            test('a source message from a chat the user is not in is refused', async () => {
                const { controller } = setup(dbType);
                const { res } = await call(controller.forwardMessages, { body: { messageIds: [10, 20], chatIds: [SECOND_CHAT] } });
                assert.equal(res.statusCode, 404);
            });

            test('an attachment whose stored path leaves the uploads folder is not forwarded', async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.forwardMessages, { body: { messageIds: [16], chatIds: [SECOND_CHAT] } });
                assert.equal(res.statusCode, 400);
                assert.equal(io.emitted.length, 0);
                assert.equal(world.nextId, 100);
            });

            test('deleted messages cannot be forwarded', async () => {
                const { controller } = setup(dbType);
                const { res } = await call(controller.forwardMessages, { body: { messageIds: [14], chatIds: [SECOND_CHAT] } });
                assert.equal(res.statusCode, 400);
            });
        });

        describe('stars', () => {
            test('star and unstar update only the user\'s own tabs', async () => {
                const { world, controller } = setup(dbType);

                const starred = await call(controller.starMessage, { params: { messageId: 11 } });
                assert.equal(starred.res.statusCode, 200);
                assert.ok(world.stars.has(11));
                assert.deepEqual(starred.io.emitted, [{
                    room: `user_${ME}`, event: 'message_star_updated', data: { messageId: 11, chatId: MY_CHAT, starred: true }
                }]);
                assert.match(world.starSql, dbType === 'postgresql' ? /ON CONFLICT \(user_id, message_id\) DO NOTHING/ : /ON DUPLICATE KEY UPDATE/);

                const unstarred = await call(controller.unstarMessage, { params: { messageId: 11 } });
                assert.equal(unstarred.res.statusCode, 200);
                assert.ok(!world.stars.has(11));
                assert.equal(unstarred.io.emitted[0].data.starred, false);
            });

            test('messages in chats the user is not in cannot be starred', async () => {
                const { world, controller } = setup(dbType);
                const { res, io } = await call(controller.starMessage, { params: { messageId: 20 } });
                assert.equal(res.statusCode, 404);
                assert.equal(world.stars.size, 0);
                assert.equal(io.emitted.length, 0);
            });

            test('unstarring something that is not starred is a 404', async () => {
                const { controller } = setup(dbType);
                const { res } = await call(controller.unstarMessage, { params: { messageId: 10 } });
                assert.equal(res.statusCode, 404);
            });

            test('the starred list is scoped to the user and names the chat', async () => {
                const { world, controller } = setup(dbType);
                world.stars.add(10);
                world.stars.add(12);

                const { res } = await call(controller.getStarredMessages, { query: { limit: 30 } });

                assert.equal(res.statusCode, 200);
                assert.equal(res.body.data.length, 2);
                assert.ok(res.body.data.every(m => m.is_starred === true && m.chat_display_name === 'Bob'));
                assert.equal(res.body.data[0].direct_partner_name, undefined);
                assert.deepEqual(world.starredListParams, [ME, ME]);
                assert.match(world.starredListSql, /JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = sm.user_id/);
                assert.equal(res.body.pagination.hasMore, false);
            });
        });
    });
}

describe('validation', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { validateEditMessage, validateForward, validateMessage, validateStarredQuery } = load('utils/validation.js');
    const { validationResult } = require('express-validator');

    async function errorsFor(rules, req) {
        const full = { body: {}, params: {}, query: {}, ...req };
        for (const rule of rules) await rule.run(full);
        return [...new Set(validationResult(full).array().map(e => e.path))];
    }

    test('edit needs a numeric id and 1-5000 characters', async () => {
        assert.deepEqual(await errorsFor(validateEditMessage, { params: { messageId: '10' }, body: { content: 'ok' } }), []);
        assert.deepEqual(await errorsFor(validateEditMessage, { params: { messageId: 'abc' }, body: { content: 'ok' } }), ['messageId']);
        assert.deepEqual(await errorsFor(validateEditMessage, { params: { messageId: '10' }, body: { content: '   ' } }), ['content']);
        assert.deepEqual(await errorsFor(validateEditMessage, { params: { messageId: '10' }, body: { content: 'a'.repeat(5001) } }), ['content']);
        assert.deepEqual(await errorsFor(validateEditMessage, { params: { messageId: '10' }, body: { content: { $gt: '' } } }), ['content']);
    });

    test('forward takes 1-5 messages and 1-10 chats, all integer ids', async () => {
        assert.deepEqual(await errorsFor(validateForward, { body: { messageIds: [1, 2], chatIds: [3] } }), []);
        assert.deepEqual(await errorsFor(validateForward, { body: { messageIds: [1, 2, 3, 4, 5, 6], chatIds: [3] } }), ['messageIds']);
        assert.deepEqual(await errorsFor(validateForward, { body: { messageIds: [], chatIds: [3] } }), ['messageIds']);
        assert.deepEqual(await errorsFor(validateForward, { body: { messageIds: [1], chatIds: Array.from({ length: 11 }, (_, i) => i + 1) } }), ['chatIds']);
        assert.deepEqual(await errorsFor(validateForward, { body: { messageIds: ['x'], chatIds: [3] } }), ['messageIds[0]']);
        assert.deepEqual(await errorsFor(validateForward, { body: { messageIds: [1], chatIds: 3 } }), ['chatIds']);
    });

    test('replyToMessageId is optional but must be a positive integer', async () => {
        const base = { chatId: 5, messageType: 'text', content: 'hi' };
        assert.deepEqual(await errorsFor(validateMessage, { body: base }), []);
        assert.deepEqual(await errorsFor(validateMessage, { body: { ...base, replyToMessageId: null } }), []);
        assert.deepEqual(await errorsFor(validateMessage, { body: { ...base, replyToMessageId: 7 } }), []);
        assert.deepEqual(await errorsFor(validateMessage, { body: { ...base, replyToMessageId: -1 } }), ['replyToMessageId']);
        assert.deepEqual(await errorsFor(validateMessage, { body: { ...base, replyToMessageId: '1 OR 1=1' } }), ['replyToMessageId']);
    });

    test('starred list paging parameters are bounded', async () => {
        assert.deepEqual(await errorsFor(validateStarredQuery, { query: {} }), []);
        assert.deepEqual(await errorsFor(validateStarredQuery, { query: { limit: '500' } }), ['limit']);
        assert.deepEqual(await errorsFor(validateStarredQuery, { query: { before: '0' } }), ['before']);
    });
});
