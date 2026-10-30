/**
 * Phase 9 on both fake drivers: privacy settings are enforced on the server (API responses and
 * socket broadcasts never carry a hidden avatar, presence, last seen, bio or custom status), read
 * receipts and typing switches, "who can add me to groups", message requests (Requests section,
 * no replies/receipts/typing until accepted, accept/delete/block) and profile photos that are always
 * re-encoded, so an upload can never be served as executable content.
 *
 * The fake database keeps users, privacy settings, chats, memberships, blocks and requests in memory
 * and answers the queries the real code sends.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupFakeDb, fakeRes } = require('./helpers/fakeDb');

const ALICE = 1; // the subject whose privacy is tested
const BOB = 2; // shares a chat with Alice (a contact)
const EVE = 3; // shares nothing with Alice
const MALLORY = 4; // blocked by Alice

const DIRECT_AB = 10; // Alice + Bob, accepted
const GROUP = 11; // Alice, Bob, Mallory
const REQUEST_EA = 12; // Eve -> Alice, pending message request

const SECRET_AVATAR = 'uploads/avatars/0123456789abcdef0123456789abcdef.webp';
const SECRET_BIO = 'secret-bio-text';
const SECRET_STATUS = 'secret-status-text';
const SECRET_LAST_SEEN = '2026-10-28T09:15:00.000Z';

/**
 * Emits recorded per room, with Socket.IO's to()/except()/broadcast chaining
 */
function recordingIo() {
    const emitted = [];
    const operator = (rooms, except, broadcast) => ({
        to(room) { return operator([...rooms, ...[].concat(room)], except, broadcast); },
        except(room) { return operator(rooms, [...except, ...[].concat(room)], broadcast); },
        emit(event, data) { emitted.push({ rooms, except, broadcast, event, data }); }
    });
    return {
        emitted,
        to: (room) => operator([].concat(room), [], false),
        except: (room) => operator([], [].concat(room), true),
        broadcast: operator([], [], true),
        sockets: { adapter: { rooms: new Map() } },
        in: () => ({ fetchSockets: async () => [] })
    };
}

/**
 * Rooms an event reaches for a list of users (broadcast = every user not excepted)
 */
function reached(entry, userIds) {
    return userIds.filter(id => {
        const room = `user_${id}`;
        if (entry.except.includes(room)) return false;
        return entry.broadcast || entry.rooms.includes(room);
    });
}

