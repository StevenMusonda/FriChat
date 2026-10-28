/**
 * Phase 5: invite links, join approval, group settings, announcement-only mode,
 * leaving as the last admin, member tags and group avatars, plus the phase 6 follow-ups: bans,
 * admin rights, join-request limits and decision pushes, email verification gates, blocking
 * and socket rate limits (both fake drivers).
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
        bans: [], // { chat_id, user_id, banned_by }
        blocks: [], // { blocker_id, blocked_id }
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

        // --- bans and blocks (phase 6) ---
        if (/^SELECT id FROM group_bans WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            const i = world.bans.findIndex(b => b.chat_id === Number(params[0]) && b.user_id === Number(params[1]));
            return i === -1 ? [] : [{ id: i + 1 }];
        }
        if (/^INSERT INTO group_bans \(chat_id, user_id, banned_by\) VALUES \(\?, \?, \?\)$/.test(sql)) {
            world.bans.push({ chat_id: Number(params[0]), user_id: Number(params[1]), banned_by: params[2] });
            return inserted(world.bans.length);
        }
        if (/^DELETE FROM group_bans WHERE id = \?$/.test(sql)) {
            world.bans.splice(Number(params[0]) - 1, 1);
            return written(1);
        }
        if (/^SELECT b.user_id, b.created_at, u.username, u.full_name, u.avatar_url, by_user.username AS banned_by_username FROM group_bans b/.test(sql)) {
            return world.bans.filter(b => b.chat_id === Number(params[0]))
                .map(b => ({ user_id: b.user_id, created_at: 'now', username: USERS[b.user_id], full_name: null, avatar_url: null, banned_by_username: USERS[b.banned_by] }));
        }
        if (/^DELETE FROM chat_join_requests WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            for (const [id, r] of Object.entries(world.requests)) {
                if (r.chat_id === Number(params[0]) && r.user_id === Number(params[1])) delete world.requests[id];
            }
            return written(1);
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE blocked_id = \?$/.test(sql)) {
            return world.blocks.filter(b => b.blocked_id === Number(params[0])).map(b => ({ blocker_id: b.blocker_id }));
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE blocked_id = \? AND blocker_id IN/.test(sql)) {
            const candidates = params.slice(1).map(Number);
            return world.blocks.filter(b => b.blocked_id === Number(params[0]) && candidates.includes(b.blocker_id)).map(b => ({ blocker_id: b.blocker_id }));
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE \(blocker_id = \? AND blocked_id = \?\) OR \(blocker_id = \? AND blocked_id = \?\) LIMIT 1$/.test(sql)) {
            const [a, b] = [Number(params[0]), Number(params[1])];
            const row = world.blocks.find(x => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
            return row ? [{ blocker_id: row.blocker_id }] : [];
        }
        if (/^SELECT ub.blocker_id FROM chats c JOIN group_members gm ON gm.chat_id = c.id AND gm.user_id <> \? JOIN user_blocks ub/.test(sql)) {
            const [userId, chatId] = [Number(params[0]), Number(params[3])];
            if (world.chats[chatId].chat_type !== 'direct') return [];
            const others = world.members.filter(m => m.chat_id === chatId && m.user_id !== userId).map(m => m.user_id);
            const row = world.blocks.find(x => (x.blocked_id === userId && others.includes(x.blocker_id)) || (x.blocker_id === userId && others.includes(x.blocked_id)));
            return row ? [{ blocker_id: row.blocker_id }] : [];
        }
        if (/^SELECT chat_id FROM group_members WHERE user_id = \?$/.test(sql)) {
            return world.members.filter(m => m.user_id === Number(params[0])).map(m => ({ chat_id: m.chat_id }));
        }
        if (/^SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = \? OR blocked_id = \?$/.test(sql)) {
            return world.blocks.filter(b => b.blocker_id === Number(params[0]) || b.blocked_id === Number(params[1])).map(b => ({ ...b }));
        }
        if (/^SELECT a.chat_id FROM group_members a JOIN group_members b ON b.chat_id = a.chat_id WHERE a.user_id = \? AND b.user_id = \? LIMIT 1$/.test(sql)) {
            const shared = world.members.find(a => a.user_id === Number(params[0]) && world.members.some(b => b.chat_id === a.chat_id && b.user_id === Number(params[1])));
            return shared ? [{ chat_id: shared.chat_id }] : [];
        }
        if (/^SELECT c.id FROM chats c JOIN group_members gm1 ON c.id = gm1.chat_id JOIN group_members gm2 ON c.id = gm2.chat_id WHERE c.chat_type = 'direct' AND gm1.user_id = \? AND gm2.user_id = \?$/.test(sql)) {
            const chat = Object.values(world.chats).find(c => c.chat_type === 'direct' && member(c.id, params[0]) && member(c.id, params[1]));
            return chat ? [{ id: chat.id }] : [];
        }
        if (/^INSERT INTO chats \(chat_type, chat_name, created_by\) VALUES \(\?, \?, \?\)( RETURNING id)?$/.test(sql)) {
            const id = ++world.nextId;
            world.chats[id] = { id, chat_type: params[0], chat_name: params[1], description: null, avatar_url: null, approve_new_members: false, announcement_only: false };
            world.chatsCreated = (world.chatsCreated || 0) + 1;
            return inserted(id);
        }
        if (/^INSERT INTO group_members \(chat_id, user_id, role\) VALUES \(\?, \?, \?\)$/.test(sql)) {
            const id = ++world.nextId;
            world.members.push({ id, chat_id: Number(params[0]), user_id: Number(params[1]), role: params[2], joined_at: id, member_tag: null });
            return inserted(id);
        }
        if (/^SELECT m.id, m.chat_id FROM messages m JOIN group_members gm ON m.chat_id = gm.chat_id WHERE m.id = \? AND gm.user_id = \?$/.test(sql)) {
            const chatId = (world.messages || {})[params[0]];
            return chatId && member(chatId, params[1]) ? [{ id: Number(params[0]), chat_id: chatId }] : [];
        }
        if (/^UPDATE group_members SET role = 'member' WHERE chat_id = \? AND user_id = \? AND role = 'admin' AND \(SELECT other_admins.n FROM \(SELECT COUNT\(\*\) AS n FROM group_members WHERE chat_id = \? AND role = 'admin' AND user_id <> \?\) AS other_admins\) > 0( RETURNING id)?$/.test(sql)) {
            const m = member(params[0], params[1]);
            const others = world.members.filter(x => x.chat_id === Number(params[0]) && x.role === 'admin' && x.user_id !== Number(params[1])).length;
            const ok = !!m && m.role === 'admin' && others > 0;
            if (ok) m.role = 'member';
            return written(ok ? 1 : 0);
        }

        // --- join requests ---
        if (/^SELECT status, CASE WHEN decided_at IS NOT NULL AND decided_at > .+ THEN 1 ELSE 0 END AS in_cooldown FROM chat_join_requests WHERE chat_id = \? AND user_id = \?$/.test(sql)) {
            assert.equal(params[0], 24);
            const r = Object.values(world.requests).find(x => x.chat_id === Number(params[1]) && x.user_id === Number(params[2]));
            return r ? [{ status: r.status, in_cooldown: r.status === 'declined' && !r.longAgo ? 1 : 0 }] : [];
        }
        if (/^SELECT COUNT\(\*\) AS count FROM chat_join_requests WHERE user_id = \? AND status = 'pending'$/.test(sql)) {
            return [{ count: Object.values(world.requests).filter(r => r.user_id === Number(params[0]) && r.status === 'pending').length + (world.extraPendingElsewhere || 0) }];
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
    await handler({ params: {}, body: {}, query: {}, ...req, user: { id: ADMIN, username: 'alice', email_verified_at: '2026-10-01 00:00:00', ...(req.user || {}) }, io }, res);
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
                memberCount: 3, approvalRequired: false, joinState: 'none', canRequestAgain: true, emailVerified: true
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

        test('declining notifies the requester and keeps them out; they may ask again after 24 hours', async () => {
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
            assert.equal(state.res.body.data.canRequestAgain, false);

            // Within 24 hours of the decline: refused, and the link isn't used up by the attempt
            const usesBefore = Object.values(fake.world.invites)[0].use_count;
            const tooSoon = await call(controller.joinWithInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(tooSoon.res.statusCode, 429);
            assert.equal(tooSoon.res.body.code, 'DECLINED_RECENTLY');
            assert.equal(Object.values(fake.world.invites)[0].use_count, usesBefore);

            fake.world.requests[requestId].longAgo = true;
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

// ===== Phase 6: bans, admin rights, join-request limits, join-decision pushes, email verification, blocks =====

/**
 * server.js against this world, with one fake socket for userId (records broadcasts and except() lists)
 */
