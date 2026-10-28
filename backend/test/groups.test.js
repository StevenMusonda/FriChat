/**
 * Phase 5: invite links, join approval, group settings, announcement-only mode,
 * leaving as the last admin, member tags and group avatars (both fake drivers).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { validationResult } = require('express-validator');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const GROUP = 10;
const DIRECT = 20;
const OTHER_GROUP = 30;
const ADMIN = 1;
const BOB = 2;
const CAROL = 3;
const DAVE = 4; // not in GROUP
const NEW_MESSAGE_ID = 500;

const USERS = { 1: 'alice', 2: 'bob', 3: 'carol', 4: 'dave' };

/**
 * In-memory tables answering exactly the queries the group code makes
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        chats: {
            [GROUP]: { id: GROUP, chat_type: 'group', chat_name: 'Team', description: null, avatar_url: null, approve_new_members: false, announcement_only: false },
            [DIRECT]: { id: DIRECT, chat_type: 'direct', chat_name: null, description: null, avatar_url: null, approve_new_members: false, announcement_only: false },
            [OTHER_GROUP]: { id: OTHER_GROUP, chat_type: 'group', chat_name: 'Other', description: null, avatar_url: null, approve_new_members: false, announcement_only: false }
        },
        members: [
            { id: 1, chat_id: GROUP, user_id: ADMIN, role: 'admin', joined_at: 1, member_tag: null },
            { id: 2, chat_id: GROUP, user_id: BOB, role: 'member', joined_at: 2, member_tag: null },
            { id: 3, chat_id: GROUP, user_id: CAROL, role: 'member', joined_at: 3, member_tag: null },
            { id: 4, chat_id: DIRECT, user_id: ADMIN, role: 'member', joined_at: 1, member_tag: null },
            { id: 5, chat_id: DIRECT, user_id: BOB, role: 'member', joined_at: 1, member_tag: null },
            { id: 6, chat_id: OTHER_GROUP, user_id: BOB, role: 'member', joined_at: 1, member_tag: null }
        ],
        invites: {},
        requests: {},
        nextId: 100,
        messagesInserted: 0,
        deletedChatsCleared: []
    };

    const member = (chatId, userId) => world.members.find(m => m.chat_id === Number(chatId) && m.user_id === Number(userId));
    const written = (n) => pg ? (n ? [{ id: 1 }] : []) : { affectedRows: n };
    const inserted = (id) => pg ? [{ id }] : { insertId: id };
    const inviteRow = (inv) => ({
        ...inv,
        is_expired: inv.expired ? 1 : 0,
        chat_type: world.chats[inv.chat_id].chat_type,
        created_by_username: USERS[inv.created_by]
    });

    world.member = member;
    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        // --- memberships ---
        if (/^SELECT gm.id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c ON c.id = gm.chat_id WHERE gm.chat_id = \? AND gm.user_id = \?$/.test(sql)) {
            const m = member(params[0], params[1]);
            return m ? [{ id: m.id, role: m.role, chat_type: world.chats[m.chat_id].chat_type, announcement_only: world.chats[m.chat_id].announcement_only }] : [];
        }
        if (/^SELECT gm.chat_id, gm.role, c.chat_type, c.announcement_only FROM group_members gm JOIN chats c ON c.id = gm.chat_id WHERE gm.user_id = \? AND gm.chat_id IN/.test(sql)) {
            return params.slice(1).map(chatId => member(chatId, params[0])).filter(Boolean)
                .map(m => ({ chat_id: m.chat_id, role: m.role, chat_type: world.chats[m.chat_id].chat_type, announcement_only: world.chats[m.chat_id].announcement_only }));
        }
        if (/^SELECT role FROM group_members WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const m = member(params[0], params[1]);
            return m ? [{ role: m.role }] : [];
        }
        if (/^SELECT \* FROM chats WHERE id = \?$/.test(sql)) {
            const chat = world.chats[params[0]];
            return chat ? [{ ...chat, announcement_only: chat.announcement_only ? 1 : 0, approve_new_members: chat.approve_new_members ? 1 : 0 }] : [];
        }
        if (/^SELECT u.id, u.username, u.full_name, u.avatar_url, u.status, gm.role, gm.member_tag, gm.joined_at FROM group_members gm/.test(sql)) {
            return world.members.filter(m => m.chat_id === Number(params[0]))
                .map(m => ({ id: m.user_id, username: USERS[m.user_id], full_name: null, avatar_url: null, status: 'online', role: m.role, member_tag: m.member_tag, joined_at: m.joined_at }));
        }
        if (/^SELECT id FROM group_members WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const m = member(params[0], params[1]);
            return m ? [{ id: m.id }] : [];
        }
        if (/^INSERT INTO group_members \(chat_id, user_id, role, last_read_message_id\)/.test(sql)) {
            if (member(params[0], params[1])) {
                const error = new Error('duplicate');
                error.code = pg ? '23505' : 'ER_DUP_ENTRY';
                throw error;
            }
            const id = ++world.nextId;
            world.members.push({ id, chat_id: Number(params[0]), user_id: Number(params[1]), role: params[2], joined_at: id, member_tag: null });
            return inserted(id);
        }
        if (/^DELETE FROM deleted_chats WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            world.deletedChatsCleared.push([Number(params[0]), Number(params[1])]);
            return written(0);
        }
        if (/^SELECT gm.user_id, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.chat_id = \? AND gm.user_id <> \? ORDER BY gm.joined_at ASC, gm.id ASC LIMIT 1$/.test(sql)) {
            const m = world.members.filter(x => x.chat_id === Number(params[0]) && x.user_id !== Number(params[1]))
                .sort((a, b) => a.joined_at - b.joined_at || a.id - b.id)[0];
            return m ? [{ user_id: m.user_id, username: USERS[m.user_id] }] : [];
        }
        if (/^SELECT gm.user_id, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.chat_id = \? AND gm.user_id = \?$/.test(sql)) {
            const m = member(params[0], params[1]);
            return m ? [{ user_id: m.user_id, username: USERS[m.user_id] }] : [];
        }
        if (/^SELECT COUNT\(\*\) AS count FROM group_members WHERE chat_id = \? AND role = 'admin' AND user_id <> \?$/.test(sql)) {
            return [{ count: world.members.filter(m => m.chat_id === Number(params[0]) && m.role === 'admin' && m.user_id !== Number(params[1])).length }];
        }
        if (/^SELECT COUNT\(\*\) AS count FROM group_members WHERE chat_id = \?$/.test(sql)) {
            return [{ count: world.members.filter(m => m.chat_id === Number(params[0])).length }];
        }
        if (/^UPDATE group_members SET role = 'admin' WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const m = member(params[0], params[1]);
            if (m) m.role = 'admin';
            return written(m ? 1 : 0);
        }
        if (/^UPDATE group_members SET member_tag = \? WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const m = member(params[1], params[2]);
            if (m) m.member_tag = params[0];
            return written(m ? 1 : 0);
        }
        if (/^DELETE FROM group_members WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const before = world.members.length;
            world.members = world.members.filter(m => !(m.chat_id === Number(params[0]) && m.user_id === Number(params[1])));
            return written(before - world.members.length);
        }
        if (/^SELECT user_id FROM group_members WHERE chat_id = \? AND role = 'admin'$/.test(sql)) {
            return world.members.filter(m => m.chat_id === Number(params[0]) && m.role === 'admin').map(m => ({ user_id: m.user_id }));
        }

        // --- chats ---
        if (/^SELECT id, chat_type, chat_name, description, avatar_url, approve_new_members, announcement_only FROM chats WHERE id = \?$/.test(sql)
            || /^SELECT id, chat_name, description, avatar_url, approve_new_members FROM chats WHERE id = \?$/.test(sql)
            || /^SELECT chat_name, approve_new_members FROM chats WHERE id = \?$/.test(sql)
            || /^SELECT chat_name FROM chats WHERE id = \?$/.test(sql)
            || /^SELECT avatar_url FROM chats WHERE id = \?$/.test(sql)) {
            const chat = world.chats[params[0]];
            return chat ? [{ ...chat }] : [];
        }
        if (/^UPDATE chats SET avatar_url = (\?|NULL) WHERE id = \?$/.test(sql)) {
            const isNull = /NULL/.test(sql);
            world.chats[params[isNull ? 0 : 1]].avatar_url = isNull ? null : params[0];
            return written(1);
        }
        if (/^UPDATE chats SET (.+) WHERE id = \?$/.test(sql) && !/CURRENT_TIMESTAMP/.test(sql)) {
            const columns = /^UPDATE chats SET (.+) WHERE id = \?$/.exec(sql)[1].split(', ').map(part => part.replace(' = ?', ''));
            const chat = world.chats[params[params.length - 1]];
            columns.forEach((column, i) => { chat[column] = params[i]; });
            world.lastChatUpdate = columns;
            return written(1);
        }

        // --- invites ---
        if (/^INSERT INTO chat_invites/.test(sql)) {
            const id = ++world.nextId;
            world.lastInviteInsert = { sql, params };
            world.invites[id] = {
                id, chat_id: Number(params[0]), token_hash: params[1], token_hint: params[2], created_by: params[3],
                expires_at: /CURRENT_TIMESTAMP \+ INTERVAL/.test(sql) ? '2099-01-01 00:00:00' : null,
                max_uses: params[4], use_count: 0, revoked_at: null, created_at: '2026-10-28 00:00:00', expired: false
            };
            return inserted(id);
        }
        if (/FROM chat_invites ci LEFT JOIN users u ON u.id = ci.created_by WHERE ci.id = \? AND ci.chat_id = \?$/.test(sql)) {
            const inv = world.invites[params[0]];
            return inv && inv.chat_id === Number(params[1]) ? [inviteRow(inv)] : [];
        }
        if (/FROM chat_invites ci LEFT JOIN users u ON u.id = ci.created_by WHERE ci.chat_id = \? ORDER BY/.test(sql)) {
            return Object.values(world.invites).filter(inv => inv.chat_id === Number(params[0])).reverse().map(inviteRow);
        }
        if (/FROM chat_invites ci JOIN chats c ON c.id = ci.chat_id WHERE ci.token_hash = \?$/.test(sql)) {
            const inv = Object.values(world.invites).find(i => i.token_hash === params[0]);
            return inv ? [inviteRow(inv)] : [];
        }
        if (/^UPDATE chat_invites SET revoked_at = CURRENT_TIMESTAMP WHERE id = \? AND chat_id = \? AND revoked_at IS NULL/.test(sql)) {
            const inv = world.invites[params[0]];
            const ok = !!inv && inv.chat_id === Number(params[1]) && !inv.revoked_at;
            if (ok) inv.revoked_at = '2026-10-28 01:00:00';
            return written(ok ? 1 : 0);
        }
        if (/^UPDATE chat_invites SET use_count = use_count \+ 1 WHERE id = \? AND revoked_at IS NULL AND \(expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP\) AND \(max_uses IS NULL OR use_count < max_uses\)/.test(sql)) {
            const inv = world.invites[params[0]];
            const ok = !!inv && !inv.revoked_at && !inv.expired && (inv.max_uses === null || inv.use_count < inv.max_uses) && !world.loseRace;
            if (ok) inv.use_count++;
            return written(ok ? 1 : 0);
        }
        if (/^UPDATE chat_invites SET use_count = use_count - 1/.test(sql)) {
            const inv = world.invites[params[0]];
            if (inv && inv.use_count > 0) inv.use_count--;
            return written(1);
        }

        // --- join requests ---
        if (/^SELECT status FROM chat_join_requests WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const r = Object.values(world.requests).find(x => x.chat_id === Number(params[0]) && x.user_id === Number(params[1]));
            return r ? [{ status: r.status }] : [];
        }
        if (/^SELECT id FROM chat_join_requests WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const r = Object.values(world.requests).find(x => x.chat_id === Number(params[0]) && x.user_id === Number(params[1]));
            return r ? [{ id: r.id }] : [];
        }
        if (/^INSERT INTO chat_join_requests/.test(sql)) {
            const id = ++world.nextId;
            world.requests[id] = { id, chat_id: Number(params[0]), user_id: Number(params[1]), invite_id: params[2], status: 'pending' };
            return inserted(id);
        }
        if (/^UPDATE chat_join_requests SET status = 'pending'/.test(sql)) {
            const r = world.requests[params[1]];
            r.status = 'pending';
            r.invite_id = params[0];
            return written(1);
        }
        if (/^SELECT COUNT\(\*\) AS count FROM chat_join_requests WHERE chat_id = \? AND status = 'pending'$/.test(sql)) {
            return [{ count: Object.values(world.requests).filter(r => r.chat_id === Number(params[0]) && r.status === 'pending').length }];
        }
        if (/^SELECT id, user_id, status FROM chat_join_requests WHERE id = \? AND chat_id = \?$/.test(sql)) {
            const r = world.requests[params[0]];
            return r && r.chat_id === Number(params[1]) ? [{ ...r }] : [];
        }
        if (/^UPDATE chat_join_requests SET status = \?, decided_by = \?, decided_at = CURRENT_TIMESTAMP WHERE id = \? AND status = 'pending'/.test(sql)) {
            const r = world.requests[params[2]];
            const ok = !!r && r.status === 'pending';
            if (ok) { r.status = params[0]; r.decided_by = params[1]; }
            return written(ok ? 1 : 0);
        }
        if (/^SELECT r.id, r.user_id, r.created_at, u.username, u.full_name, u.avatar_url FROM chat_join_requests r/.test(sql)) {
            return Object.values(world.requests).filter(r => r.chat_id === Number(params[0]) && r.status === 'pending')
                .map(r => ({ id: r.id, user_id: r.user_id, created_at: 'now', username: USERS[r.user_id], full_name: null, avatar_url: null }));
        }

        // --- just enough of a send for the "admin may still post" checks ---
        if (/^INSERT INTO messages/.test(sql)) {
            world.messagesInserted++;
            return pg ? [{ id: NEW_MESSAGE_ID }] : { insertId: NEW_MESSAGE_ID };
        }
        if (/^UPDATE/.test(sql)) return written(1);
        if (/^SELECT last_read_message_id FROM group_members/.test(sql)) return [{ last_read_message_id: NEW_MESSAGE_ID - 1 }];
        if (/^SELECT id FROM messages WHERE id = /.test(sql)) return [{ id: NEW_MESSAGE_ID }];
        if (/^SELECT MAX\(id\) AS id FROM messages/.test(sql)) return [{ id: NEW_MESSAGE_ID }];
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 0 }];
        if (/FROM messages m JOIN users u ON m.sender_id = u.id/.test(sql)) {
            return [{ id: NEW_MESSAGE_ID, chat_id: GROUP, sender_id: ADMIN, content: 'hello', message_type: 'text' }];
        }
        if (/FROM group_members gm JOIN chats c ON c.id = gm.chat_id AND c.chat_type = 'group' JOIN users u/.test(sql)) return [];
        if (/^SELECT m.id, m.message_type, m.content, m.file_id, m.deleted_for_everyone/.test(sql)) {
            return [{ id: 77, message_type: 'text', content: 'forward me', file_id: null, deleted_for_everyone: false }];
        }

        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

function setup(dbType) {
    const world = createWorld(dbType);
    const fake = setupFakeDb(dbType, (sql, params) => world.handler(sql, params));
    return { world, ...fake };
}

// fakeIo plus io.in(room).socketsJoin/socketsLeave
function roomIo() {
    const io = fakeIo();
    io.roomChanges = [];
    io.in = (room) => ({
        socketsJoin: (target) => io.roomChanges.push({ room, join: target }),
        socketsLeave: (target) => io.roomChanges.push({ room, leave: target })
    });
    return io;
}

async function call(handler, req) {
    const res = fakeRes();
    const io = req.io || roomIo();
    await handler({ params: {}, body: {}, ...req, user: { id: ADMIN, username: 'alice', ...(req.user || {}) }, io }, res);
    return { res, io };
}

async function runValidation(chain, req) {
    const full = { params: {}, body: {}, query: {}, headers: {}, ...req };
    for (const rule of chain) await rule.run(full);
    return { errors: validationResult(full).array(), req: full };
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`invite links (${dbType})`, () => {
        async function makeInvite(fake, body = {}) {
            const controller = fake.load('controllers/groupController.js');
            const { res } = await call(controller.createInvite, { params: { chatId: GROUP }, body });
            assert.equal(res.statusCode, 201, JSON.stringify(res.body));
            return res.body.data;
        }

        test('the code is 128 random bits; only its hash and a 4-character hint are stored', async () => {
            const fake = setup(dbType);
            const invite = await makeInvite(fake, { expiresIn: '1d', maxUses: 5 });

            assert.match(invite.code, /^[A-Za-z0-9_-]{22}$/);
            assert.equal(Buffer.from(invite.code, 'base64url').length, 16);
            assert.ok(invite.url.endsWith(`/join.html?code=${invite.code}`));

            const { params, sql } = fake.world.lastInviteInsert;
            assert.ok(!params.includes(invite.code), 'the raw code must not be written');
            const { hashInviteToken } = fake.load('utils/invites.js');
            assert.equal(params[1], hashInviteToken(invite.code));
            assert.equal(params[2], invite.code.slice(0, 4));
            assert.match(sql, dbType === 'postgresql' ? /CURRENT_TIMESTAMP \+ INTERVAL '1 day'/ : /CURRENT_TIMESTAMP \+ INTERVAL 1 DAY/);
            assert.equal(invite.maxUses, 5);
            assert.equal(invite.status, 'active');

            // Listing never includes the code or its hash
            const controller = fake.load('controllers/groupController.js');
            const { res } = await call(controller.listInvites, { params: { chatId: GROUP } });
            assert.equal(res.body.data.length, 1);
            const listed = JSON.stringify(res.body.data);
            assert.ok(!listed.includes(invite.code) && !listed.includes(params[1]));
        });

        test('"never" stores no expiry', async () => {
            const fake = setup(dbType);
            await makeInvite(fake, { expiresIn: 'never' });
            assert.match(fake.world.lastInviteInsert.sql, /VALUES \(\?, \?, \?, \?, NULL, \?\)( RETURNING id)?$/);
            assert.equal(Object.values(fake.world.invites)[0].expires_at, null);
        });

        test('preview shows the group; joining adds the member, joins their sockets and counts one use', async () => {
            const fake = setup(dbType);
            fake.world.chats[GROUP].description = 'Our team';
            const invite = await makeInvite(fake, { maxUses: 2 });
            const controller = fake.load('controllers/inviteController.js');

            const preview = await call(controller.previewInvite, { params: { code: invite.code }, user: { id: DAVE, username: 'dave' } });
            assert.equal(preview.res.statusCode, 200);
            assert.deepEqual(preview.res.body.data, {
                chatId: GROUP, chatName: 'Team', description: 'Our team', avatarUrl: null,
                memberCount: 3, approvalRequired: false, joinState: 'none'
            });

            const { res, io } = await call(controller.joinWithInvite, { params: { code: invite.code }, user: { id: DAVE, username: 'dave' } });
            assert.equal(res.statusCode, 201);
            assert.deepEqual(res.body.data, { status: 'joined', chatId: GROUP });
            assert.ok(fake.world.member(GROUP, DAVE));
            assert.equal(fake.world.member(GROUP, DAVE).role, 'member');
            assert.deepEqual(fake.world.deletedChatsCleared, [[GROUP, DAVE]]);
            assert.deepEqual(io.roomChanges, [{ room: `user_${DAVE}`, join: `chat_${GROUP}` }]);
            assert.ok(io.emitted.some(e => e.event === 'group_members_updated' && e.room === `chat_${GROUP}`));
            assert.equal(Object.values(fake.world.invites)[0].use_count, 1);

            // Joining again is harmless and doesn't use the link up
            const again = await call(controller.joinWithInvite, { params: { code: invite.code }, user: { id: DAVE, username: 'dave' } });
            assert.equal(again.res.body.data.status, 'already_member');
            assert.equal(Object.values(fake.world.invites)[0].use_count, 1);
        });

        test('expired, revoked, over-used and unknown links fail with clear messages and reveal nothing', async () => {
            const fake = setup(dbType);
            const controller = fake.load('controllers/inviteController.js');
            const groupController = fake.load('controllers/groupController.js');
            const asDave = { user: { id: DAVE, username: 'dave' } };

            const expired = await makeInvite(fake, { expiresIn: '1h' });
            Object.values(fake.world.invites).find(i => i.token_hint === expired.code.slice(0, 4)).expired = true;

            const revoked = await makeInvite(fake);
            const revoke = await call(groupController.revokeInvite, { params: { chatId: GROUP, inviteId: revoked.id } });
            assert.equal(revoke.res.statusCode, 200);
            assert.equal(revoke.res.body.data.status, 'revoked');

            const usedUp = await makeInvite(fake, { maxUses: 1 });
            const first = await call(controller.joinWithInvite, { params: { code: usedUp.code }, ...asDave });
            assert.equal(first.res.statusCode, 201);

            const unknown = 'A'.repeat(22);
            const cases = [
                [expired.code, 410, 'EXPIRED', /expired/],
                [revoked.code, 410, 'REVOKED', /revoked/],
                [usedUp.code, 410, 'USED_UP', /maximum number of uses/],
                [unknown, 404, 'INVALID', /invalid/]
            ];
            for (const [code, status, errorCode, message] of cases) {
                for (const handler of [controller.previewInvite, controller.joinWithInvite]) {
                    const { res } = await call(handler, { params: { code }, user: { id: CAROL + 100, username: 'eve' } });
                    assert.equal(res.statusCode, status, `${errorCode} via ${handler.name}`);
                    assert.equal(res.body.code, errorCode);
                    assert.match(res.body.message, message);
                    assert.equal(res.body.data, undefined, 'no group details for an unusable link');
                }
            }
            assert.ok(!fake.world.member(GROUP, CAROL + 100));
        });

        test('losing the race for the last use reports the link as used up', async () => {
            const fake = setup(dbType);
            const invite = await makeInvite(fake, { maxUses: 1 });
            const controller = fake.load('controllers/inviteController.js');

            fake.world.loseRace = true;
            const { res } = await call(controller.joinWithInvite, { params: { code: invite.code }, user: { id: DAVE } });
            assert.equal(res.statusCode, 410);
            assert.equal(res.body.code, 'USED_UP');
            assert.ok(!fake.world.member(GROUP, DAVE));
        });

        test('links never point at a direct chat', async () => {
            const fake = setup(dbType);
            const { hashInviteToken } = fake.load('utils/invites.js');
            const code = 'B'.repeat(22);
            fake.world.invites[1] = { id: 1, chat_id: DIRECT, token_hash: hashInviteToken(code), token_hint: 'BBBB', created_by: ADMIN, max_uses: null, use_count: 0, revoked_at: null };
            const controller = fake.load('controllers/inviteController.js');
            const { res } = await call(controller.joinWithInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(res.statusCode, 404);
            assert.equal(res.body.code, 'INVALID');
        });

        test('ENABLE_INVITE_LINKS=false switches create, list, preview and join off', async () => {
            const fake = setup(dbType);
            const invite = await makeInvite(fake);
            const groupController = fake.load('controllers/groupController.js');
            const controller = fake.load('controllers/inviteController.js');

            process.env.ENABLE_INVITE_LINKS = 'false';
            try {
                for (const [handler, params] of [
                    [groupController.createInvite, { chatId: GROUP }],
                    [groupController.listInvites, { chatId: GROUP }],
                    [controller.previewInvite, { code: invite.code }],
                    [controller.joinWithInvite, { code: invite.code }]
                ]) {
                    const { res } = await call(handler, { params, user: { id: handler === controller.joinWithInvite ? DAVE : ADMIN } });
                    assert.equal(res.statusCode, 404);
                    assert.equal(res.body.code, 'DISABLED');
                }
                assert.ok(!fake.world.member(GROUP, DAVE));

                // Admins can still revoke what exists
                const { res } = await call(groupController.revokeInvite, { params: { chatId: GROUP, inviteId: invite.id } });
                assert.equal(res.statusCode, 200);
            } finally {
                delete process.env.ENABLE_INVITE_LINKS;
            }

            const { inviteLinksEnabled } = fake.load('config/groups.js');
            assert.equal(inviteLinksEnabled(), true, 'on by default');
            process.env.ENABLE_INVITE_LINKS = 'FALSE';
            assert.equal(inviteLinksEnabled(), false);
            delete process.env.ENABLE_INVITE_LINKS;
        });
    });

    describe(`join approval (${dbType})`, () => {
        test('with approval on, a link files a request, admins are told, and approving adds the member', async () => {
            const fake = setup(dbType);
            fake.world.chats[GROUP].approve_new_members = true;
            const groupController = fake.load('controllers/groupController.js');
            const controller = fake.load('controllers/inviteController.js');
            const { res: created } = await call(groupController.createInvite, { params: { chatId: GROUP }, body: {} });
            const code = created.body.data.code;

            const preview = await call(controller.previewInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(preview.res.body.data.approvalRequired, true);

            const join = await call(controller.joinWithInvite, { params: { code }, user: { id: DAVE, username: 'dave' } });
            assert.equal(join.res.statusCode, 202);
            assert.equal(join.res.body.data.status, 'pending');
            assert.ok(!fake.world.member(GROUP, DAVE), 'not a member until approved');
            const notice = join.io.emitted.find(e => e.event === 'join_request_created');
            assert.equal(notice.room, `user_${ADMIN}`);
            assert.equal(notice.data.user.username, 'dave');
            assert.equal(notice.data.pendingCount, 1);

            // Asking again while pending changes nothing
            const again = await call(controller.joinWithInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(again.res.body.data.status, 'pending');
            assert.equal(Object.values(fake.world.invites)[0].use_count, 1);
            const state = await call(controller.previewInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(state.res.body.data.joinState, 'pending');

            const list = await call(groupController.listJoinRequests, { params: { chatId: GROUP } });
            assert.equal(list.res.body.data.length, 1);
            const requestId = list.res.body.data[0].id;

            const approve = await call(groupController.approveJoinRequest, { params: { chatId: GROUP, requestId } });
            assert.equal(approve.res.statusCode, 200);
            assert.ok(fake.world.member(GROUP, DAVE));
            assert.deepEqual(approve.io.roomChanges, [{ room: `user_${DAVE}`, join: `chat_${GROUP}` }]);
            const decided = approve.io.emitted.find(e => e.event === 'join_request_decided');
            assert.equal(decided.room, `user_${DAVE}`);
            assert.deepEqual(decided.data, { chatId: GROUP, chatName: 'Team', status: 'approved' });

            // A second admin click can't act twice
            const twice = await call(groupController.declineJoinRequest, { params: { chatId: GROUP, requestId } });
            assert.equal(twice.res.statusCode, 409);
        });

        test('declining notifies the requester and keeps them out; they may ask again', async () => {
            const fake = setup(dbType);
            fake.world.chats[GROUP].approve_new_members = true;
            const groupController = fake.load('controllers/groupController.js');
            const controller = fake.load('controllers/inviteController.js');
            const { res: created } = await call(groupController.createInvite, { params: { chatId: GROUP }, body: {} });
            const code = created.body.data.code;
            await call(controller.joinWithInvite, { params: { code }, user: { id: DAVE } });
            const requestId = Object.keys(fake.world.requests)[0];

            const decline = await call(groupController.declineJoinRequest, { params: { chatId: GROUP, requestId: Number(requestId) } });
            assert.equal(decline.res.statusCode, 200);
            assert.ok(!fake.world.member(GROUP, DAVE));
            assert.equal(decline.io.emitted.find(e => e.event === 'join_request_decided').data.status, 'declined');

            const state = await call(controller.previewInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(state.res.body.data.joinState, 'declined');
            const retry = await call(controller.joinWithInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(retry.res.body.data.status, 'pending');
            assert.equal(Object.keys(fake.world.requests).length, 1, 'same row, back to pending');
        });

        test('a request id from another group is not found', async () => {
            const fake = setup(dbType);
            fake.world.requests[900] = { id: 900, chat_id: OTHER_GROUP, user_id: DAVE, status: 'pending' };
            const groupController = fake.load('controllers/groupController.js');
            const { res } = await call(groupController.approveJoinRequest, { params: { chatId: GROUP, requestId: 900 } });
            assert.equal(res.statusCode, 404);
            assert.equal(fake.world.requests[900].status, 'pending');
        });
    });

    describe(`admin-only endpoints (${dbType})`, () => {
        const adminCalls = (groupController) => [
            ['updateGroupSettings', { params: { chatId: GROUP }, body: { announcementOnly: true } }],
            ['uploadAvatar', { params: { chatId: GROUP }, file: { buffer: Buffer.alloc(16) } }],
            ['removeAvatar', { params: { chatId: GROUP } }],
            ['createInvite', { params: { chatId: GROUP }, body: {} }],
            ['listInvites', { params: { chatId: GROUP } }],
            ['revokeInvite', { params: { chatId: GROUP, inviteId: 1 } }],
            ['listJoinRequests', { params: { chatId: GROUP } }],
            ['approveJoinRequest', { params: { chatId: GROUP, requestId: 1 } }],
            ['declineJoinRequest', { params: { chatId: GROUP, requestId: 1 } }],
            ['setMemberTag', { params: { chatId: GROUP, userId: BOB }, body: { tag: 'boss' } }]
        ].map(([name, req]) => [name, groupController[name], req]);

        test('members who are not admins get 403 and nothing changes', async () => {
            const fake = setup(dbType);
            fake.world.requests[1] = { id: 1, chat_id: GROUP, user_id: DAVE, status: 'pending' };
            const groupController = fake.load('controllers/groupController.js');

            for (const [name, handler, req] of adminCalls(groupController)) {
                const { res, io } = await call(handler, { ...req, user: { id: BOB } });
                assert.equal(res.statusCode, 403, name);
                assert.match(res.body.message, /Only group admins/, name);
                assert.equal(io.emitted.length, 0, name);
            }
            assert.equal(fake.world.chats[GROUP].announcement_only, false);
            assert.equal(fake.world.member(GROUP, BOB).member_tag, null);
            assert.equal(fake.world.requests[1].status, 'pending');
            assert.equal(Object.keys(fake.world.invites).length, 0);
        });

        test('non-members get 403 and direct chats get 400', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');

            for (const [name, handler, req] of adminCalls(groupController)) {
                const outsider = await call(handler, { ...req, user: { id: DAVE } });
                assert.equal(outsider.res.statusCode, 403, name);
                assert.match(outsider.res.body.message, /Access denied/, name);

                const direct = await call(handler, { ...req, params: { ...req.params, chatId: DIRECT } });
                assert.equal(direct.res.statusCode, 400, name);
            }
        });

        test('admins change settings and every member hears about it', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');
            const { res, io } = await call(groupController.updateGroupSettings, {
                params: { chatId: GROUP },
                body: { chatName: 'Team 2', description: '', approveNewMembers: true, announcementOnly: true }
            });

            assert.equal(res.statusCode, 200);
            assert.deepEqual(fake.world.lastChatUpdate, ['chat_name', 'description', 'approve_new_members', 'announcement_only']);
            assert.equal(fake.world.chats[GROUP].description, null, 'empty description clears it');
            const event = io.emitted.find(e => e.event === 'group_updated');
            assert.equal(event.room, `chat_${GROUP}`);
            assert.deepEqual(event.data, {
                chatId: GROUP, chatName: 'Team 2', description: null, avatarUrl: null,
                approveNewMembers: true, announcementOnly: true
            });
        });

        test('tags are set by admins for members only', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');

            const { res, io } = await call(groupController.setMemberTag, { params: { chatId: GROUP, userId: BOB }, body: { tag: 'Designer' } });
            assert.equal(res.statusCode, 200);
            assert.equal(fake.world.member(GROUP, BOB).member_tag, 'Designer');
            assert.ok(io.emitted.some(e => e.event === 'group_members_updated'));

            const cleared = await call(groupController.setMemberTag, { params: { chatId: GROUP, userId: BOB }, body: { tag: '' } });
            assert.equal(cleared.res.statusCode, 200);
            assert.equal(fake.world.member(GROUP, BOB).member_tag, null);

            const outsider = await call(groupController.setMemberTag, { params: { chatId: GROUP, userId: DAVE }, body: { tag: 'x' } });
            assert.equal(outsider.res.statusCode, 404);
        });
    });

    describe(`announcement-only mode (${dbType})`, () => {
        function announcementWorld() {
            const fake = setup(dbType);
            fake.world.chats[GROUP].announcement_only = true;
            return fake;
        }

        test('REST send: members are refused, admins can post', async () => {
            const fake = announcementWorld();
            const { sendMessage } = fake.load('controllers/messageController.js');

            const refused = await call(sendMessage, { user: { id: BOB }, body: { chatId: GROUP, content: 'hi', messageType: 'text' } });
            assert.equal(refused.res.statusCode, 403);
            assert.equal(refused.res.body.code, 'ANNOUNCEMENT_ONLY');
            assert.match(refused.res.body.message, /Only admins can send messages/);
            assert.equal(fake.world.messagesInserted, 0);
            assert.equal(refused.io.emitted.length, 0);

            const allowed = await call(sendMessage, { user: { id: ADMIN }, body: { chatId: GROUP, content: 'hello', messageType: 'text' } });
            assert.equal(allowed.res.statusCode, 201);
            assert.equal(fake.world.messagesInserted, 1);
        });

        test('upload into the chat and forwarding into it are refused too', async () => {
            const fake = announcementWorld();
            const { uploadFile, forwardMessages } = fake.load('controllers/messageController.js');

            const upload = await call(uploadFile, {
                user: { id: BOB },
                body: { chatId: GROUP },
                file: { originalname: 'a.png', filename: 'a-1.png', size: 10, mimetype: 'image/png', path: 'uploads/images/a-1.png' }
            });
            assert.equal(upload.res.statusCode, 403);
            assert.equal(upload.res.body.code, 'ANNOUNCEMENT_ONLY');

            // Bob forwards from a group where he can post into the announcement group
            const forward = await call(forwardMessages, { user: { id: BOB }, body: { messageIds: [77], chatIds: [OTHER_GROUP, GROUP] } });
            assert.equal(forward.res.statusCode, 403);
            assert.equal(forward.res.body.code, 'ANNOUNCEMENT_ONLY');
            assert.equal(fake.world.messagesInserted, 0);
        });

        test('emitting send_message directly cannot bypass it', async () => {
            const fake = announcementWorld();
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
                id: 'test-socket', userId: BOB, data: {},
                join() {}, on(event, fn) { handlers[event] = fn; },
                emit(event, payload) { if (event === 'error') socketErrors.push(payload); }
            };
            try {
                io.sockets.listeners('connection')[0](socket);
                await handlers.send_message({ chatId: GROUP, messageType: 'text', content: 'sneaky' });
            } finally {
                await new Promise(resolve => io.close(() => resolve()));
                console.log = log;
            }

            assert.deepEqual(socketErrors, [{ event: 'send_message', message: 'Only admins can send messages in this group', code: 'ANNOUNCEMENT_ONLY' }]);
            assert.equal(fake.world.messagesInserted, 0);
            assert.equal(recorder.emitted.filter(e => e.event === 'new_message').length, 0);
        });

        test('GET /api/chats/:id tells the composer whether this user can post', async () => {
            const fake = announcementWorld();
            fake.world.member(GROUP, BOB).member_tag = 'Design';
            const { getChatById } = fake.load('controllers/chatController.js');

            const member = await call(getChatById, { params: { chatId: GROUP }, user: { id: BOB } });
            assert.equal(member.res.statusCode, 200);
            const chat = member.res.body.data;
            assert.equal(chat.announcement_only, true);
            assert.equal(chat.my_role, 'member');
            assert.equal(chat.can_post, false);
            assert.equal(chat.invite_links_enabled, true);
            assert.equal(chat.pending_request_count, 0);
            assert.equal(chat.participants.find(p => p.id === BOB).member_tag, 'Design');

            const admin = await call(getChatById, { params: { chatId: GROUP }, user: { id: ADMIN } });
            assert.equal(admin.res.body.data.can_post, true);
            assert.equal(admin.res.body.data.my_role, 'admin');

            const direct = await call(getChatById, { params: { chatId: DIRECT }, user: { id: BOB } });
            assert.equal(direct.res.body.data.can_post, true);
        });

        test('postingError: direct chats and admins are never blocked', async () => {
            const fake = setup(dbType);
            const { postingError } = fake.load('utils/groups.js');
            assert.equal(postingError(null).code, 'NOT_A_MEMBER');
            assert.equal(postingError({ role: 'member', chat_type: 'group', announcement_only: 1 }).code, 'ANNOUNCEMENT_ONLY');
            assert.equal(postingError({ role: 'member', chat_type: 'group', announcement_only: true }).code, 'ANNOUNCEMENT_ONLY');
            assert.equal(postingError({ role: 'admin', chat_type: 'group', announcement_only: true }), null);
            assert.equal(postingError({ role: 'member', chat_type: 'group', announcement_only: 0 }), null);
            assert.equal(postingError({ role: 'member', chat_type: 'direct', announcement_only: true }), null);
        });
    });

    describe(`leaving a group (${dbType})`, () => {
        test('the last admin hands admin to the longest-standing member', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');
            const { res, io } = await call(groupController.leaveGroup, { params: { chatId: GROUP }, body: {} });

            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.body.data.newAdmin, { userId: BOB, username: 'bob' });
            assert.equal(fake.world.member(GROUP, BOB).role, 'admin');
            assert.equal(fake.world.member(GROUP, CAROL).role, 'member');
            assert.ok(!fake.world.member(GROUP, ADMIN));
            assert.deepEqual(io.roomChanges, [{ room: `user_${ADMIN}`, leave: `chat_${GROUP}` }]);
            assert.ok(io.emitted.some(e => e.event === 'group_left' && e.room === `user_${ADMIN}`));
            assert.ok(io.emitted.some(e => e.event === 'group_members_updated' && e.room === `chat_${GROUP}`));
        });

        test('the last admin can pick who takes over', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');
            const { res } = await call(groupController.leaveGroup, { params: { chatId: GROUP }, body: { newAdminId: CAROL } });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.data.newAdmin.userId, CAROL);
            assert.equal(fake.world.member(GROUP, CAROL).role, 'admin');
            assert.equal(fake.world.member(GROUP, BOB).role, 'member');
        });

        test('picking a non-member or yourself is refused and you stay', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');
            for (const newAdminId of [DAVE, ADMIN]) {
                const { res } = await call(groupController.leaveGroup, { params: { chatId: GROUP }, body: { newAdminId } });
                assert.equal(res.statusCode, 400);
            }
            assert.ok(fake.world.member(GROUP, ADMIN));
        });

        test('when another admin remains, nobody is promoted; a member just leaves', async () => {
            const fake = setup(dbType);
            fake.world.member(GROUP, BOB).role = 'admin';
            const groupController = fake.load('controllers/groupController.js');

            const adminLeaves = await call(groupController.leaveGroup, { params: { chatId: GROUP }, body: {} });
            assert.equal(adminLeaves.res.body.data.newAdmin, null);
            assert.equal(fake.world.member(GROUP, CAROL).role, 'member');

            const memberLeaves = await call(groupController.leaveGroup, { params: { chatId: GROUP }, user: { id: CAROL }, body: {} });
            assert.equal(memberLeaves.res.statusCode, 200);
            assert.ok(!fake.world.member(GROUP, CAROL));
        });

        test('removing yourself through DELETE /members/:id follows the same rule', async () => {
            const fake = setup(dbType);
            const chatController = fake.load('controllers/chatController.js');
            const { res, io } = await call(chatController.removeMember, { params: { chatId: GROUP, userId: ADMIN } });

            assert.equal(res.statusCode, 200);
            assert.equal(fake.world.member(GROUP, BOB).role, 'admin');
            assert.deepEqual(io.roomChanges, [{ room: `user_${ADMIN}`, leave: `chat_${GROUP}` }]);
        });

        test('a removed member stops getting the chat\'s live events', async () => {
            const fake = setup(dbType);
            const chatController = fake.load('controllers/chatController.js');
            const { io } = await call(chatController.removeMember, { params: { chatId: GROUP, userId: CAROL } });

            assert.ok(!fake.world.member(GROUP, CAROL));
            assert.deepEqual(io.roomChanges, [{ room: `user_${CAROL}`, leave: `chat_${GROUP}` }]);
            assert.ok(io.emitted.some(e => e.event === 'group_left' && e.room === `user_${CAROL}`));
        });
    });
}

describe('validation of new inputs', () => {
    const load = () => setupFakeDb('mysql', () => []).load('utils/validation.js');

    test('group settings', async () => {
        const v = load();
        const ok = await runValidation(v.validateGroupSettings, { params: { chatId: '10' }, body: { chatName: '  Team\u0007 ', announcementOnly: false } });
        assert.deepEqual(ok.errors, []);
        assert.equal(ok.req.body.chatName, 'Team', 'trimmed, control characters stripped');

        for (const body of [
            {},
            { announcementOnly: 'yes' },
            { approveNewMembers: 1 },
            { chatName: '' },
            { chatName: 'x'.repeat(101) },
            { description: 'x'.repeat(501) },
            { description: 42 }
        ]) {
            const { errors } = await runValidation(v.validateGroupSettings, { params: { chatId: '10' }, body });
            assert.ok(errors.length > 0, JSON.stringify(body));
        }
        const badId = await runValidation(v.validateGroupSettings, { params: { chatId: 'abc' }, body: { announcementOnly: true } });
        assert.ok(badId.errors.length > 0);
    });

    test('invite options, codes, tags and leave', async () => {
        const v = load();
        assert.deepEqual((await runValidation(v.validateCreateInvite, { params: { chatId: '1' }, body: { expiresIn: '7d', maxUses: '10' } })).errors, []);
        assert.deepEqual((await runValidation(v.validateCreateInvite, { params: { chatId: '1' }, body: { maxUses: null } })).errors, []);
        for (const body of [{ expiresIn: '2d' }, { maxUses: 0 }, { maxUses: 1001 }, { maxUses: 'lots' }]) {
            assert.ok((await runValidation(v.validateCreateInvite, { params: { chatId: '1' }, body })).errors.length > 0, JSON.stringify(body));
        }

        assert.deepEqual((await runValidation(v.validateInviteCode, { params: { code: 'abcDEF123_-abcDEF123_-' } })).errors, []);
        for (const code of ['short', 'x'.repeat(23), 'abcDEF123_-abcDEF123_!', '../../etc/passwd']) {
            const { errors } = await runValidation(v.validateInviteCode, { params: { code } });
            assert.ok(errors.length > 0, code);
            assert.match(errors[0].msg, /invalid/);
        }

        const tag = await runValidation(v.validateMemberTag, { params: { chatId: '1', userId: '2' }, body: { tag: ' Lead ' } });
        assert.deepEqual(tag.errors, []);
        assert.equal(tag.req.body.tag, 'Lead');
        assert.deepEqual((await runValidation(v.validateMemberTag, { params: { chatId: '1', userId: '2' }, body: { tag: null } })).errors, []);
        assert.ok((await runValidation(v.validateMemberTag, { params: { chatId: '1', userId: '2' }, body: { tag: 'x'.repeat(31) } })).errors.length > 0);
        assert.ok((await runValidation(v.validateMemberTag, { params: { chatId: '1', userId: '2' }, body: {} })).errors.length > 0);

        assert.deepEqual((await runValidation(v.validateLeaveGroup, { params: { chatId: '1' }, body: {} })).errors, []);
        assert.ok((await runValidation(v.validateLeaveGroup, { params: { chatId: '1' }, body: { newAdminId: 'me' } })).errors.length > 0);
    });
});

describe('invite statuses', () => {
    const { inviteStatus } = setupFakeDb('mysql', () => []).load('utils/invites.js');

    test('revoked beats expired beats used up', () => {
        assert.equal(inviteStatus({ revoked_at: 'x', is_expired: 1, max_uses: 1, use_count: 1 }), 'revoked');
        assert.equal(inviteStatus({ revoked_at: null, is_expired: 1, max_uses: 1, use_count: 1 }), 'expired');
        assert.equal(inviteStatus({ revoked_at: null, is_expired: '1', max_uses: null, use_count: 0 }), 'expired', 'a driver that returns the CASE as a string');
        assert.equal(inviteStatus({ revoked_at: null, is_expired: 0, max_uses: 3, use_count: 3 }), 'used_up');
        assert.equal(inviteStatus({ revoked_at: null, is_expired: 0, max_uses: null, use_count: 999 }), 'active');
    });
});

describe('group avatars', () => {
    const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

    test('the type comes from the bytes, not the name or mime type', () => {
        const { detectImageType } = setupFakeDb('mysql', () => []).load('utils/groupAvatar.js');
        assert.equal(detectImageType(PNG_1PX), 'image/png');
        assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
        assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')), 'image/webp');
        assert.equal(detectImageType(Buffer.from('<html><script>alert(1)</script></html>')), null);
        assert.equal(detectImageType(Buffer.from('GIF89a......')), null);
    });

    test('a valid image is stored under a random name (resized to 256x256 WebP when sharp is installed); the old one is deleted', async () => {
        const fake = setupFakeDb('mysql', () => []);
        const { saveGroupAvatar, deleteGroupAvatar, isSharpAvailable } = fake.load('utils/groupAvatar.js');
        const { UPLOAD_DIR } = fake.load('utils/uploads.js');

        const saved = await saveGroupAvatar(PNG_1PX);
        assert.ok(!saved.error, saved.error);
        assert.match(saved.avatarUrl, /^uploads\/group-avatars\/[a-f0-9]{32}\.(webp|png)$/);
        const file = path.join(UPLOAD_DIR, 'group-avatars', path.basename(saved.avatarUrl));
        assert.ok(fs.existsSync(file));

        if (isSharpAvailable()) {
            assert.equal(saved.resized, true);
            const meta = await require('sharp')(fs.readFileSync(file)).metadata();
            assert.equal(meta.format, 'webp');
            assert.equal(meta.width, 256);
            assert.equal(meta.height, 256);
        }

        await deleteGroupAvatar(saved.avatarUrl);
        assert.ok(!fs.existsSync(file));
    });

    test('non-images are refused and deletion never leaves the avatar folder', async () => {
        const { saveGroupAvatar, deleteGroupAvatar } = setupFakeDb('mysql', () => []).load('utils/groupAvatar.js');
        const refused = await saveGroupAvatar(Buffer.from('<svg onload="alert(1)"></svg>      '));
        assert.match(refused.error, /JPEG, PNG or WebP/);

        // Must not throw or touch anything
        await deleteGroupAvatar('uploads/group-avatars/../../server.js');
        await deleteGroupAvatar('/etc/passwd');
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'server.js')));
    });
});