function createWorld(dbType, privacyOverrides = {}) {
    const pg = dbType === 'postgresql';
    const world = {
        pg,
        users: {
            [ALICE]: { id: ALICE, username: 'alice', full_name: 'Alice', avatar_url: SECRET_AVATAR, bio: SECRET_BIO, status: 'online', last_seen: SECRET_LAST_SEEN, custom_status_text: SECRET_STATUS, custom_status_emoji: '🎉', status_expires_in: 3600 },
            [BOB]: { id: BOB, username: 'bob', full_name: 'Bob', avatar_url: null, bio: null, status: 'online', last_seen: null, custom_status_text: null, custom_status_emoji: null, status_expires_in: null },
            [EVE]: { id: EVE, username: 'eve', full_name: 'Eve', avatar_url: null, bio: null, status: 'offline', last_seen: null, custom_status_text: null, custom_status_emoji: null, status_expires_in: null },
            [MALLORY]: { id: MALLORY, username: 'mallory', full_name: 'Mallory', avatar_url: null, bio: null, status: 'offline', last_seen: null, custom_status_text: null, custom_status_emoji: null, status_expires_in: null }
        },
        privacy: { [ALICE]: { ...privacyOverrides } },
        chats: {
            [DIRECT_AB]: { id: DIRECT_AB, chat_type: 'direct', chat_name: null },
            [GROUP]: { id: GROUP, chat_type: 'group', chat_name: 'Team', announcement_only: false },
            [REQUEST_EA]: { id: REQUEST_EA, chat_type: 'direct', chat_name: null }
        },
        members: [
            { chat_id: DIRECT_AB, user_id: ALICE, role: 'member', last_read: 0 },
            { chat_id: DIRECT_AB, user_id: BOB, role: 'member', last_read: 0 },
            { chat_id: GROUP, user_id: ALICE, role: 'admin', last_read: 0 },
            { chat_id: GROUP, user_id: BOB, role: 'member', last_read: 0 },
            { chat_id: GROUP, user_id: MALLORY, role: 'member', last_read: 0 },
            { chat_id: REQUEST_EA, user_id: EVE, role: 'member', last_read: 0 },
            { chat_id: REQUEST_EA, user_id: ALICE, role: 'member', last_read: 0 }
        ],
        blocks: [{ blocker_id: ALICE, blocked_id: MALLORY }],
        requests: { [REQUEST_EA]: { chat_id: REQUEST_EA, requester_id: EVE, recipient_id: ALICE, status: 'pending' } },
        messages: {
            100: { id: 100, chat_id: REQUEST_EA, sender_id: EVE, status: 'sent' },
            101: { id: 101, chat_id: DIRECT_AB, sender_id: BOB, status: 'sent' },
            102: { id: 102, chat_id: DIRECT_AB, sender_id: ALICE, status: 'sent' }
        },
        deletedChats: [],
        inserted: [],
        statusUpdates: []
    };

    const written = (n) => (pg ? Array.from({ length: n }, () => ({ chat_id: 1 })) : { affectedRows: n });
    const isMember = (chatId, userId) => world.members.some(m => m.chat_id === Number(chatId) && m.user_id === Number(userId));
    const unaccepted = (chatId) => world.requests[chatId] && world.requests[chatId].status !== 'accepted';
    const settingsRow = (userId) => {
        const p = world.privacy[userId];
        if (!p) return null;
        return {
            user_id: userId,
            last_seen_audience: p.lastSeen || 'everyone',
            photo_audience: p.photo || 'everyone',
            bio_audience: p.bio || 'everyone',
            groups_audience: p.groups || 'everyone',
            read_receipts: p.readReceipts === false ? (pg ? false : 0) : (pg ? true : 1),
            typing_indicators: p.typingIndicators === false ? (pg ? false : 0) : (pg ? true : 1)
        };
    };
    const contactsOf = (userId) => {
        const ids = new Set();
        for (const mine of world.members.filter(m => m.user_id === Number(userId))) {
            if (unaccepted(mine.chat_id)) continue;
            for (const other of world.members.filter(m => m.chat_id === mine.chat_id && m.user_id !== Number(userId))) ids.add(other.user_id);
        }
        return [...ids];
    };

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        // --- privacy ---
        // Phase 12 birthdays (utils/birthdays.js): nobody here has one set
        if (/birthday/.test(sql)) return [];
        if (/FROM users u LEFT JOIN privacy_settings ps ON ps.user_id = u.id WHERE u.id IN/.test(sql)) {
            return params.map(Number).filter(id => world.users[id]).map(id => ({ ...world.users[id], ...(settingsRow(id) || {}) }));
        }
        if (/^SELECT last_seen_audience, photo_audience, bio_audience, groups_audience, read_receipts, typing_indicators FROM privacy_settings WHERE user_id = \?$/.test(sql)) {
            const row = settingsRow(Number(params[0]));
            return row ? [row] : [];
        }
        if (/^SELECT user_id, groups_audience FROM privacy_settings WHERE user_id IN/.test(sql)) {
            return params.map(Number).map(settingsRow).filter(Boolean);
        }
        if (/JOIN privacy_settings ps ON ps.user_id = gm.user_id WHERE gm.chat_id = \? AND ps.read_receipts = FALSE/.test(sql)) {
            return world.members.filter(m => m.chat_id === Number(params[0]) && world.privacy[m.user_id] && world.privacy[m.user_id].readReceipts === false)
                .map(m => ({ user_id: m.user_id }));
        }
        if (/^INSERT INTO privacy_settings/.test(sql)) {
            const [userId, lastSeen, photo, bio, groups, readReceipts, typingIndicators] = params;
            world.privacy[userId] = { lastSeen, photo, bio, groups, readReceipts, typingIndicators };
            return written(1);
        }
        if (/^SELECT DISTINCT other.user_id FROM group_members mine/.test(sql)) {
            return contactsOf(params[0]).map(id => ({ user_id: id }));
        }
        if (/^SELECT mine.chat_id FROM group_members mine .* AND other.user_id = \? AND mr.chat_id IS NULL LIMIT 1$/.test(sql)) {
            return contactsOf(params[0]).includes(Number(params[1])) ? [{ chat_id: 1 }] : [];
        }

        // --- blocks ---
        if (/^SELECT blocker_id FROM user_blocks WHERE blocked_id = \?$/.test(sql)) {
            return world.blocks.filter(b => b.blocked_id === Number(params[0])).map(b => ({ blocker_id: b.blocker_id }));
        }
        if (/^SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = \? OR blocked_id = \?$/.test(sql)) {
            return world.blocks.filter(b => b.blocker_id === Number(params[0]) || b.blocked_id === Number(params[0]));
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE blocked_id = \? AND blocker_id IN/.test(sql)) {
            return world.blocks.filter(b => b.blocked_id === Number(params[0]) && params.slice(1).map(Number).includes(b.blocker_id));
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE \(blocker_id = \? AND blocked_id = \?\)/.test(sql)) {
            const [a, b] = params.map(Number);
            return world.blocks.filter(x => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
        }
        if (/JOIN user_blocks ub ON/.test(sql)) return [];
        if (/^INSERT INTO user_blocks/.test(sql)) {
            world.blocks.push({ blocker_id: Number(params[0]), blocked_id: Number(params[1]) });
            return written(1);
        }

        // --- message requests ---
        if (/^SELECT chat_id, requester_id, recipient_id, status FROM message_requests WHERE chat_id = \?$/.test(sql)) {
            const r = world.requests[params[0]];
            return r ? [{ ...r }] : [];
        }
        if (/^SELECT chat_id, requester_id, recipient_id, status FROM message_requests WHERE status = \? AND chat_id IN/.test(sql)) {
            return params.slice(1).map(Number).map(id => world.requests[id]).filter(r => r && r.status === params[0]);
        }
        if (/^SELECT chat_id FROM message_requests WHERE chat_id = \? AND recipient_id = \? AND status IN/.test(sql)) {
            const r = world.requests[params[0]];
            return r && r.recipient_id === Number(params[1]) && params.slice(2).includes(r.status) ? [{ chat_id: r.chat_id }] : [];
        }
        if (/^INSERT INTO message_requests/.test(sql)) {
            world.requests[params[0]] = { chat_id: params[0], requester_id: params[1], recipient_id: params[2], status: params[3] };
            return pg ? [] : { affectedRows: 1 };
        }
        if (/^UPDATE message_requests SET status = \?, decided_at = CURRENT_TIMESTAMP WHERE chat_id = \? AND recipient_id = \? AND status = \?/.test(sql)) {
            const r = world.requests[params[1]];
            if (!r || r.recipient_id !== Number(params[2]) || r.status !== params[3]) return written(0);
            r.status = params[0];
            return written(1);
        }
        if (/^UPDATE message_requests SET status = \?/.test(sql)) {
            const r = world.requests[params[1]];
            if (r) r.status = params[0];
            return written(1);
        }
        if (/^INSERT INTO deleted_chats/.test(sql)) {
            world.deletedChats.push({ chat_id: Number(params[0]), user_id: Number(params[1]) });
            return written(1);
        }
        if (/^DELETE FROM deleted_chats/.test(sql)) return written(1);

        // --- chats and members ---
        if (/^SELECT gm.id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c/.test(sql)) {
            const m = world.members.find(x => x.chat_id === Number(params[0]) && x.user_id === Number(params[1]));
            return m ? [{ id: 1, role: m.role, chat_type: world.chats[m.chat_id].chat_type, announcement_only: false }] : [];
        }
        if (/^SELECT \* FROM chats WHERE id = \?$/.test(sql)) {
            const c = world.chats[params[0]];
            return c ? [{ ...c, approve_new_members: false, announcement_only: false }] : [];
        }
        if (/^SELECT u.id, u.username, u.full_name, u.avatar_url, u.status, gm.role, gm.member_tag, gm.joined_at FROM group_members gm/.test(sql)) {
            return world.members.filter(m => m.chat_id === Number(params[0])).map(m => {
                const u = world.users[m.user_id];
                return { id: u.id, username: u.username, full_name: u.full_name, avatar_url: u.avatar_url, status: u.status, role: m.role, member_tag: null, joined_at: 'then' };
            });
        }
        if (/^SELECT id, username, full_name, avatar_url, status FROM users WHERE \(username LIKE \? OR full_name LIKE \?\)/.test(sql)) {
            return Object.values(world.users).filter(u => u.id !== Number(params[2])).map(u => ({ id: u.id, username: u.username, full_name: u.full_name, avatar_url: u.avatar_url, status: u.status }));
        }
        if (/^SELECT id, username, full_name FROM users WHERE id = \?$/.test(sql)) {
            const u = world.users[params[0]];
            return u ? [{ id: u.id, username: u.username, full_name: u.full_name }] : [];
        }
        if (/^SELECT c.id FROM chats c JOIN group_members gm1/.test(sql)) return [];
        if (/^INSERT INTO chats/.test(sql)) {
            const id = 50 + world.inserted.length;
            world.chats[id] = { id, chat_type: params[0], chat_name: params[1] };
            world.inserted.push({ table: 'chats', id });
            return pg ? [{ id }] : { insertId: id };
        }
        if (/^INSERT INTO group_members/.test(sql)) {
            world.members.push({ chat_id: Number(params[0]), user_id: Number(params[1]), role: params[2], last_read: 0 });
            return pg ? [] : { insertId: 1 };
        }
        if (/^SELECT id FROM group_members WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            return isMember(params[0], params[1]) ? [{ id: 1 }] : [];
        }
        if (/^SELECT role FROM group_members WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const m = world.members.find(x => x.chat_id === Number(params[0]) && x.user_id === Number(params[1]));
            return m ? [{ role: m.role }] : [];
        }
        if (/FROM group_bans/.test(sql)) return [];

        // --- read state and receipts ---
        if (/^SELECT last_read_message_id FROM group_members WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const m = world.members.find(x => x.chat_id === Number(params[0]) && x.user_id === Number(params[1]));
            return m ? [{ last_read_message_id: m.last_read || null }] : [];
        }
        if (/^SELECT id FROM messages WHERE id = \? AND chat_id = \?$/.test(sql)) {
            const m = world.messages[params[0]];
            return m && m.chat_id === Number(params[1]) ? [{ id: m.id }] : [];
        }
        if (/^SELECT MAX\(id\) AS id FROM messages WHERE chat_id = \?$/.test(sql)) {
            const ids = Object.values(world.messages).filter(m => m.chat_id === Number(params[0])).map(m => m.id);
            return [{ id: ids.length ? Math.max(...ids) : null }];
        }
        if (/^UPDATE group_members SET last_read_message_id = \?/.test(sql)) {
            const m = world.members.find(x => x.chat_id === Number(params[1]) && x.user_id === Number(params[2]));
            if (m) m.last_read = Number(params[0]);
            return written(1);
        }
        if (/^UPDATE messages SET status = 'read' WHERE chat_id = \?/.test(sql)) {
            world.statusUpdates.push({ sql, params });
            for (const m of Object.values(world.messages)) {
                if (m.chat_id === Number(params[0]) && m.sender_id !== Number(params[params.length - 1])) m.status = 'read';
            }
            return written(1);
        }
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 0 }];
        if (/^SELECT m.id, m.chat_id, m.sender_id, m.status FROM messages m JOIN group_members gm/.test(sql)) {
            const m = world.messages[params[1]];
            return m && isMember(m.chat_id, params[0]) ? [{ ...m }] : [];
        }
        if (/^UPDATE messages SET status = \? WHERE id = \?$/.test(sql)) {
            world.statusUpdates.push({ sql, params });
            world.messages[params[1]].status = params[0];
            return written(1);
        }

        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

