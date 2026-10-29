/**
 * Phase 4 @mentions on both databases: parsing, storing them only for members of group chats
 * (REST send, socket send_message, edits), the unread-mention count behind the sidebar @ badge,
 * the per-chat "mentions only" setting (endpoint, validation, sync) and how mentions route pushes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const ME = 1;
const BOB = 2;
const CAROL = 3;
const OUTSIDER = 4; // a user, but not in the group
const GROUP = 5;
const DIRECT = 6;

const USERS = { [ME]: 'me_user', [BOB]: 'Bob', [CAROL]: 'carol', [OUTSIDER]: 'dave' };

function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        chats: { [GROUP]: { type: 'group', members: [ME, BOB, CAROL] }, [DIRECT]: { type: 'direct', members: [ME, BOB] } },
        messages: {
            40: { id: 40, chat_id: GROUP, sender_id: ME, message_type: 'text', content: 'hi @bob', within_window: 1 }
        },
        mentions: [{ message_id: 40, user_id: BOB }],
        mentionsOnly: {},
        nextId: 100
    };
    const written = () => pg ? [] : { affectedRows: 1 };
    const inserted = (id, sql) => pg ? (/ RETURNING id$/.test(sql) ? [{ id }] : []) : { insertId: id };
    const isMember = (chatId, userId) => !!world.chats[chatId] && world.chats[chatId].members.includes(Number(userId));

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        if (/^SELECT id FROM group_members WHERE chat_id = \? AND user_id = \?/.test(sql)) {
            return isMember(params[0], params[1]) ? [{ id: 1 }] : [];
        }
        // Posting check (utils/groups.js)
        if (/^SELECT gm.id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c ON c.id = gm.chat_id WHERE gm.chat_id = \? AND gm.user_id = \?/.test(sql)) {
            return isMember(params[0], params[1]) ? [{ id: 1, role: 'member', chat_type: world.chats[params[0]].type, announcement_only: false }] : [];
        }

        // resolveMentions
        if (/FROM group_members gm JOIN chats c ON c.id = gm.chat_id AND c.chat_type = 'group' JOIN users u/.test(sql)) {
            world.resolveSql = sql;
            const [chatId, senderId, ...names] = params;
            const chat = world.chats[chatId];
            if (!chat || chat.type !== 'group') return [];
            return chat.members
                .filter(id => id !== Number(senderId) && names.includes(USERS[id].toLowerCase()))
                .map(id => ({ user_id: id, username: USERS[id] }));
        }
        if (/^INSERT INTO message_mentions/.test(sql)) {
            world.mentions.push({ message_id: Number(params[0]), user_id: Number(params[1]) });
            return written();
        }
        if (/^SELECT user_id FROM message_mentions WHERE message_id = \?/.test(sql)) {
            return world.mentions.filter(m => m.message_id === Number(params[0])).map(m => ({ user_id: m.user_id }));
        }
        if (/^DELETE FROM message_mentions WHERE message_id = \? AND user_id = \?/.test(sql)) {
            world.mentions = world.mentions.filter(m => !(m.message_id === Number(params[0]) && m.user_id === Number(params[1])));
            return written();
        }
        if (/^SELECT mm.message_id, mm.user_id, u.username FROM message_mentions mm/.test(sql)) {
            return world.mentions.filter(m => params.map(Number).includes(m.message_id))
                .map(m => ({ message_id: m.message_id, user_id: m.user_id, username: USERS[m.user_id] }));
        }

        // Inserts and the shared message SELECT
        if (/^INSERT INTO messages/.test(sql)) {
            const id = world.nextId++;
            const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c => c.trim());
            const row = { id };
            cols.forEach((col, i) => { row[col] = params[i]; });
            row.chat_id = Number(row.chat_id);
            world.messages[id] = row;
            return inserted(id, sql);
        }
        if (/FROM messages m JOIN users u ON m.sender_id = u.id/.test(sql) && /WHERE m.id = \?/.test(sql)) {
            const m = world.messages[params[0]];
            return m ? [{ ...m, username: USERS[m.sender_id], full_name: null, is_forwarded: 0, reply_to_message_id: null }] : [];
        }

        // Edit
        if (/AS within_window FROM messages m JOIN group_members gm/.test(sql)) {
            const m = world.messages[params[2]];
            if (!m || !isMember(m.chat_id, ME)) return [];
            return [{ ...m, old_content: m.content, is_forwarded: 0, deleted_for_everyone: 0, deleted_for_me: 0, link_preview_id: null, link_preview_dismissed: 0 }];
        }
        if (/^UPDATE messages SET content = \?, edited_at = CURRENT_TIMESTAMP/.test(sql)) {
            world.messages[params[1]].content = params[0];
            return written();
        }
        if (/^SELECT content, edited_at FROM messages WHERE id = \?/.test(sql)) {
            return [{ content: world.messages[params[0]].content, edited_at: new Date() }];
        }

        // Per-chat settings
        if (/^SELECT muted_until, CASE WHEN muted_until IS NOT NULL/.test(sql)) {
            world.settingsSql = sql;
            if (!isMember(params[0], params[1])) return [];
            return [{ muted_until: null, is_muted: 0, archived_at: null, mentions_only: pg ? !!world.mentionsOnly[params[0]] : (world.mentionsOnly[params[0]] ? 1 : 0) }];
        }
        if (/^UPDATE group_members SET mentions_only = \?/.test(sql)) {
            world.mentionsOnly[params[1]] = params[0];
            return written();
        }

        // Bookkeeping
        if (/^SELECT COUNT\(\*\) AS count FROM message_mentions mm/.test(sql)) {
            world.mentionCountParams = params;
            return [{ count: '2' }];
        }
        if (/^UPDATE/.test(sql)) return written();
        if (/^SELECT last_read_message_id FROM group_members/.test(sql)) return [{ last_read_message_id: 0 }];
        if (/^SELECT id FROM messages WHERE id = /.test(sql)) return world.messages[params[0]] ? [{ id: Number(params[0]) }] : [];
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 3 }];

        // Phase 6 block checks: nobody is blocked in these tests

        // Phase 9 tables: no rows = default privacy settings, no message requests
        if (/privacy_settings|message_requests/.test(sql)) return [];
        if (/user_blocks/.test(sql)) return [];

        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

async function call(handler, req) {
    const res = fakeRes();
    const io = fakeIo();
    await handler({ user: { id: ME }, params: {}, query: {}, body: {}, io, ...req }, res);
    return { res, io };
}

describe('extractMentionUsernames', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { extractMentionUsernames, MAX_MENTIONS_PER_MESSAGE } = load('utils/mentions.js');

    test('finds @names, lowercased and de-duplicated', () => {
        assert.deepEqual(extractMentionUsernames('@Bob, @carol and @bob again!'), ['bob', 'carol']);
    });

    test('ignores e-mail addresses, short names and code', () => {
        assert.deepEqual(extractMentionUsernames('mail bob@example.com or @ab'), []);
        assert.deepEqual(extractMentionUsernames('`@bob` and ```\n@carol\n``` but @dave'), ['dave']);
    });

    test('caps the number of mentions per message', () => {
        const text = Array.from({ length: 50 }, (_, i) => `@user${i}`).join(' ');
        assert.equal(extractMentionUsernames(text).length, MAX_MENTIONS_PER_MESSAGE);
    });

    test('no @ means no work', () => {
        assert.deepEqual(extractMentionUsernames('hello'), []);
        assert.deepEqual(extractMentionUsernames(null), []);
    });
});

for (const dbType of ['mysql', 'postgresql']) {
    describe(`mentions (${dbType})`, () => {
        function setup() {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            return { world, ...fake };
        }

        test('REST send stores mentions of group members only and the message carries them', async () => {
            const { world, load } = setup();
            const controller = load('controllers/messageController.js');
            const { res, io } = await call(controller.sendMessage, {
                body: { chatId: GROUP, messageType: 'text', content: 'hey @bob @Carol @dave @me_user' }
            });

            assert.equal(res.statusCode, 201);
            const id = res.body.data.id;
            // dave isn't in the group; the sender can't mention themselves
            assert.deepEqual(world.mentions.filter(m => m.message_id === id).map(m => m.user_id).sort(), [BOB, CAROL]);
            assert.match(world.resolveSql, /LOWER\(u.username\) IN \(\?, \?, \?, \?\)/);
            const pushed = io.emitted.find(e => e.event === 'new_message');
            assert.deepEqual(pushed.data.mentions.map(m => m.user_id).sort(), [BOB, CAROL]);
        });

        test('direct chats have no mentions', async () => {
            const { world, load } = setup();
            const controller = load('controllers/messageController.js');
            const { res } = await call(controller.sendMessage, { body: { chatId: DIRECT, messageType: 'text', content: 'hi @bob' } });

            assert.equal(res.statusCode, 201);
            assert.equal(world.mentions.filter(m => m.message_id === res.body.data.id).length, 0);
            assert.deepEqual(res.body.data.mentions, []);
        });

        test('socket send_message stores mentions too', async () => {
            const { world, load } = setup();
            process.env.PORT = '0';
            stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });
            const log = console.log;
            console.log = () => {};
            const { io } = load('server.js');
            const recorder = fakeIo();
            io.to = recorder.to;

            const handlers = {};
            const socket = { id: 's1', userId: ME, data: {}, join() {}, on(event, fn) { handlers[event] = fn; }, emit() {} };
            try {
                io.sockets.listeners('connection')[0](socket);
                await handlers.send_message({ chatId: GROUP, messageType: 'text', content: 'ping @carol' });
            } finally {
                await new Promise(resolve => io.close(() => resolve()));
                console.log = log;
            }

            const pushed = recorder.emitted.find(e => e.event === 'new_message');
            assert.deepEqual(pushed.data.mentions, [{ user_id: CAROL, username: 'carol' }]);
            assert.ok(world.mentions.some(m => m.message_id === pushed.data.id && m.user_id === CAROL));
        });

        test('editing re-syncs mentions and the edit event carries them', async () => {
            const { world, load } = setup();
            const controller = load('controllers/messageController.js');
            const { res, io } = await call(controller.editMessage, { params: { messageId: 40 }, body: { content: 'actually @carol' } });

            assert.equal(res.statusCode, 200);
            assert.deepEqual(world.mentions.filter(m => m.message_id === 40).map(m => m.user_id), [CAROL]);
            const edited = io.emitted.find(e => e.event === 'message_edited');
            assert.deepEqual(edited.data.mentions, [{ user_id: CAROL, username: 'carol' }]);
        });

        test('the read position reports unread mentions for the @ badge', async () => {
            const { world, load } = setup();
            const { markChatRead } = load('utils/chatState.js');
            const io = fakeIo();
            const state = await markChatRead(io, GROUP, BOB, 40);

            assert.equal(state.unreadMentionCount, 2);
            assert.deepEqual(world.mentionCountParams, [BOB, GROUP]);
            assert.equal(io.emitted.find(e => e.event === 'read_position_updated').data.unreadMentionCount, 2);
        });

        test('the chat list counts unread mentions per chat', async () => {
            let listSql = null;
            let listParams = null;
            const { load } = setupFakeDb(dbType, (sql, params) => {
                listSql = sql.replace(/\$\d+/g, '?');
                listParams = params;
                return [];
            });
            const chatController = load('controllers/chatController.js');
            const { res } = await call(chatController.getUserChats, {});

            assert.equal(res.statusCode, 200);
            assert.match(listSql, /FROM message_mentions mm JOIN messages mmsg ON mmsg.id = mm.message_id WHERE mm.user_id = \?/);
            assert.match(listSql, /AS unread_mention_count/);
            assert.deepEqual(listParams, [ME, ME, ME, ME]);
        });

        test('mentions-only can be switched on by a member and syncs to their tabs', async () => {
            const { world, load } = setup();
            const chatController = load('controllers/chatController.js');
            const { res, io } = await call(chatController.updateMentionsOnly, { params: { chatId: GROUP }, body: { enabled: true } });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.data.mentionsOnly, true);
            assert.equal(world.mentionsOnly[GROUP], true);
            const synced = io.emitted.find(e => e.event === 'chat_settings_updated');
            assert.equal(synced.room, `user_${ME}`);
            assert.equal(synced.data.mentionsOnly, true);
            assert.match(world.settingsSql, /mentions_only/);
        });

        test('mentions-only is refused for a chat the user is not in', async () => {
            const { world, load } = setup();
            const chatController = load('controllers/chatController.js');
            const { res, io } = await call(chatController.updateMentionsOnly, { params: { chatId: 99 }, body: { enabled: true } });

            assert.equal(res.statusCode, 403);
            assert.equal(io.emitted.length, 0);
            assert.equal(world.mentionsOnly[99], undefined);
        });
    });

    describe(`mention push routing (${dbType})`, () => {
        const bool = (v) => dbType === 'mysql' ? (v ? 1 : 0) : !!v;
        // user: is_muted, mentions_only, mentioned?
        const ROWS = [
            { user_id: 10, is_muted: 0, mentions_only: bool(false) },                 // normal: push
            { user_id: 11, is_muted: 1, mentions_only: bool(false) },                 // muted, mentioned: no push
            { user_id: 12, is_muted: 1, mentions_only: bool(true) },                  // muted + mentions only, mentioned: push
            { user_id: 13, is_muted: 0, mentions_only: bool(true) },                  // mentions only, not mentioned: no push
            { user_id: 14, is_muted: 0, mentions_only: bool(true) },                  // mentions only, mentioned: push
            { user_id: 15, is_muted: 1, mentions_only: bool(true) },                  // muted + mentions only, not mentioned: no push
            { user_id: 16, is_muted: 0, mentions_only: bool(false), dnd_enabled: bool(true) } // mentioned but DND: no push
        ];
        const MESSAGE = {
            id: 99, chat_id: GROUP, sender_id: ME, username: 'alice', full_name: 'Alice', message_type: 'text', content: 'hi',
            mentions: [11, 12, 14, 16].map(user_id => ({ user_id, username: `u${user_id}` }))
        };
        const io = { in: () => ({ fetchSockets: async () => [] }) };

        test('chatAllowsPush truth table', () => {
            const { load } = setupFakeDb(dbType, () => []);
            const { chatAllowsPush } = load('utils/push.js');
            assert.equal(chatAllowsPush({ isMuted: false, mentionsOnly: false, mentioned: false }), true);
            assert.equal(chatAllowsPush({ isMuted: true, mentionsOnly: false, mentioned: false }), false);
            assert.equal(chatAllowsPush({ isMuted: true, mentionsOnly: false, mentioned: true }), false);
            assert.equal(chatAllowsPush({ isMuted: false, mentionsOnly: true, mentioned: false }), false);
            assert.equal(chatAllowsPush({ isMuted: false, mentionsOnly: true, mentioned: true }), true);
            assert.equal(chatAllowsPush({ isMuted: true, mentionsOnly: true, mentioned: true }), true);
            assert.equal(chatAllowsPush({ isMuted: true, mentionsOnly: true, mentioned: false }), false);
        });

        test('mentions bypass "mentions only" (and a mute with it), DND still wins', async () => {
            const { load } = setupFakeDb(dbType, (sql) => {
                if (/FROM group_members gm LEFT JOIN notification_settings ns/.test(sql)) return ROWS.map(r => ({ ...r }));
                // Phase 6 block checks: nobody is blocked in these tests
                // Phase 9 tables: no rows = default privacy settings, no message requests
                if (/privacy_settings|message_requests/.test(sql)) return [];
                if (/user_blocks/.test(sql)) return [];
                throw new Error(`Unexpected query: ${sql}`);
            });
            const { findRecipients } = load('utils/push.js');
            assert.deepEqual(await findRecipients(io, MESSAGE), [10, 12, 14]);
        });

        test('a mentioned recipient is told so in the notification', async () => {
            const { load } = setupFakeDb(dbType, (sql, params) => {
                if (/FROM group_members gm LEFT JOIN notification_settings ns/.test(sql)) return ROWS.map(r => ({ ...r }));
                if (/FROM push_subscriptions WHERE user_id IN/.test(sql)) {
                    return params.map(user_id => ({ id: user_id, user_id, endpoint: `https://push.example/${user_id}`, p256dh: 'k', auth: 'a' }));
                }
                if (/^SELECT gm.user_id, COUNT\(m.id\) AS unread/.test(sql)) return [];
                if (/^SELECT chat_type, chat_name FROM chats WHERE id = /.test(sql)) return [{ chat_type: 'group', chat_name: 'Team' }];
                // Phase 6 block checks: nobody is blocked in these tests
                // Phase 9 tables: no rows = default privacy settings, no message requests
                if (/privacy_settings|message_requests/.test(sql)) return [];
                if (/user_blocks/.test(sql)) return [];
                throw new Error(`Unexpected query: ${sql}`);
            });
            const sent = [];
            stubModule('web-push', {
                setVapidDetails() {},
                async sendNotification(subscription, payload) { sent.push(JSON.parse(payload)); }
            });
            process.env.VAPID_PUBLIC_KEY = 'test-public';
            process.env.VAPID_PRIVATE_KEY = 'test-private';
            const push = load('utils/push.js');
            try {
                await push.notifyNewMessage(io, MESSAGE);
            } finally {
                process.env.VAPID_PUBLIC_KEY = '';
                process.env.VAPID_PRIVATE_KEY = '';
            }

            const byUrl = Object.fromEntries(sent.map(p => [p.title, p]));
            assert.equal(sent.length, 3);
            const mentioned = sent.filter(p => p.mentioned);
            assert.equal(mentioned.length, 2);
            assert.ok(mentioned.every(p => p.title === 'Alice mentioned you in Team' && p.body === 'hi'));
            assert.equal(byUrl.Team.body, 'Alice: hi');
            assert.equal(byUrl.Team.mentioned, false);
        });
    });
}

describe('validateMentionsOnly', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { validateMentionsOnly } = load('utils/validation.js');
    const { validationResult } = require('express-validator');

    async function errors(params, body) {
        const req = { params, body, query: {}, headers: {} };
        for (const rule of validateMentionsOnly) await rule.run(req);
        return [...new Set(validationResult(req).array().map(e => e.path))];
    }

    test('accepts a chat id and a boolean', async () => {
        assert.deepEqual(await errors({ chatId: '5' }, { enabled: true }), []);
        assert.deepEqual(await errors({ chatId: '5' }, { enabled: false }), []);
    });

    test('rejects non-booleans and bad chat ids', async () => {
        assert.deepEqual(await errors({ chatId: '5' }, { enabled: 'true' }), ['enabled']);
        assert.deepEqual(await errors({ chatId: '5' }, {}), ['enabled']);
        assert.deepEqual(await errors({ chatId: 'abc' }, { enabled: true }), ['chatId']);
    });
});