async function connectSocket(fake, userId, rooms = []) {
    process.env.PORT = '0';
    stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });
    const log = console.log;
    console.log = () => {};
    const { io } = fake.load('server.js');
    const recorder = fakeIo();
    io.to = recorder.to;

    const handlers = {};
    const sent = [];
    const broadcasts = [];
    const target = (room, except = []) => ({
        except: (rooms2) => target(room, [...except, ...rooms2]),
        emit: (event, data) => broadcasts.push({ room, except, event, data })
    });
    const socket = {
        id: `socket-${userId}`, userId, username: USERS[userId], sessionId: 7, data: {},
        rooms: new Set(rooms),
        join(room) { this.rooms.add(room); },
        on(event, fn) { handlers[event] = fn; },
        emit(event, payload) { sent.push({ event, payload }); },
        to: (room) => target(room),
        broadcast: target('*'),
        disconnect() { socket.disconnected = true; }
    };
    io.sockets.listeners('connection')[0](socket);
    const close = async () => {
        await new Promise(resolve => io.close(() => resolve()));
        console.log = log;
    };
    return { socket, handlers, sent, broadcasts, recorder, close };
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`group bans (${dbType})`, () => {
        test('Remove and ban: gone from the group, no rejoining by link or by an admin until unbanned', async () => {
            const fake = setup(dbType);
            const chats = fake.load('controllers/chatController.js');
            const groupController = fake.load('controllers/groupController.js');
            const inviteController = fake.load('controllers/inviteController.js');
            const { res: created } = await call(groupController.createInvite, { params: { chatId: GROUP }, body: {} });
            const code = created.body.data.code;

            const removed = await call(chats.removeMember, { params: { chatId: GROUP, userId: BOB }, query: { ban: 'true' } });
            assert.equal(removed.res.statusCode, 200);
            assert.equal(removed.res.body.data.banned, true);
            assert.ok(!fake.world.member(GROUP, BOB));
            assert.deepEqual(fake.world.bans, [{ chat_id: GROUP, user_id: BOB, banned_by: ADMIN }]);
            assert.ok(removed.io.emitted.some(e => e.event === 'group_left' && e.room === `user_${BOB}`));

            const preview = await call(inviteController.previewInvite, { params: { code }, user: { id: BOB } });
            assert.equal(preview.res.body.data.joinState, 'banned');

            const join = await call(inviteController.joinWithInvite, { params: { code }, user: { id: BOB } });
            assert.equal(join.res.statusCode, 403);
            assert.equal(join.res.body.code, 'BANNED');
            assert.equal(Object.values(fake.world.invites)[0].use_count, 0, 'a refused join does not use the link');

            const add = await call(chats.addMember, { params: { chatId: GROUP }, body: { userId: BOB } });
            assert.equal(add.res.statusCode, 403);
            assert.equal(add.res.body.code, 'BANNED');
            assert.ok(!fake.world.member(GROUP, BOB));

            // Only admins see and lift bans
            const asMember = await call(groupController.listBans, { params: { chatId: GROUP }, user: { id: CAROL } });
            assert.equal(asMember.res.statusCode, 403);
            const list = await call(groupController.listBans, { params: { chatId: GROUP } });
            assert.deepEqual(list.res.body.data.map(b => [b.userId, b.username, b.bannedBy]), [[BOB, 'bob', 'alice']]);
            const memberUnban = await call(groupController.unbanMember, { params: { chatId: GROUP, userId: BOB }, user: { id: CAROL } });
            assert.equal(memberUnban.res.statusCode, 403);

            const unban = await call(groupController.unbanMember, { params: { chatId: GROUP, userId: BOB } });
            assert.equal(unban.res.statusCode, 200);
            const again = await call(inviteController.joinWithInvite, { params: { code }, user: { id: BOB } });
            assert.equal(again.res.statusCode, 201);
            assert.ok(fake.world.member(GROUP, BOB));
            assert.equal((await call(groupController.unbanMember, { params: { chatId: GROUP, userId: BOB } })).res.statusCode, 404);
        });

        test('a plain remove does not ban, admins cannot ban themselves, and a banned requester cannot be approved', async () => {
            const fake = setup(dbType);
            const chats = fake.load('controllers/chatController.js');
            const groupController = fake.load('controllers/groupController.js');

            const plain = await call(chats.removeMember, { params: { chatId: GROUP, userId: CAROL }, query: {} });
            assert.equal(plain.res.statusCode, 200);
            assert.equal(fake.world.bans.length, 0);

            const self = await call(chats.removeMember, { params: { chatId: GROUP, userId: ADMIN }, query: { ban: 'true' } });
            assert.equal(self.res.statusCode, 400);
            assert.ok(fake.world.member(GROUP, ADMIN));

            fake.world.requests[901] = { id: 901, chat_id: GROUP, user_id: DAVE, status: 'pending' };
            fake.world.bans.push({ chat_id: GROUP, user_id: DAVE, banned_by: ADMIN });
            const approve = await call(groupController.approveJoinRequest, { params: { chatId: GROUP, requestId: 901 } });
            assert.equal(approve.res.statusCode, 409);
            assert.equal(approve.res.body.code, 'BANNED');
            assert.ok(!fake.world.member(GROUP, DAVE));
            assert.equal(fake.world.requests[901].status, 'pending');
        });
    });

    describe(`admin rights (${dbType})`, () => {
        test('admins promote and demote; the change reaches the members panel', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');

            const promote = await call(groupController.setMemberRole, { params: { chatId: GROUP, userId: BOB }, body: { role: 'admin' } });
            assert.equal(promote.res.statusCode, 200);
            assert.equal(fake.world.member(GROUP, BOB).role, 'admin');
            assert.ok(promote.io.emitted.some(e => e.event === 'group_members_updated' && e.room === `chat_${GROUP}`));

            // The new admin removes the old admin's rights; the group still has one
            const demote = await call(groupController.setMemberRole, { params: { chatId: GROUP, userId: ADMIN }, body: { role: 'member' }, user: { id: BOB } });
            assert.equal(demote.res.statusCode, 200);
            assert.equal(fake.world.member(GROUP, ADMIN).role, 'member');

            // Members can't change roles
            const asMember = await call(groupController.setMemberRole, { params: { chatId: GROUP, userId: CAROL }, body: { role: 'admin' } });
            assert.equal(asMember.res.statusCode, 403);
            assert.equal(fake.world.member(GROUP, CAROL).role, 'member');
        });

        test('a group always keeps at least one admin', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');

            const selfDemote = await call(groupController.setMemberRole, { params: { chatId: GROUP, userId: ADMIN }, body: { role: 'member' } });
            assert.equal(selfDemote.res.statusCode, 409);
            assert.equal(selfDemote.res.body.code, 'LAST_ADMIN');
            assert.equal(fake.world.member(GROUP, ADMIN).role, 'admin');

            const missing = await call(groupController.setMemberRole, { params: { chatId: GROUP, userId: DAVE }, body: { role: 'admin' } });
            assert.equal(missing.res.statusCode, 404);

            const unchanged = await call(groupController.setMemberRole, { params: { chatId: GROUP, userId: BOB }, body: { role: 'member' } });
            assert.equal(unchanged.res.statusCode, 200);
            assert.equal(unchanged.io.emitted.length, 0, 'nothing changed, nothing broadcast');
        });
    });

    describe(`join request limits and decision pushes (${dbType})`, () => {
        test('at most 3 pending requests per user across all groups', async () => {
            const fake = setup(dbType);
            fake.world.chats[GROUP].approve_new_members = true;
            const groupController = fake.load('controllers/groupController.js');
            const inviteController = fake.load('controllers/inviteController.js');
            const { res: created } = await call(groupController.createInvite, { params: { chatId: GROUP }, body: {} });
            const code = created.body.data.code;

            fake.world.extraPendingElsewhere = 3;
            const refused = await call(inviteController.joinWithInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(refused.res.statusCode, 429);
            assert.equal(refused.res.body.code, 'TOO_MANY_PENDING');
            assert.equal(Object.keys(fake.world.requests).length, 0);
            assert.equal(Object.values(fake.world.invites)[0].use_count, 0);

            fake.world.extraPendingElsewhere = 2;
            const accepted = await call(inviteController.joinWithInvite, { params: { code }, user: { id: DAVE } });
            assert.equal(accepted.res.statusCode, 202);
        });

        test('the requester gets a push when an admin approves or declines', async () => {
            const fake = setup(dbType);
            const pushes = [];
            stubModule('web-push', {
                setVapidDetails() {},
                async sendNotification(subscription, payload) { pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }); }
            });
            process.env.VAPID_PUBLIC_KEY = 'test-public';
            process.env.VAPID_PRIVATE_KEY = 'test-private';
            const base = fake.world.handler;
            fake.world.handler = (sql, params) => {
                const normalized = sql.replace(/\$\d+/g, '?');
                if (/^SELECT dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone FROM notification_settings WHERE user_id = \?$/.test(normalized)) return [];
                if (/^SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = \?$/.test(normalized)) {
                    return [{ id: 1, user_id: Number(params[0]), endpoint: `https://push.example/${params[0]}`, p256dh: 'k', auth: 'a' }];
                }
                return base(sql, params);
            };

            try {
                const groupController = fake.load('controllers/groupController.js');
                fake.world.requests[901] = { id: 901, chat_id: GROUP, user_id: DAVE, status: 'pending' };
                fake.world.requests[902] = { id: 902, chat_id: GROUP, user_id: 5, status: 'pending' };

                await call(groupController.approveJoinRequest, { params: { chatId: GROUP, requestId: 901 } });
                await call(groupController.declineJoinRequest, { params: { chatId: GROUP, requestId: 902 } });
                await new Promise(resolve => setImmediate(resolve)); // the push isn't awaited by the handler

                const approved = pushes.find(p => p.endpoint.endsWith(`/${DAVE}`));
                assert.equal(approved.payload.type, 'join_decision');
                assert.equal(approved.payload.status, 'approved');
                assert.equal(approved.payload.title, 'You joined Team');
                assert.equal(approved.payload.url, `chat.html?chat=${GROUP}`);

                const declined = pushes.find(p => p.endpoint.endsWith('/5'));
                assert.equal(declined.payload.status, 'declined');
                assert.equal(declined.payload.chatId, null);
            } finally {
                process.env.VAPID_PUBLIC_KEY = '';
                process.env.VAPID_PRIVATE_KEY = '';
            }
        });
    });

    describe(`unverified email (${dbType})`, () => {
        const UNVERIFIED = { email_verified_at: null };

        test('cannot create invite links or join groups by link', async () => {
            const fake = setup(dbType);
            const groupController = fake.load('controllers/groupController.js');
            const inviteController = fake.load('controllers/inviteController.js');

            const create = await call(groupController.createInvite, { params: { chatId: GROUP }, body: {}, user: UNVERIFIED });
            assert.equal(create.res.statusCode, 403);
            assert.equal(create.res.body.code, 'EMAIL_NOT_VERIFIED');
            assert.equal(Object.keys(fake.world.invites).length, 0);

            const { res: created } = await call(groupController.createInvite, { params: { chatId: GROUP }, body: {} });
            const code = created.body.data.code;
            const preview = await call(inviteController.previewInvite, { params: { code }, user: { id: DAVE, ...UNVERIFIED } });
            assert.equal(preview.res.body.data.emailVerified, false);

            const join = await call(inviteController.joinWithInvite, { params: { code }, user: { id: DAVE, ...UNVERIFIED } });
            assert.equal(join.res.statusCode, 403);
            assert.equal(join.res.body.code, 'EMAIL_NOT_VERIFIED');
            assert.ok(!fake.world.member(GROUP, DAVE));
            assert.equal(Object.values(fake.world.invites)[0].use_count, 0);
        });

        test('can message people they share a chat with, but not strangers', async () => {
            const fake = setup(dbType);
            const chats = fake.load('controllers/chatController.js');

            const stranger = await call(chats.createChat, { body: { chatType: 'direct', participants: [DAVE] }, user: UNVERIFIED });
            assert.equal(stranger.res.statusCode, 403);
            assert.equal(stranger.res.body.code, 'EMAIL_NOT_VERIFIED');
            assert.ok(!fake.world.chatsCreated);

            const groupWithStranger = await call(chats.createChat, { body: { chatType: 'group', chatName: 'x', participants: [CAROL, DAVE] }, user: UNVERIFIED });
            assert.equal(groupWithStranger.res.statusCode, 403);

            // Carol shares the group with the creator
            const known = await call(chats.createChat, { body: { chatType: 'direct', participants: [CAROL] }, user: UNVERIFIED });
            assert.equal(known.res.statusCode, 201);

            const addStranger = await call(chats.addMember, { params: { chatId: GROUP }, body: { userId: DAVE }, user: UNVERIFIED });
            assert.equal(addStranger.res.statusCode, 403);
            assert.ok(!fake.world.member(GROUP, DAVE));
        });
    });

    describe(`blocking (${dbType})`, () => {
        // Bob blocks Alice (ADMIN); they share DIRECT and GROUP
        function blockedWorld() {
            const fake = setup(dbType);
            fake.world.blocks.push({ blocker_id: BOB, blocked_id: ADMIN });
            return fake;
        }

        test('no direct messages in either direction; group posting is unaffected', async () => {
            const fake = blockedWorld();
            const { checkCanPost } = fake.load('utils/groups.js');

            const fromBlocked = await checkCanPost(DIRECT, ADMIN);
            assert.equal(fromBlocked.code, 'BLOCKED');
            assert.equal(fromBlocked.message, 'You can\'t send messages to this user.');

            const fromBlocker = await checkCanPost(DIRECT, BOB);
            assert.equal(fromBlocker.code, 'BLOCKED');
            assert.match(fromBlocker.message, /You blocked this user/);

            assert.equal(await checkCanPost(GROUP, ADMIN), null);
        });

        test('socket send_message, reactions and forwards into the direct chat are refused', async () => {
            const fake = blockedWorld();
            fake.world.messages = { 900: DIRECT, 77: GROUP };

            const reactions = fake.load('utils/reactions.js');
            const reaction = await reactions.toggleReaction(900, ADMIN, '👍');
            assert.equal(reaction.blocked, true);

            const { forwardMessages } = fake.load('controllers/messageController.js');
            const forward = await call(forwardMessages, { body: { messageIds: [77], chatIds: [DIRECT] } });
            assert.equal(forward.res.statusCode, 403);
            assert.equal(forward.res.body.code, 'BLOCKED');
            assert.equal(fake.world.messagesInserted, 0);

            const ws = await connectSocket(fake, ADMIN, [`chat_${DIRECT}`]);
            try {
                await ws.handlers.send_message({ chatId: DIRECT, messageType: 'text', content: 'hello?' });
            } finally {
                await ws.close();
            }
            const error = ws.sent.find(s => s.event === 'error');
            assert.equal(error.payload.code, 'BLOCKED');
            assert.equal(fake.world.messagesInserted, 0);
            assert.equal(ws.recorder.emitted.filter(e => e.event === 'new_message').length, 0);
        });

        test('no new direct chat, and the blocked user cannot add the blocker to groups', async () => {
            const fake = setup(dbType);
            fake.world.blocks.push({ blocker_id: DAVE, blocked_id: ADMIN });
            const chats = fake.load('controllers/chatController.js');

            const direct = await call(chats.createChat, { body: { chatType: 'direct', participants: [DAVE] } });
            assert.equal(direct.res.statusCode, 403);
            assert.equal(direct.res.body.code, 'BLOCKED');

            const group = await call(chats.createChat, { body: { chatType: 'group', chatName: 'Trap', participants: [CAROL, DAVE] } });
            assert.equal(group.res.statusCode, 403);
            assert.ok(!fake.world.chatsCreated);

            const add = await call(chats.addMember, { params: { chatId: GROUP }, body: { userId: DAVE } });
            assert.equal(add.res.statusCode, 403);
            assert.equal(add.res.body.code, 'BLOCKED');
            assert.ok(!fake.world.member(GROUP, DAVE));

            // The blocker can still add the person they blocked (their own choice)
            fake.world.members.push({ id: 99, chat_id: OTHER_GROUP, user_id: DAVE, role: 'admin', joined_at: 9, member_tag: null });
            const reverse = await call(chats.addMember, { params: { chatId: OTHER_GROUP }, body: { userId: ADMIN }, user: { id: DAVE } });
            assert.equal(reverse.res.statusCode, 200);
        });

        test('the blocker shows as offline and the direct chat composer is locked for the blocked user', async () => {
            const fake = blockedWorld();
            const { getChatById } = fake.load('controllers/chatController.js');

            const direct = await call(getChatById, { params: { chatId: DIRECT } });
            assert.equal(direct.res.body.data.can_post, false);
            assert.equal(direct.res.body.data.post_blocked_message, 'You can\'t send messages to this user.');
            assert.equal(direct.res.body.data.participants.find(p => p.id === BOB).status, 'offline');

            // Bob's view of Alice isn't masked
            const asBob = await call(getChatById, { params: { chatId: GROUP }, user: { id: BOB } });
            assert.equal(asBob.res.body.data.participants.find(p => p.id === ADMIN).status, 'online');
        });

        test('presence and typing of the blocker never reach the blocked user (sockets)', async () => {
            const fake = blockedWorld();
            const bob = await connectSocket(fake, BOB, [`chat_${GROUP}`]);
            try {
                await bob.handlers.authenticate();
                await bob.handlers.typing({ chatId: GROUP, isTyping: true });
            } finally {
                await bob.close();
            }
            const online = bob.broadcasts.find(b => b.event === 'user_status');
            assert.deepEqual(online.except, [`user_${ADMIN}`]);
            const typing = bob.broadcasts.find(b => b.event === 'user_typing');
            assert.equal(typing.room, `chat_${GROUP}`);
            assert.deepEqual(typing.except, [`user_${ADMIN}`]);
            assert.ok(bob.socket.rooms.has('session_7'), 'each socket joins its session room');

            // The blocked user's typing doesn't reach the blocker either
            const alice = await connectSocket(fake, ADMIN, [`chat_${GROUP}`]);
            try {
                await alice.handlers.typing({ chatId: GROUP, isTyping: true });
            } finally {
                await alice.close();
            }
            assert.deepEqual(alice.broadcasts.find(b => b.event === 'user_typing').except, [`user_${BOB}`]);
        });

        test('block and unblock endpoints', async () => {
            const fake = setup(dbType);
            const base = fake.world.handler;
            fake.world.handler = (sql, params) => {
                const normalized = sql.replace(/\$\d+/g, '?');
                if (/^SELECT id, username FROM users WHERE id = \?$/.test(normalized)) return USERS[params[0]] ? [{ id: Number(params[0]), username: USERS[params[0]] }] : [];
                if (/^SELECT status FROM users WHERE id = \?$/.test(normalized)) return [{ status: 'online' }];
                if (/^INSERT INTO user_blocks/.test(normalized)) {
                    if (fake.world.blocks.some(b => b.blocker_id === Number(params[0]) && b.blocked_id === Number(params[1]))) {
                        const error = new Error('duplicate');
                        error.code = dbType === 'postgresql' ? '23505' : 'ER_DUP_ENTRY';
                        throw error;
                    }
                    fake.world.blocks.push({ blocker_id: Number(params[0]), blocked_id: Number(params[1]) });
                    return dbType === 'postgresql' ? [{ id: 1 }] : { insertId: 1 };
                }
                if (/^SELECT id FROM user_blocks WHERE blocker_id = \? AND blocked_id = \?$/.test(normalized)) {
                    const i = fake.world.blocks.findIndex(b => b.blocker_id === Number(params[0]) && b.blocked_id === Number(params[1]));
                    return i === -1 ? [] : [{ id: i + 1 }];
                }
                if (/^DELETE FROM user_blocks WHERE id = \?$/.test(normalized)) {
                    fake.world.blocks.splice(Number(params[0]) - 1, 1);
                    return dbType === 'postgresql' ? [] : { affectedRows: 1 };
                }
                return base(sql, params);
            };
            const blocks = fake.load('controllers/blockController.js');

            assert.equal((await call(blocks.blockUser, { body: { userId: ADMIN } })).res.statusCode, 400);
            assert.equal((await call(blocks.blockUser, { body: { userId: 999 } })).res.statusCode, 404);

            const blocked = await call(blocks.blockUser, { body: { userId: BOB } });
            assert.equal(blocked.res.statusCode, 201);
            assert.deepEqual(fake.world.blocks, [{ blocker_id: ADMIN, blocked_id: BOB }]);
            // Bob's open tabs stop showing Alice as online right away
            assert.ok(blocked.io.emitted.some(e => e.room === `user_${BOB}` && e.event === 'user_status' && e.data.status === 'offline' && e.data.userId === ADMIN));
            assert.equal((await call(blocks.blockUser, { body: { userId: BOB } })).res.statusCode, 200, 'blocking twice is harmless');

            const unblocked = await call(blocks.unblockUser, { params: { userId: BOB } });
            assert.equal(unblocked.res.statusCode, 200);
            assert.ok(unblocked.io.emitted.some(e => e.room === `user_${BOB}` && e.event === 'user_status' && e.data.status === 'online'));
            assert.equal((await call(blocks.unblockUser, { params: { userId: BOB } })).res.statusCode, 404);
        });

        test('@mentions and pushes from a blocked sender skip the blocker', async () => {
            const fake = setup(dbType);
            const { resolveMentions } = fake.load('utils/mentions.js');
            await resolveMentions(GROUP, ADMIN, 'hi @bob');
            const query = fake.calls.find(c => /JOIN users u/.test(c.sql) && /LOWER\(u.username\)/.test(c.sql));
            assert.match(query.sql, /NOT EXISTS \(SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = gm.user_id AND ub.blocked_id = (\?|\$3)\)/);
            assert.deepEqual(query.params.slice(0, 3), [GROUP, ADMIN, ADMIN]);
        });
    });
}