function load(dbType, privacyOverrides) {
    const world = createWorld(dbType, privacyOverrides);
    const fake = setupFakeDb(dbType, world.handler);
    return { world, fake };
}

const NOBODY = { lastSeen: 'nobody', photo: 'nobody', bio: 'nobody' };
const CONTACTS = { lastSeen: 'contacts', photo: 'contacts', bio: 'contacts' };

function assertNoAliceSecrets(payload, label) {
    const json = JSON.stringify(payload);
    for (const secret of [SECRET_AVATAR, SECRET_BIO, SECRET_STATUS, SECRET_LAST_SEEN, '🎉', '"online"']) {
        if (secret === '"online"') continue; // other users may be online; checked per field below
        assert.ok(!json.includes(secret), `${label} leaks ${secret}`);
    }
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`privacy filtering (${dbType})`, () => {
        test('"Nobody": Bob gets no avatar, presence, last seen, bio or custom status of Alice from any endpoint', async () => {
            const { fake } = load(dbType, NOBODY);
            const chats = fake.load('controllers/chatController.js');
            const users = fake.load('controllers/userController.js');

            const direct = fakeRes();
            await chats.getChatById({ params: { chatId: DIRECT_AB }, user: { id: BOB } }, direct);
            assert.equal(direct.statusCode, 200);
            const alice = direct.body.data.participants.find(p => p.id === ALICE);
            assert.equal(alice.avatar_url, null);
            assert.equal(alice.status, null);
            assert.equal(alice.last_seen, null);
            assert.equal(alice.custom_status, null);
            assertNoAliceSecrets(direct.body, 'GET /api/chats/:id');

            const card = fakeRes();
            await users.getUserProfile({ params: { userId: ALICE }, user: { id: BOB } }, card);
            assert.equal(card.statusCode, 200);
            assert.deepEqual(
                { avatarUrl: card.body.data.avatarUrl, bio: card.body.data.bio, customStatus: card.body.data.customStatus, status: card.body.data.status, lastSeen: card.body.data.lastSeen },
                { avatarUrl: null, bio: null, customStatus: null, status: null, lastSeen: null }
            );
            assert.equal(card.body.data.username, 'alice'); // the name is never hidden
            assertNoAliceSecrets(card.body, 'GET /api/users/:id');

            const search = fakeRes();
            await chats.searchUsers({ query: { query: 'al' }, user: { id: EVE } }, search);
            const found = search.body.data.find(u => u.id === ALICE);
            assert.equal(found.avatar_url, null);
            assert.equal(found.status, null);
            assertNoAliceSecrets(search.body, 'GET /api/chats/search/users');
        });

        test('Alice always sees her own profile in full', async () => {
            const { fake } = load(dbType, NOBODY);
            const users = fake.load('controllers/userController.js');
            const res = fakeRes();
            await users.getUserProfile({ params: { userId: ALICE }, user: { id: ALICE } }, res);
            assert.equal(res.body.data.avatarUrl, SECRET_AVATAR);
            assert.equal(res.body.data.bio, SECRET_BIO);
            assert.equal(res.body.data.customStatus.text, SECRET_STATUS);
            assert.equal(res.body.data.isSelf, true);
        });

        test('"My contacts": Bob (shares a chat) sees everything, Eve (only a pending request) sees nothing', async () => {
            const { fake } = load(dbType, CONTACTS);
            const users = fake.load('controllers/userController.js');

            const bob = fakeRes();
            await users.getUserProfile({ params: { userId: ALICE }, user: { id: BOB } }, bob);
            assert.equal(bob.body.data.avatarUrl, SECRET_AVATAR);
            assert.equal(bob.body.data.bio, SECRET_BIO);
            assert.equal(bob.body.data.status, 'online');
            assert.equal(bob.body.data.customStatus.emoji, '🎉');
            assert.equal(bob.body.data.isContact, true);

            const eve = fakeRes();
            await users.getUserProfile({ params: { userId: ALICE }, user: { id: EVE } }, eve);
            assert.equal(eve.body.data.isContact, false);
            assertNoAliceSecrets(eve.body, 'profile card for a requester');
            assert.equal(eve.body.data.status, null);
        });

        test('someone Alice blocked sees nothing even with "Everyone"', async () => {
            const { fake } = load(dbType, {});
            const users = fake.load('controllers/userController.js');
            const res = fakeRes();
            // Mallory is blocked BY Alice, so for Mallory Alice is a blocker
            await users.getUserProfile({ params: { userId: ALICE }, user: { id: MALLORY } }, res);
            assertNoAliceSecrets(res.body, 'profile card for a blocked user');
        });

        test('an expired custom status is never sent, and only server-made avatar paths are', async () => {
            const { world, fake } = load(dbType, {});
            world.users[ALICE].status_expires_in = -5;
            world.users[ALICE].avatar_url = 'javascript:alert(1)';
            const users = fake.load('controllers/userController.js');
            const res = fakeRes();
            await users.getUserProfile({ params: { userId: ALICE }, user: { id: BOB } }, res);
            assert.equal(res.body.data.customStatus, null);
            assert.equal(res.body.data.avatarUrl, null);
        });
    });

    describe(`privacy in socket broadcasts (${dbType})`, () => {
        const EVERYONE_ELSE = [BOB, EVE, MALLORY];

        test('presence: "Nobody" reaches no one, "My contacts" only contacts, "Everyone" all but blocked users', async () => {
            for (const [settings, expected] of [[{ lastSeen: 'nobody' }, []], [{ lastSeen: 'contacts' }, [BOB]], [{}, [BOB, EVE]]]) {
                const { fake } = load(dbType, settings);
                const { emitPresence } = fake.load('utils/privacy.js');
                const io = recordingIo();
                await emitPresence(io, ALICE, 'online', { broadcast: io.broadcast });
                const reachedUsers = new Set(io.emitted.filter(e => e.event === 'user_status').flatMap(e => reached(e, EVERYONE_ELSE)));
                assert.deepEqual([...reachedUsers].sort(), expected, JSON.stringify(settings));
            }
        });

        test('profile updates go to contacts only, filtered as a contact may see them', async () => {
            const { fake } = load(dbType, { photo: 'nobody', bio: 'contacts', lastSeen: 'nobody' });
            const { emitProfileUpdate } = fake.load('utils/privacy.js');
            const io = recordingIo();
            await emitProfileUpdate(io, ALICE);

            const toOthers = io.emitted.filter(e => e.event === 'user_profile_updated' && !e.rooms.includes(`user_${ALICE}`));
            assert.equal(toOthers.length, 1);
            assert.deepEqual(reached(toOthers[0], EVERYONE_ELSE), [BOB]); // not Eve (request), not Mallory (blocked)
            assert.equal(toOthers[0].data.avatarUrl, null);
            assert.equal(toOthers[0].data.status, null);
            assert.equal(toOthers[0].data.customStatus.text, SECRET_STATUS);
            assert.ok(!JSON.stringify(toOthers[0].data).includes(SECRET_AVATAR));
        });

        test('read receipts off: no stored "read", no messages_read, and "read" reports become "delivered"', async () => {
            const { world, fake } = load(dbType, { readReceipts: false });
            const chatState = fake.load('utils/chatState.js');
            const io = recordingIo();

            await chatState.markChatRead(io, DIRECT_AB, ALICE, 101);
            assert.equal(world.statusUpdates.length, 0);
            assert.ok(!io.emitted.some(e => e.event === 'messages_read'));
            assert.ok(io.emitted.some(e => e.event === 'read_position_updated')); // own tabs still sync

            const result = await chatState.updateMessageStatus(io, 101, ALICE, 'read');
            assert.equal(result.status, 'delivered');
            assert.equal(world.messages[101].status, 'delivered');
        });

        test('read receipts off also hides other people\'s reads from you', async () => {
            const { fake } = load(dbType, { readReceipts: false });
            const chatState = fake.load('utils/chatState.js');
            const io = recordingIo();
            await chatState.markChatRead(io, DIRECT_AB, BOB, 102);
            const read = io.emitted.find(e => e.event === 'messages_read');
            assert.ok(read, 'Bob shares receipts, so the chat is told');
            assert.ok(read.except.includes(`user_${ALICE}`), 'but not Alice, who turned receipts off');

            const { maskReadStatus } = fake.load('utils/privacy.js');
            assert.deepEqual(maskReadStatus([{ status: 'read' }, { status: 'sent' }], false), [{ status: 'delivered' }, { status: 'sent' }]);
        });

        test('status reports only move forward and never apply to your own messages', async () => {
            const { world, fake } = load(dbType, {});
            const chatState = fake.load('utils/chatState.js');
            assert.equal((await chatState.updateMessageStatus(null, 102, ALICE, 'read')).changed, false);
            assert.equal(world.messages[102].status, 'sent');
            await chatState.updateMessageStatus(null, 101, ALICE, 'read');
            assert.equal((await chatState.updateMessageStatus(null, 101, ALICE, 'delivered')).changed, false);
            assert.equal(world.messages[101].status, 'read');
            assert.equal((await chatState.updateMessageStatus(null, 101, EVE, 'read')).error.status, 404);
            assert.equal((await chatState.updateMessageStatus(null, 101, ALICE, 'seen')).error.status, 400);
        });

        test('typing switch', async () => {
            const { fake } = load(dbType, { typingIndicators: false });
            const privacy = fake.load('utils/privacy.js');
            assert.equal(await privacy.typingIndicatorsEnabled(ALICE), false);
            assert.equal(await privacy.typingIndicatorsEnabled(BOB), true);
        });
    });

    describe(`who can add me to groups (${dbType})`, () => {
        test('"Nobody" refuses everyone, "My contacts" only contacts', async () => {
            const { fake } = load(dbType, { groups: 'nobody' });
            const privacy = fake.load('utils/privacy.js');
            assert.deepEqual(await privacy.findGroupAddRefusals(BOB, [ALICE]), [ALICE]);

            const contacts = load(dbType, { groups: 'contacts' }).fake.load('utils/privacy.js');
            assert.deepEqual(await contacts.findGroupAddRefusals(BOB, [ALICE]), []);
            assert.deepEqual(await contacts.findGroupAddRefusals(EVE, [ALICE]), [ALICE]);
        });

        test('creating a group with someone who said "Nobody" is a 403 and creates nothing', async () => {
            const { world, fake } = load(dbType, { groups: 'nobody' });
            const chats = fake.load('controllers/chatController.js');
            const res = fakeRes();
            await chats.createChat({ body: { chatType: 'group', chatName: 'x', participants: [ALICE] }, user: { id: BOB, email_verified_at: '2026-01-01' } }, res);
            assert.equal(res.statusCode, 403);
            assert.equal(res.body.code, 'PRIVACY_GROUP_ADD');
            assert.equal(world.inserted.length, 0);
        });
    });

    describe(`message requests (${dbType})`, () => {
        test('a direct chat with someone you share no chat with is a request; with a contact it is not', async () => {
            const { world, fake } = load(dbType, {});
            const chats = fake.load('controllers/chatController.js');

            const toStranger = fakeRes();
            await chats.createChat({ body: { chatType: 'direct', participants: [EVE] }, user: { id: BOB, email_verified_at: '2026-01-01' } }, toStranger);
            assert.equal(toStranger.statusCode, 201);
            assert.equal(toStranger.body.data.messageRequest, true);
            const created = world.requests[toStranger.body.data.chatId];
            assert.deepEqual([created.requester_id, created.recipient_id, created.status], [BOB, EVE, 'pending']);

            const toContact = fakeRes();
            await chats.createChat({ body: { chatType: 'direct', participants: [MALLORY] }, user: { id: BOB, email_verified_at: '2026-01-01' } }, toContact);
            assert.equal(toContact.body.data.messageRequest, false);
        });

        test('until accepted the recipient cannot post or react; the requester can', async () => {
            const { fake } = load(dbType, {});
            const { checkCanPost } = fake.load('utils/groups.js');
            assert.equal((await checkCanPost(REQUEST_EA, ALICE)).code, 'REQUEST_PENDING');
            assert.equal(await checkCanPost(REQUEST_EA, EVE), null);

            const chats = fake.load('controllers/chatController.js');
            const res = fakeRes();
            await chats.getChatById({ params: { chatId: REQUEST_EA }, user: { id: ALICE } }, res);
            assert.equal(res.body.data.can_post, false);
            assert.deepEqual(res.body.data.message_request, { status: 'pending', incoming: true });
        });

        test('no read receipts reach the requester before acceptance; accepting sends them', async () => {
            const { world, fake } = load(dbType, {});
            const chatState = fake.load('utils/chatState.js');
            const io = recordingIo();
            await chatState.markChatRead(io, REQUEST_EA, ALICE, 100);
            assert.equal(world.messages[100].status, 'sent');
            assert.ok(!io.emitted.some(e => e.event === 'messages_read'));
            assert.equal((await chatState.updateMessageStatus(io, 100, ALICE, 'read')).status, 'delivered');

            const requests = fake.load('controllers/requestController.js');
            const res = fakeRes();
            await requests.acceptRequest({ params: { chatId: REQUEST_EA }, user: { id: ALICE }, io }, res);
            assert.equal(res.statusCode, 200);
            assert.equal(world.requests[REQUEST_EA].status, 'accepted');
            assert.equal(world.messages[100].status, 'read');
            assert.ok(io.emitted.some(e => e.event === 'messages_read' && e.rooms.includes(`chat_${REQUEST_EA}`)));
            assert.ok(io.emitted.some(e => e.event === 'message_request_updated' && e.rooms.includes(`user_${EVE}`)));
        });

        test('delete hides the chat for the recipient and tells the requester nothing', async () => {
            const { world, fake } = load(dbType, {});
            const requests = fake.load('controllers/requestController.js');
            const io = recordingIo();
            const res = fakeRes();
            await requests.deleteRequest({ params: { chatId: REQUEST_EA }, user: { id: ALICE }, io }, res);
            assert.equal(world.requests[REQUEST_EA].status, 'deleted');
            assert.deepEqual(world.deletedChats, [{ chat_id: REQUEST_EA, user_id: ALICE }]);
            assert.ok(!io.emitted.some(e => e.rooms.includes(`user_${EVE}`)));

            const { describeRequest, getRequest } = fake.load('utils/messageRequests.js');
            assert.deepEqual(describeRequest(await getRequest(REQUEST_EA), EVE), { status: 'pending', incoming: false });
        });

        test('block blocks the requester; only the recipient can decide, and only once', async () => {
            const { world, fake } = load(dbType, {});
            const requests = fake.load('controllers/requestController.js');

            const notRecipient = fakeRes();
            await requests.acceptRequest({ params: { chatId: REQUEST_EA }, user: { id: EVE }, io: recordingIo() }, notRecipient);
            assert.equal(notRecipient.statusCode, 404);

            const res = fakeRes();
            await requests.blockRequest({ params: { chatId: REQUEST_EA }, user: { id: ALICE }, io: recordingIo() }, res);
            assert.equal(res.statusCode, 200);
            assert.ok(world.blocks.some(b => b.blocker_id === ALICE && b.blocked_id === EVE));
            assert.equal(world.requests[REQUEST_EA].status, 'blocked');

            const again = fakeRes();
            await requests.acceptRequest({ params: { chatId: REQUEST_EA }, user: { id: ALICE }, io: recordingIo() }, again);
            assert.equal(again.statusCode, 409);
        });
    });
}

describe('chat list on PostgreSQL (lowercased aliases)', () => {
    test('participant rows keyed userid/avatarurl are normalized and filtered, so "Nobody" leaks nothing', async () => {
        const fake = setupFakeDb('postgresql', (rawSql, params) => {
            const sql = rawSql.replace(/\$\d+/g, '?');
            if (/FROM chats c JOIN group_members gm ON c.id = gm.chat_id AND gm.user_id/.test(sql)) {
                return [{ id: DIRECT_AB, chat_type: 'direct', chat_name: null, unread_count: '0', is_muted: 0, archived_at: null }];
            }
            // What pg really returns for "u.id as userId, u.avatar_url as avatarUrl"
            if (/FROM group_members gm JOIN users u/.test(sql)) {
                return [
                    { chat_id: DIRECT_AB, userid: ALICE, username: 'alice', fullname: 'Alice', avatarurl: SECRET_AVATAR, status: 'online', role: 'member' },
                    { chat_id: DIRECT_AB, userid: BOB, username: 'bob', fullname: 'Bob', avatarurl: null, status: 'online', role: 'member' }
                ];
            }
            if (/FROM users u LEFT JOIN privacy_settings ps/.test(sql)) {
                return [{ id: ALICE, status: 'online', last_seen: null, avatar_url: SECRET_AVATAR, bio: null, custom_status_text: null, custom_status_emoji: null, status_expires_in: null, last_seen_audience: 'nobody', photo_audience: 'nobody', bio_audience: 'nobody', groups_audience: 'everyone', read_receipts: true, typing_indicators: true }];
            }
            if (/FROM chats c JOIN messages m ON m.id = \(/.test(sql)) return [];
            if (/privacy_settings|message_requests|user_blocks/.test(sql)) return [];
            throw new Error(`Unexpected query: ${sql}`);
        });
        const { getUserChats } = fake.load('controllers/chatController.js');
        const res = fakeRes();
        const log = console.log;
        console.log = () => {};
        try {
            await getUserChats({ user: { id: BOB } }, res);
        } finally {
            console.log = log;
        }
        assert.equal(res.statusCode, 200);
        assert.ok(!JSON.stringify(res.body).includes(SECRET_AVATAR));
        const alice = JSON.parse(res.body.data[0].participants).find(p => p.userId === ALICE);
        assert.deepEqual([alice.fullName, alice.avatarUrl, alice.status], ['Alice', null, null]);
    });
});

describe('phase 9 validation', () => {
    const { setupFakeDb: setup } = require('./helpers/fakeDb');
    const validation = setup('mysql', () => []).load('utils/validation.js');

    async function run(rules, body) {
        const req = { body, params: {}, query: {} };
        for (const rule of rules) await rule.run(req);
        const res = fakeRes();
        let passed = false;
        validation.checkValidation(req, res, () => { passed = true; });
        return { passed, req, res };
    }

    test('privacy settings: audiences and strict booleans only', async () => {
        assert.equal((await run(validation.validatePrivacySettings, { lastSeen: 'contacts', readReceipts: false })).passed, true);
        assert.equal((await run(validation.validatePrivacySettings, { lastSeen: 'friends' })).passed, false);
        assert.equal((await run(validation.validatePrivacySettings, { readReceipts: 'false' })).passed, false);
    });

    test('profile: no avatar URLs, length limits, control characters stripped', async () => {
        assert.equal((await run(validation.validateProfileUpdate, { avatarUrl: 'https://evil.example/x.svg' })).passed, false);
        assert.equal((await run(validation.validateProfileUpdate, { bio: 'x'.repeat(161) })).passed, false);
        const ok = await run(validation.validateProfileUpdate, { displayName: '  Ann\u0000ie  ', bio: 'line one\nline two' });
        assert.equal(ok.passed, true);
        assert.equal(ok.req.body.displayName, 'Annie');
        assert.equal(ok.req.body.bio, 'line one line two');
    });

    test('custom status: an emoji or text, a known duration, emoji must be pictographic', async () => {
        assert.equal((await run(validation.validateCustomStatus, { emoji: '🎉', duration: '1h' })).passed, true);
        assert.equal((await run(validation.validateCustomStatus, { text: 'Busy', duration: 'never' })).passed, true);
        assert.equal((await run(validation.validateCustomStatus, { duration: '1h' })).passed, false);
        assert.equal((await run(validation.validateCustomStatus, { emoji: '<img>', text: 'x' })).passed, false);
        assert.equal((await run(validation.validateCustomStatus, { text: 'x', duration: '2y' })).passed, false);
        assert.equal((await run(validation.validateCustomStatus, { text: 'x'.repeat(81) })).passed, false);
    });
});

describe('profile photos', () => {
    let tmp;
    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-avatars-'));
        process.env.UPLOAD_PATH = tmp;
    });
    after(() => {
        delete process.env.UPLOAD_PATH;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function loadAvatars() {
        return setupFakeDb('mysql', () => []).load('utils/avatars.js');
    }

    test('non-images (HTML, SVG, scripts with an image name) are refused before anything is written', async () => {
        const avatars = loadAvatars();
        for (const bytes of ['<html><script>alert(1)</script></html>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'GIF89a<script>alert(1)</script>']) {
            const result = await avatars.saveUserAvatar(Buffer.from(bytes));
            assert.equal(result.status, 400);
        }
        assert.ok(!fs.existsSync(path.join(tmp, 'avatars')) || fs.readdirSync(path.join(tmp, 'avatars')).length === 0);
    });

    test('a photo is cropped to a 512x512 WebP; appended script bytes never survive; replace and rotate stay in the folder', async (t) => {
        const avatars = loadAvatars();
        if (!avatars.isSharpAvailable()) {
            t.skip('sharp is not installed');
            return;
        }
        const sharp = require('sharp');
        const wide = await sharp({ create: { width: 300, height: 120, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();
        // A "polyglot": a real PNG with HTML/JS appended after the image data
        const polyglot = Buffer.concat([wide, Buffer.from('<script>alert(document.cookie)</script>')]);

        const saved = await avatars.saveUserAvatar(polyglot);
        if (saved.error) {
            assert.equal(saved.status, 400); // refusing it is fine too
            return;
        }
        assert.match(saved.avatarUrl, /^uploads\/avatars\/[a-f0-9]{32}\.webp$/);
        const file = path.join(tmp, 'avatars', path.basename(saved.avatarUrl));
        const bytes = fs.readFileSync(file);
        assert.ok(!bytes.includes(Buffer.from('<script')), 'the script bytes are gone');
        const meta = await sharp(bytes).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);
        assert.equal(meta.exif, undefined);

        const rotated = await avatars.rotateUserAvatar(saved.avatarUrl);
        assert.notEqual(rotated, saved.avatarUrl);
        assert.ok(!fs.existsSync(file));
        await avatars.deleteUserAvatar(rotated);
        assert.ok(!fs.existsSync(path.join(tmp, 'avatars', path.basename(rotated))));

        // Paths that aren't stored photos are never touched
        await avatars.deleteUserAvatar('uploads/avatars/../../server.js');
        assert.equal(await avatars.rotateUserAvatar('uploads/group-avatars/0123456789abcdef0123456789abcdef.webp'), null);
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'server.js')));
    });
});

describe('phase 9 frontend helpers', () => {
    const vm = require('vm');
    const { runFrontendScript } = require('./helpers/frontendScripts');
    const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
    const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

    function sandbox() {
        const box = {
            console: { log() {}, error() {} },
            setInterval() {},
            CONFIG: { API_BASE_URL: 'http://api.test/api', ENDPOINTS: {} },
            document: { getElementById: () => null, querySelectorAll: () => [] }
        };
        vm.createContext(box);
        const chat = read('js/chat.js');
        vm.runInContext(chat.slice(chat.indexOf('function escapeHtml(text)'), chat.indexOf('}', chat.indexOf(".replace(/'/g, '&#39;');")) + 1), box);
        runFrontendScript(read('js/profile.js'), box);
        return box;
    }

    test('only server-made avatar paths become image URLs, and the markup is escaped', () => {
        const box = sandbox();
        assert.equal(box.userAvatarSrc(SECRET_AVATAR), `http://api.test/${SECRET_AVATAR}`);
        for (const bad of ['javascript:alert(1)', 'https://evil.example/a.webp', 'uploads/avatars/../x.webp', 'uploads/avatars/x.svg', null]) {
            assert.equal(box.userAvatarSrc(bad), null);
        }
        assert.equal(box.avatarInnerHtml('<b>', null), '&lt;');
        assert.ok(!box.avatarInnerHtml('x', 'a" onerror="alert(1)').includes('" onerror'));
    });

    test('custom status labels drop expired statuses; hidden presence shows nothing', () => {
        const box = sandbox();
        const future = new Date(Date.now() + 60000).toISOString();
        const past = new Date(Date.now() - 60000).toISOString();
        assert.equal(box.customStatusLabel({ emoji: '🎉', text: 'Party', expiresAt: future }), '🎉 Party');
        assert.equal(box.customStatusLabel({ emoji: '🎉', text: 'Party', expiresAt: past }), '');
        assert.equal(box.customStatusLabel(null), '');
        assert.equal(box.presenceLabel(null, null), '');
        assert.equal(box.presenceLabel('online', null), 'online');
        assert.match(box.presenceLabel('offline', new Date().toISOString()), /^last seen today at /);
    });
});