describe('socket rate limiting (token buckets)', () => {
    const { createSocketRateLimiter, limitSocketEvents, TokenBucket } = require('../utils/socketRateLimit');
    const config = {
        groups: {
            message: { events: ['send_message'], perSocket: { capacity: 3, refillPerSecond: 1 }, perUser: { capacity: 5, refillPerSecond: 1 } },
            typing: { events: ['typing'], perSocket: { capacity: 1, refillPerSecond: 1 }, perUser: { capacity: 10, refillPerSecond: 1 }, silent: true }
        },
        abuse: { maxViolations: 4, violationWindowMs: 60000 }
    };

    function fakeSocket(userId) {
        const socket = { userId, emitted: [], handlers: {}, disconnected: false };
        socket.on = (event, fn) => { socket.handlers[event] = fn; };
        socket.emit = (event, data) => socket.emitted.push({ event, data });
        socket.disconnect = () => { socket.disconnected = true; };
        return socket;
    }

    test('a bucket allows a burst, then refills at its rate', () => {
        const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, 0);
        assert.equal(bucket.take(0), 0);
        assert.equal(bucket.take(0), 0);
        assert.equal(bucket.take(0), 1000);
        assert.equal(bucket.take(500), 500);
        assert.equal(bucket.take(1000), 0);
    });

    test('per socket: the burst passes, the next event is dropped with rate_limited, and time restores it', async () => {
        let now = 0;
        const limiter = createSocketRateLimiter(config, () => now);
        const socket = fakeSocket(1);
        const handled = [];
        limitSocketEvents(socket, limiter)('send_message', (data) => handled.push(data));

        for (let i = 0; i < 4; i++) socket.handlers.send_message(i);
        assert.deepEqual(handled, [0, 1, 2]);
        assert.deepEqual(socket.emitted, [{ event: 'rate_limited', data: { event: 'send_message', retryAfterMs: 1000 } }]);

        now = 1000;
        socket.handlers.send_message('later');
        assert.deepEqual(handled, [0, 1, 2, 'later']);
    });

    test('per user: all tabs share one budget', () => {
        const limiter = createSocketRateLimiter(config, () => 0);
        const a = fakeSocket(9);
        const b = fakeSocket(9);
        const other = fakeSocket(10);
        const results = [a, a, a, b, b, b].map(s => limiter.check(s, 'send_message').allowed);
        assert.deepEqual(results, [true, true, true, true, true, false], 'user bucket of 5 runs out on the sixth');
        assert.equal(limiter.check(other, 'send_message').allowed, true, 'other users are unaffected');
    });

    test('typing is dropped silently; a socket that keeps flooding is disconnected', () => {
        const limiter = createSocketRateLimiter(config, () => 0);
        const socket = fakeSocket(3);
        const on = limitSocketEvents(socket, limiter);
        on('typing', () => {});
        on('send_message', () => {});

        socket.handlers.typing();
        socket.handlers.typing();
        assert.equal(socket.emitted.length, 0);

        for (let i = 0; i < 6; i++) socket.handlers.send_message();
        assert.equal(socket.disconnected, true);
        assert.equal(socket.emitted.at(-1).data.disconnected, true);
    });

    test('server.js limits send_message per socket with the configured limits', async () => {
        const fake = setupFakeDb('mysql', () => []);
        const ws = await connectSocket({ load: fake.load }, 1, []);
        try {
            // An invalid type fails before any database work, so only the limiter is exercised
            for (let i = 0; i < 11; i++) await ws.handlers.send_message({ chatId: 1, messageType: 'nope' });
        } finally {
            await ws.close();
        }
        assert.equal(ws.sent.filter(s => s.event === 'error').length, 10);
        assert.equal(ws.sent.filter(s => s.event === 'rate_limited').length, 1);
    });
});

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
