/**
 * Phase 13 on both fake drivers, through the real server.js over HTTP where it matters: reports and
 * their evidence (which outlives the message), blocking with a report, the audit log (append-only
 * in the code, never able to fail an action), the admin console (403 on every route for non-admins),
 * suspensions, the spam limit for new accounts. Upload hardening runs on real files with the real
 * file-type and sharp, and a fake clamd speaking the INSTREAM protocol.
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { setupFakeDb, fakeIo, stubModule, listenForFetch } = require('./helpers/fakeDb');

const ALICE = 1;     // reporter, member of CHAT
const BOB = 2;       // reported, member of CHAT
const EVE = 3;       // shares nothing with anyone
const ADMIN = 4;
const CHAT = 5;
const SESSION = { [ALICE]: 11, [BOB]: 12, [EVE]: 13, [ADMIN]: 14 };

const BACKEND = path.join(__dirname, '..');

function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        pg,
        users: {
            [ALICE]: { id: ALICE, username: 'alice', email: 'a@x.io', is_admin: pg ? false : 0, suspended_at: null },
            [BOB]: { id: BOB, username: 'bob', email: 'b@x.io', is_admin: pg ? false : 0, suspended_at: null },
            [EVE]: { id: EVE, username: 'eve', email: 'e@x.io', is_admin: pg ? false : 0, suspended_at: null },
            [ADMIN]: { id: ADMIN, username: 'root', email: 'r@x.io', is_admin: pg ? true : 1, suspended_at: null }
        },
        members: { [CHAT]: new Set([ALICE, BOB]) },
        messages: [],
        deletedForMe: [],
        reports: [],
        evidence: [],
        audit: [],
        blocks: [],
        warnings: [],
        pushDeleted: [],
        scheduledCancelled: [],
        nextId: 1
    };
    for (let id = 1; id <= 30; id++) {
        world.messages.push({
            id, chat_id: CHAT, sender_id: id % 2 ? ALICE : BOB, message_type: 'text', content: `message ${id}`,
            created_at: new Date(2026, 0, 1, 0, id), deleted_for_everyone: false, expired: false, file_id: null
        });
    }

    const changed = (n) => (pg ? Array.from({ length: n }, () => ({ id: 1 })) : { affectedRows: n });
    const inserted = (id) => (pg ? [{ id }] : { insertId: id });

    function visibleTo(userId, m) {
        return !m.deleted_for_everyone && !m.expired
            && !world.deletedForMe.some(d => d.message_id === m.id && d.user_id === Number(userId));
    }

    function reportRow(r) {
        const reported = world.users[r.reported_user_id];
        return {
            ...r,
            reporter_username: world.users[r.reporter_id] ? world.users[r.reporter_id].username : null,
            reported_username: reported ? reported.username : null,
            reported_suspended_at: reported ? reported.suspended_at : null,
            reviewer_username: world.users[r.reviewed_by] ? world.users[r.reviewed_by].username : null
        };
    }

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        if (/^SELECT u\.id, u\.username, u\.email, .* FROM sessions s JOIN users u/.test(sql)) {
            assert.match(sql, /u\.suspended_at IS NULL/, 'suspended accounts must not pass the session check');
            const user = world.users[params[1]];
            return user && !user.suspended_at && SESSION[user.id] === params[0] ? [{ ...user, status: 'offline' }] : [];
        }
        if (/^UPDATE sessions SET last_active_at/.test(sql)) return changed(1);
        if (/^INSERT INTO sessions/.test(sql)) return inserted(SESSION[params[0]]);
        if (/^SELECT \* FROM users WHERE username = \? OR email = \?/.test(sql)) {
            const user = Object.values(world.users).find(u => u.username === params[0]);
            return user ? [{ ...user }] : [];
        }

        if (/^INSERT INTO audit_log/.test(sql)) {
            const [event, actor_id, target_type, target_id, ip_address, metadata] = params;
            const id = world.nextId++;
            world.audit.push({ id, event, actor_id, target_type, target_id, ip_address, metadata, created_at: new Date() });
            return inserted(id);
        }
        if (/FROM audit_log a LEFT JOIN users u/.test(sql)) {
            world.lastAuditParams = params;
            world.lastAuditSql = sql;
            return [...world.audit].reverse().map(a => ({ ...a, actor_username: null }));
        }

        // --- reports
        if (/^SELECT m\.id, m\.chat_id, m\.sender_id, m\.message_type FROM messages m JOIN group_members gm/.test(sql)) {
            const [userId, , messageId] = params;
            const m = world.messages.find(row => row.id === Number(messageId));
            if (!m || !world.members[m.chat_id].has(Number(userId)) || !visibleTo(userId, m)) return [];
            return [{ ...m }];
        }
        if (/^SELECT mine\.chat_id FROM group_members mine JOIN group_members other/.test(sql)) {
            const [mine, other] = params;
            return world.members[CHAT].has(Number(mine)) && world.members[CHAT].has(Number(other)) ? [{ chat_id: CHAT }] : [];
        }
        if (/^SELECT gm\.id, gm\.role, c\.chat_type/.test(sql)) {
            return world.members[params[0]] && world.members[params[0]].has(Number(params[1]))
                ? [{ id: 1, role: 'member', chat_type: 'group', announcement_only: false }] : [];
        }
        if (/^SELECT id FROM reports WHERE reporter_id = \? AND message_id = \?/.test(sql)) {
            return world.reports.filter(r => r.reporter_id === params[0] && r.message_id === params[1] && r.status === 'open');
        }
        if (/^SELECT id FROM reports WHERE reporter_id = \? AND reported_user_id = \?/.test(sql)) {
            return world.reports.filter(r => r.reporter_id === params[0] && r.reported_user_id === params[1] && r.target_type === 'user' && r.status === 'open');
        }
        if (/^SELECT m\.id, m\.sender_id, m\.message_type, m\.content, m\.created_at, u\.username/.test(sql)) {
            const [reporterId, chatId, cursor] = params;
            let rows = world.messages.filter(m => m.chat_id === Number(chatId) && visibleTo(reporterId, m));
            if (/m\.id < \?/.test(sql)) rows = rows.filter(m => m.id < cursor);
            if (/m\.id > \?/.test(sql)) rows = rows.filter(m => m.id > cursor);
            if (/m\.id = \?/.test(sql)) rows = rows.filter(m => m.id === cursor);
            rows = [...rows].sort((a, b) => (/ORDER BY m\.id DESC/.test(sql) ? b.id - a.id : a.id - b.id));
            const limit = Number(/LIMIT (\d+)/.exec(sql)[1]);
            return rows.slice(0, limit).map(m => ({ ...m, username: world.users[m.sender_id].username, original_name: null, mime_type: null, file_size: null, upload_path: null }));
        }
        if (/^INSERT INTO reports/.test(sql)) {
            const [reporter_id, reported_user_id, target_type, message_id, chat_id, reason, note] = params;
            const id = world.nextId++;
            world.reports.push({ id, reporter_id, reported_user_id, target_type, message_id, chat_id, reason, note, status: 'open', resolution: null, reviewed_by: null, reviewed_at: null, created_at: new Date() });
            return inserted(id);
        }
        if (/^INSERT INTO report_evidence/.test(sql)) {
            const columns = 13;
            for (let i = 0; i < params.length; i += columns) {
                const [report_id, position, is_reported, message_id, sender_id, sender_username, message_type, content, file_name, file_mime, file_size, evidence_path, sent_at] = params.slice(i, i + columns);
                world.evidence.push({ id: world.nextId++, report_id, position, is_reported, message_id, sender_id, sender_username, message_type, content, file_name, file_mime, file_size, evidence_path, sent_at });
            }
            return changed(params.length / columns);
        }
        if (/FROM reports r LEFT JOIN users reporter/.test(sql)) {
            if (/WHERE r\.id = \?/.test(sql)) return world.reports.filter(r => r.id === Number(params[0])).map(reportRow);
            return [...world.reports].reverse().map(reportRow);
        }
        if (/FROM report_evidence WHERE report_id = \?/.test(sql)) {
            return world.evidence.filter(e => e.report_id === Number(params[0])).sort((a, b) => a.position - b.position);
        }
        if (/^UPDATE reports SET status = \?/.test(sql)) {
            const r = world.reports.find(row => row.id === Number(params[3]));
            if (!r) return changed(0);
            Object.assign(r, { status: params[0], resolution: params[1], reviewed_by: params[2], reviewed_at: new Date() });
            return changed(1);
        }

        // --- blocks and presence
        if (/^INSERT INTO user_blocks/.test(sql)) {
            world.blocks.push({ blocker_id: params[0], blocked_id: params[1] });
            return inserted(world.nextId++);
        }
        if (/privacy_settings|message_requests|user_blocks/.test(sql)) return [];

        // --- moderation
        if (/^SELECT id, is_admin, suspended_at FROM users WHERE id = \?/.test(sql) || /^SELECT id FROM users WHERE id = \?/.test(sql)) {
            const user = world.users[params[0]];
            return user ? [{ ...user }] : [];
        }
        if (/^UPDATE users SET suspended_at = CURRENT_TIMESTAMP/.test(sql)) {
            const user = world.users[params[1]];
            if (!user || user.suspended_at) return changed(0);
            user.suspended_at = new Date();
            user.suspended_reason = params[0];
            return changed(1);
        }
        if (/^UPDATE users SET suspended_at = NULL/.test(sql)) {
            const user = world.users[params[0]];
            if (!user || !user.suspended_at) return changed(0);
            user.suspended_at = null;
            return changed(1);
        }
        if (/^SELECT id FROM sessions WHERE user_id = \?/.test(sql)) return [{ id: SESSION[params[0]] }];
        if (/^UPDATE sessions SET revoked_at/.test(sql)) return changed(1);
        if (/^DELETE FROM push_subscriptions/.test(sql)) { world.pushDeleted.push(params[0]); return changed(1); }
        if (/^UPDATE scheduled_messages SET status = 'cancelled'/.test(sql)) { world.scheduledCancelled.push(params[0]); return changed(1); }
        if (/^INSERT INTO user_warnings/.test(sql)) {
            const id = world.nextId++;
            world.warnings.push({ id, user_id: params[0], admin_id: params[1], report_id: params[2], message: params[3], acknowledged_at: null });
            return inserted(id);
        }
        if (/^SELECT id, message, created_at FROM user_warnings/.test(sql)) {
            return world.warnings.filter(w => w.user_id === params[0] && !w.acknowledged_at);
        }
        if (/^UPDATE user_warnings SET acknowledged_at/.test(sql)) {
            const w = world.warnings.find(row => row.id === Number(params[0]) && row.user_id === params[1] && !row.acknowledged_at);
            if (w) w.acknowledged_at = new Date();
            return changed(w ? 1 : 0);
        }
        if (/^SELECT id, chat_id, file_id, deleted_for_everyone FROM messages WHERE id = \?/.test(sql)) {
            const m = world.messages.find(row => row.id === Number(params[0]));
            return m ? [{ ...m }] : [];
        }
        if (/^UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = \?, deleted_for_everyone = TRUE, file_id = NULL/.test(sql)) {
            const m = world.messages.find(row => row.id === Number(params[1]));
            m.deleted_for_everyone = true;
            m.file_id = null;
            return changed(1);
        }
        if (/^SELECT original_name FROM files WHERE stored_name = \?/.test(sql)) {
            return params[0] === 'report-probe.pdf' ? [{ original_name: 'résumé "final".pdf' }] : [];
        }
        if (/^UPDATE users SET status/.test(sql) || /^UPDATE users SET last_seen/.test(sql)) return changed(1);
        return pg ? [] : [];
    };
    return world;
}

async function startApp(dbType) {
    process.env.PORT = '0';
    process.env.JWT_SECRET = 'test-secret';
    const world = createWorld(dbType);
    const fake = setupFakeDb(dbType, world.handler);
    stubModule(path.join(BACKEND, 'utils', 'scheduler.js'), { startScheduler() {} });

    const log = console.log;
    console.log = () => {};
    const { app, io } = fake.load('server.js');
    const server = await listenForFetch(app);
    const port = server.address().port;

    async function request(method, urlPath, { as, body } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (as) headers.Authorization = `Bearer ${jwt.sign({ userId: as, username: world.users[as].username, sid: SESSION[as] }, 'test-secret')}`;
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (error) { /* a file */ }
        return { status: res.status, body: json, text, headers: res.headers };
    }

    async function stop() {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => io.close(() => resolve()));
        console.log = log;
    }
    return { world, fake, request, stop, port };
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`reports (${dbType})`, () => {
        let ctx;
        beforeEach(async () => { ctx = await startApp(dbType); }); // a clean world, and a fresh 10-an-hour limiter
        afterEach(async () => { await ctx.stop(); });
        const report = (as, body) => ctx.request('POST', '/api/reports', { as, body: { reason: 'harassment', ...body } });

        test('a message report stores the message and 5 on each side, oldest first', async () => {
            const res = await report(ALICE, { targetType: 'message', messageId: 16, note: 'keeps insulting me' });
            assert.equal(res.status, 201);
            assert.deepEqual(ctx.world.evidence.map(e => e.message_id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
            assert.deepEqual(ctx.world.evidence.filter(e => e.is_reported).map(e => e.message_id), [16]);
            assert.equal(ctx.world.evidence[5].content, 'message 16');
            assert.equal(ctx.world.evidence[5].sender_username, 'bob');
            assert.equal(ctx.world.reports[0].reported_user_id, BOB);
        });

        test('near the end of a chat the other side makes up the 10', async () => {
            await report(ALICE, { targetType: 'message', messageId: 30 });
            assert.deepEqual(ctx.world.evidence.map(e => e.message_id), [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
        });

        test('evidence only holds what the reporter could see', async () => {
            ctx.world.deletedForMe.push({ message_id: 15, user_id: ALICE });
            ctx.world.messages[16].deleted_for_everyone = true; // id 17
            ctx.world.messages[17].expired = true; // id 18
            await report(ALICE, { targetType: 'message', messageId: 16 });
            const ids = ctx.world.evidence.map(e => e.message_id);
            for (const hidden of [15, 17, 18]) assert.ok(!ids.includes(hidden), `message ${hidden} must not be copied`);
            assert.ok(ids.includes(16));
        });

        test('deleting and expiring messages leaves the evidence, and the admin still reads it', async () => {
            const { body } = await report(ALICE, { targetType: 'message', messageId: 16 });
            ctx.world.messages = ctx.world.messages.filter(m => m.id !== 16 && m.id !== 15);

            const res = await ctx.request('GET', `/api/admin/reports/${body.data.reportId}`, { as: ADMIN });
            assert.equal(res.status, 200);
            const reported = res.body.data.evidence.find(e => e.isReported);
            assert.equal(reported.messageId, 16);
            assert.equal(reported.content, 'message 16');
            assert.equal(res.body.data.evidence.length, 11);
        });

        test('outsiders, own messages, deleted messages and notices are refused', async () => {
            assert.equal((await report(EVE, { targetType: 'message', messageId: 16 })).status, 404);
            assert.equal((await report(BOB, { targetType: 'message', messageId: 16 })).status, 400, 'own message');
            assert.equal((await report(ALICE, { targetType: 'message', messageId: 9999 })).status, 404);
            ctx.world.messages[15].deleted_for_everyone = true;
            assert.equal((await report(ALICE, { targetType: 'message', messageId: 16 })).status, 404);
            ctx.world.messages[15].deleted_for_everyone = false;
            ctx.world.messages[15].message_type = 'system';
            assert.equal((await report(ALICE, { targetType: 'message', messageId: 16 })).status, 400);
            ctx.world.messages[15].message_type = 'text';
            assert.equal(ctx.world.reports.length, 0);
        });

        test('user reports: shared chat required, optional chat evidence, never yourself', async () => {
            assert.equal((await report(ALICE, { targetType: 'user', userId: ALICE })).status, 400);
            assert.equal((await report(EVE, { targetType: 'user', userId: BOB })).status, 404);
            assert.equal((await report(ALICE, { targetType: 'user', userId: BOB, chatId: 999 })).status, 404);

            const res = await report(ALICE, { targetType: 'user', userId: BOB, chatId: CHAT });
            assert.equal(res.status, 201);
            assert.deepEqual(ctx.world.evidence.map(e => e.message_id), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
        });

        test('reporting again while open returns the first report, without new evidence or audit', async () => {
            const first = await report(ALICE, { targetType: 'message', messageId: 16 });
            const second = await report(ALICE, { targetType: 'message', messageId: 16 });
            assert.equal(second.status, 200);
            assert.equal(second.body.data.reportId, first.body.data.reportId);
            assert.equal(ctx.world.reports.length, 1);
            assert.equal(ctx.world.audit.filter(a => a.event === 'report_filed').length, 1);
        });

        test('block: true blocks the sender with the report', async () => {
            const res = await report(ALICE, { targetType: 'message', messageId: 16, block: true });
            assert.equal(res.body.data.blocked, true);
            assert.deepEqual(ctx.world.blocks, [{ blocker_id: ALICE, blocked_id: BOB }]);
        });

        test('the audit entry names the report and never the note', async () => {
            await report(ALICE, { targetType: 'message', messageId: 16, note: 'private note text' });
            const entry = ctx.world.audit.find(a => a.event === 'report_filed');
            assert.equal(entry.actor_id, ALICE);
            assert.equal(entry.target_type, 'report');
            assert.ok(entry.ip_address);
            assert.ok(!entry.metadata.includes('private note'));
        });

        test('validation: reason, target and note length', async () => {
            assert.equal((await report(ALICE, { targetType: 'message', messageId: 16, reason: 'because' })).status, 400);
            assert.equal((await report(ALICE, { targetType: 'message' })).status, 400);
            assert.equal((await report(ALICE, { targetType: 'chat', messageId: 16 })).status, 400);
            assert.equal((await report(ALICE, { targetType: 'user', userId: BOB, note: 'x'.repeat(501) })).status, 400);
            assert.equal((await report(ALICE, { targetType: 'user', userId: BOB, block: 'yes' })).status, 400);
            assert.equal((await ctx.request('POST', '/api/reports', { body: { reason: 'spam', targetType: 'user', userId: BOB } })).status, 401);
        });
    });

    describe(`admin console (${dbType})`, () => {
        let ctx;
        before(async () => { ctx = await startApp(dbType); });
        after(async () => { await ctx.stop(); });

        function adminRoutes() {
            const router = ctx.fake.load('routes/admin.js');
            return router.stack.filter(layer => layer.route).map((layer) => ({
                method: Object.keys(layer.route.methods)[0].toUpperCase(),
                url: `/api/admin${layer.route.path}`.replace(':reportId', '1').replace(':evidenceId', '1').replace(':userId', String(BOB))
            }));
        }

        test('every admin route: 401 signed out, 403 for a non-admin', async () => {
            const routes = adminRoutes();
            assert.ok(routes.length >= 13, `found ${routes.length} routes`);
            for (const { method, url } of routes) {
                assert.equal((await ctx.request(method, url)).status, 401, `${method} ${url} signed out`);
                const res = await ctx.request(method, url, { as: ALICE, body: method === 'POST' ? { message: 'x' } : undefined });
                assert.equal(res.status, 403, `${method} ${url} as non-admin`);
            }
            assert.equal(ctx.world.users[BOB].suspended_at, null, 'nothing happened');
        });

        test('an unknown path under /api/admin is 403 too', async () => {
            assert.equal((await ctx.request('GET', '/api/admin/anything', { as: ALICE })).status, 403);
        });

        test('sending is_admin to profile updates changes nothing, and no API code writes it', async () => {
            await ctx.request('PUT', '/api/users/me/profile', { as: ALICE, body: { displayName: 'A', is_admin: true, isAdmin: true } });
            assert.ok(!ctx.fake.calls.some(call => /UPDATE users .*is_admin/i.test(call.sql)));

            const offenders = sourceFiles().filter(file => !file.endsWith('set-admin.js'))
                .filter(file => /SET[^`'"]*is_admin\s*=/i.test(fs.readFileSync(file, 'utf8')));
            assert.deepEqual(offenders, []);
        });

        test('suspending from a report: session and sockets gone, login refused, audited', async () => {
            const io = fakeIo();
            io.in = (room) => ({ disconnectSockets() { io.emitted.push({ room, event: 'disconnect' }); } });
            const moderation = ctx.fake.load('utils/moderation.js');

            const result = await moderation.suspendUser(io, BOB, 'abuse');
            assert.equal(result.revokedSessions, 1);
            assert.ok(ctx.world.users[BOB].suspended_at);
            assert.ok(io.emitted.some(e => e.room === `session_${SESSION[BOB]}` && e.event === 'session_revoked' && e.data.reason === 'suspended'));
            assert.ok(io.emitted.some(e => e.room === `session_${SESSION[BOB]}` && e.event === 'disconnect'));
            assert.ok(io.emitted.some(e => e.room === `user_${BOB}` && e.event === 'disconnect'));
            assert.deepEqual(ctx.world.pushDeleted, [BOB]);
            assert.deepEqual(ctx.world.scheduledCancelled, [BOB]);

            // The access token is still valid, but the account no longer passes
            assert.equal((await ctx.request('GET', '/api/auth/profile', { as: BOB })).status, 401);

            ctx.world.users[BOB].password_hash = await bcrypt.hash('correct', 4);
            const right = await ctx.request('POST', '/api/auth/login', { body: { username: 'bob', password: 'correct' } });
            assert.equal(right.status, 403);
            assert.equal(right.body.code, 'ACCOUNT_SUSPENDED');
            const wrong = await ctx.request('POST', '/api/auth/login', { body: { username: 'bob', password: 'wrong-one' } });
            assert.equal(wrong.status, 401, 'a wrong password learns nothing about the suspension');

            const unsuspend = await ctx.request('POST', `/api/admin/users/${BOB}/unsuspend`, { as: ADMIN });
            assert.equal(unsuspend.status, 200);
            assert.equal(ctx.world.users[BOB].suspended_at, null);
            assert.ok(ctx.world.audit.some(a => a.event === 'admin_user_unsuspended' && a.actor_id === ADMIN && a.target_id === BOB));
        });

        test('admins can\'t be suspended; force logout refuses yourself', async () => {
            assert.equal((await ctx.request('POST', `/api/admin/users/${ADMIN}/suspend`, { as: ADMIN, body: {} })).status, 403);
            assert.equal((await ctx.request('POST', `/api/admin/users/${ADMIN}/logout`, { as: ADMIN })).status, 400);
            assert.equal((await ctx.request('POST', `/api/admin/users/${BOB}/logout`, { as: ADMIN })).status, 200);
            assert.ok(ctx.world.audit.some(a => a.event === 'admin_user_logged_out' && a.target_id === BOB));
        });

        test('delete-message takes it down, keeps the evidence, resolves the report', async () => {
            const filed = await ctx.request('POST', '/api/reports', { as: ALICE, body: { targetType: 'message', messageId: 20, reason: 'spam' } });
            const id = filed.body.data.reportId;
            const before = ctx.world.evidence.filter(e => e.report_id === id).map(e => e.content);

            const res = await ctx.request('POST', `/api/admin/reports/${id}/delete-message`, { as: ADMIN });
            assert.equal(res.status, 200);
            assert.equal(ctx.world.messages.find(m => m.id === 20).deleted_for_everyone, true);
            assert.deepEqual(ctx.world.evidence.filter(e => e.report_id === id).map(e => e.content), before);
            const report = ctx.world.reports.find(r => r.id === id);
            assert.equal(report.status, 'actioned');
            assert.equal(report.resolution, 'message_deleted');
            assert.ok(ctx.world.audit.some(a => a.event === 'admin_message_deleted' && a.target_id === 20));
        });

        test('warn reaches the user, who acknowledges only their own; dismiss closes a report', async () => {
            const filed = await ctx.request('POST', '/api/reports', { as: ALICE, body: { targetType: 'user', userId: BOB, reason: 'other' } });
            const id = filed.body.data.reportId;

            assert.equal((await ctx.request('POST', `/api/admin/reports/${id}/warn`, { as: ADMIN, body: { message: '' } })).status, 400);
            assert.equal((await ctx.request('POST', `/api/admin/reports/${id}/warn`, { as: ADMIN, body: { message: 'Stop that' } })).status, 200);

            const open = await ctx.request('GET', '/api/reports/warnings', { as: BOB });
            assert.equal(open.body.data[0].message, 'Stop that');
            const warningId = open.body.data[0].id;
            assert.equal((await ctx.request('POST', `/api/reports/warnings/${warningId}/acknowledge`, { as: ALICE })).status, 404);
            assert.equal((await ctx.request('POST', `/api/reports/warnings/${warningId}/acknowledge`, { as: BOB })).status, 200);

            assert.equal((await ctx.request('POST', `/api/admin/reports/${id}/dismiss`, { as: ADMIN })).status, 200);
            assert.equal(ctx.world.reports.find(r => r.id === id).status, 'dismissed');
            assert.equal((await ctx.request('POST', '/api/admin/reports/9999/dismiss', { as: ADMIN })).status, 404);
        });

        test('audit search: filters are parameters, bad filters 400, LIKE wildcards are escaped', async () => {
            const res = await ctx.request('GET', `/api/admin/audit?${new URLSearchParams({ event: 'login', actorId: '4', q: '50%_off', from: '2026-01-01', to: '2026-01-31' })}`, { as: ADMIN });
            assert.equal(res.status, 200);
            assert.ok(ctx.world.lastAuditParams.includes('login'));
            assert.ok(ctx.world.lastAuditParams.includes('%50|%|_off%'));
            assert.ok(ctx.world.lastAuditParams.includes('2026-02-01'), 'the "to" day is included');
            assert.ok(!ctx.world.lastAuditSql.includes('50%'));

            for (const bad of ['event=nope', 'from=yesterday', 'to=2026-02-31', 'actorId=abc', 'ip=not-an-ip', 'before=-1']) {
                assert.equal((await ctx.request('GET', `/api/admin/audit?${bad}`, { as: ADMIN })).status, 400, bad);
            }
        });
    });

    describe(`audit log (${dbType})`, () => {
        test('a failing audit write never fails the caller; unknown events are dropped', async () => {
            const fake = setupFakeDb(dbType, (sql) => { if (/audit_log/.test(sql)) throw new Error('database down'); return []; });
            const auditLog = fake.load('utils/auditLog.js');
            const error = console.error;
            console.error = () => {};
            try {
                await assert.doesNotReject(auditLog.record('login', { actorId: 1 }));
                await auditLog.record('made_up_event');
            } finally {
                console.error = error;
            }
            assert.equal(fake.calls.filter(call => /audit_log/.test(call.sql)).length, 1);
        });

        test('login, failed login and password events are recorded without secrets', async () => {
            const ctx = await startApp(dbType);
            try {
                ctx.world.users[ALICE].password_hash = await bcrypt.hash('correct', 4);
                await ctx.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-password' } });
                await ctx.request('POST', '/api/auth/login', { body: { username: 'nobody-here', password: 'wrong-password' } });
                await ctx.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct' } });

                const events = ctx.world.audit.map(a => a.event);
                assert.deepEqual(events, ['login_failed', 'login_failed', 'login']);
                assert.equal(ctx.world.audit[0].target_id, ALICE);
                assert.ok(ctx.world.audit[0].ip_address);
                assert.ok(!JSON.stringify(ctx.world.audit).includes('wrong-password'));
                assert.ok(!JSON.stringify(ctx.world.audit).includes('nobody-here'));
            } finally {
                await ctx.stop();
            }
        });
    });

    describe(`spam limit (${dbType})`, () => {
        function setup({ isRequester = true, isNew = true, sent = 0 } = {}) {
            const fake = setupFakeDb(dbType, (rawSql) => {
                if (/FROM message_requests WHERE chat_id = /.test(rawSql)) return isRequester ? [{ chat_id: CHAT }] : [];
                if (/^SELECT id FROM users WHERE id = /.test(rawSql)) return isNew ? [{ id: ALICE }] : [];
                if (/^SELECT COUNT\(\*\) AS count FROM messages m JOIN message_requests mr/.test(rawSql)) return [{ count: String(sent) }];
                throw new Error(`Unexpected: ${rawSql}`);
            });
            return fake.load('utils/spamLimits.js');
        }

        test('over the hourly limit a new account is refused with 429', async () => {
            process.env.SPAM_NON_CONTACT_MESSAGES_PER_HOUR = '3';
            process.env.SPAM_NEW_ACCOUNT_HOURS = '72';
            try {
                assert.equal(await setup({ sent: 2 }).checkNonContactLimit(CHAT, ALICE), null);
                const error = await setup({ sent: 3 }).checkNonContactLimit(CHAT, ALICE);
                assert.equal(error.status, 429);
                assert.equal(error.code, 'SPAM_LIMIT');
            } finally {
                delete process.env.SPAM_NON_CONTACT_MESSAGES_PER_HOUR;
                delete process.env.SPAM_NEW_ACCOUNT_HOURS;
            }
        });

        test('accepted chats, old accounts, and a limit of 0 are not limited', async () => {
            assert.equal(await setup({ isRequester: false, sent: 999 }).checkNonContactLimit(CHAT, ALICE), null);
            assert.equal(await setup({ isNew: false, sent: 999 }).checkNonContactLimit(CHAT, ALICE), null);
            process.env.SPAM_NON_CONTACT_MESSAGES_PER_HOUR = '0';
            try {
                assert.equal(await setup({ sent: 999 }).checkNonContactLimit(CHAT, ALICE), null);
            } finally {
                delete process.env.SPAM_NON_CONTACT_MESSAGES_PER_HOUR;
            }
        });
    });
}

function sourceFiles(dir = BACKEND) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'test', 'uploads', 'private'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...sourceFiles(full));
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

describe('audit_log is append-only in the code', () => {
    test('no UPDATE, DELETE or TRUNCATE of audit_log anywhere in the backend', () => {
        const mentions = [];
        for (const file of sourceFiles()) {
            const text = fs.readFileSync(file, 'utf8');
            assert.ok(!/(UPDATE\s+|DELETE\s+FROM\s+|TRUNCATE\s+(TABLE\s+)?|DROP\s+TABLE\s+(IF\s+EXISTS\s+)?)audit_log/i.test(text), file);
            if (/\baudit_log\b/.test(text) && !/\.md$/.test(file)) mentions.push(path.basename(file));
        }
        assert.deepEqual(mentions.sort(), ['auditLog.js'], 'only utils/auditLog.js touches the table');
    });
});

// --- Uploads on real files ---

describe('upload hardening', () => {
    let root;
    let security;
    let fakeDb;
    const previous = {};
    const ENV = ['UPLOAD_PATH', 'QUARANTINE_PATH', 'REPORT_EVIDENCE_PATH', 'CLAMAV_ENABLED', 'CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_FAIL_OPEN'];

    before(() => {
        for (const name of ENV) previous[name] = process.env[name];
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-uploads-'));
        process.env.UPLOAD_PATH = path.join(root, 'uploads');
        process.env.QUARANTINE_PATH = path.join(root, 'private', 'quarantine');
        process.env.CLAMAV_ENABLED = 'false';
        fakeDb = setupFakeDb('mysql', (sql) => (/^INSERT/.test(sql) ? { insertId: 7 } : []));
        security = fakeDb.load('utils/uploadSecurity.js');
    });

    after(() => {
        for (const name of ENV) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    function incoming(buffer, mimetype, originalname) {
        const dir = path.join(process.env.UPLOAD_PATH, '.incoming');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `in-${Math.random().toString(16).slice(2)}`);
        fs.writeFileSync(file, buffer);
        return { user: { id: ALICE }, ip: '127.0.0.1', file: { path: file, mimetype, originalname, size: buffer.length } };
    }

    const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer();
    const HTML = Buffer.from('<!doctype html><html><script>alert(document.domain)</script></html>');
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const WEBM = Buffer.concat([Buffer.from('1a45dfa3a34286810142f7810142f2810442f381084282847765626d4287810442858102', 'hex'), Buffer.alloc(64)]);

    test('HTML and SVG under image or PDF labels are refused and removed', async () => {
        for (const [bytes, mime, name] of [[HTML, 'image/png', 'x.png'], [SVG, 'image/png', 'x.svg'], [HTML, 'application/pdf', 'x.pdf'], [HTML, 'video/mp4', 'x.mp4']]) {
            const req = incoming(bytes, mime, name);
            const refused = await security.processUpload(req);
            assert.equal(refused.status, 400, name);
            assert.equal(fs.existsSync(req.file.path), false);
        }
    });

    test('what claims one thing and is another is refused; an image keeps its real type', async () => {
        const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]);
        assert.equal((await security.processUpload(incoming(pdf, 'application/zip', 'a.zip'))).status, 400);

        const req = incoming(await png(), 'image/jpeg', 'really-a-png.jpg');
        assert.equal(await security.processUpload(req), null);
        assert.equal(req.file.mimetype, 'image/png');
        assert.match(req.file.filename, /^[a-f0-9]{32}\.png$/);
    });

    test('the stored name is random, nothing of the client\'s name survives', async () => {
        const req = incoming(await png(), 'image/png', '../../evil name.html.png');
        assert.equal(await security.processUpload(req), null);
        assert.match(req.file.filename, /^[a-f0-9]{32}\.png$/);
        assert.equal(path.dirname(req.file.path), path.join(process.env.UPLOAD_PATH, 'images'));
        assert.equal(fs.existsSync(req.file.path), true);
    });

    test('re-encoding strips EXIF and bytes appended after the image', async () => {
        const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#884422' } })
            .jpeg().withExif({ IFD0: { Copyright: 'SECRET-GPS-TAG' } }).toBuffer();
        const poisoned = Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>')]);
        assert.ok(poisoned.includes('SECRET-GPS-TAG'));

        const req = incoming(poisoned, 'image/jpeg', 'photo.jpg');
        assert.equal(await security.processUpload(req), null);
        const stored = fs.readFileSync(req.file.path);
        assert.ok(!stored.includes('SECRET-GPS-TAG'));
        assert.ok(!stored.includes('<script>'));
        assert.equal(req.file.size, stored.length);
        assert.equal((await sharp(Buffer.from(stored)).metadata()).format, 'jpeg');
    });

    test('animated GIFs and WebPs stay animated', async () => {
        const frame = (background) => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
        const frames = [await frame('#ff0000'), await frame('#00ff00'), await frame('#0000ff')];

        for (const [format, type] of [['gif', 'image/gif'], ['webp', 'image/webp']]) {
            const animated = await sharp(frames, { join: { animated: true } })[format]().toBuffer();
            const req = incoming(animated, type, `a.${format}`);
            assert.equal(await security.processUpload(req), null);
            const stored = await sharp(fs.readFileSync(req.file.path), { animated: true }).metadata();
            assert.equal(stored.format, format);
            assert.equal(stored.pages, 3);
        }

        const still = await sharp(await png()).webp().toBuffer();
        assert.equal(await security.processUpload(incoming(still, 'image/webp', 'still.webp')), null);
    });

    test('voice notes: audio/webm is detected as a webm container and stays audio', async () => {
        const req = incoming(WEBM, 'audio/webm', 'voice-note.webm');
        assert.equal(await security.processUpload(req), null);
        assert.equal(req.file.mimetype, 'audio/webm');
        assert.equal(path.basename(path.dirname(req.file.path)), 'audio');
        assert.match(req.file.filename, /\.webm$/);
    });

    test('UTF-8 file names survive busboy\'s latin1 decoding', () => {
        const { decodeFileName } = fakeDb.load('middleware/upload.js');
        assert.equal(decodeFileName(Buffer.from('été 日本.pdf', 'utf8').toString('latin1')), 'été 日本.pdf');
        assert.equal(decodeFileName('plain.pdf'), 'plain.pdf');
        assert.equal(decodeFileName(Buffer.from([0xe9, 0x2e, 0x70]).toString('latin1')), 'é.p', 'not UTF-8: left alone');
    });

    test('type families', () => {
        const allowed = ['image/png', 'image/jpeg', 'video/mp4', 'audio/mp4', 'application/pdf', 'application/zip'];
        const verify = security.resolveVerifiedType;
        assert.equal(verify('video/mp4', 'audio/mp4', allowed), 'audio/mp4', 'Safari voice note');
        assert.equal(verify('video/quicktime', 'video/mp4', allowed), 'video/mp4');
        assert.equal(verify('audio/ogg; codecs=opus', 'audio/ogg', allowed), 'audio/ogg');
        assert.equal(verify('application/x-cfb', 'application/msword', allowed), 'application/msword');
        assert.equal(verify('application/zip', 'application/x-zip-compressed', allowed), 'application/x-zip-compressed');
        assert.equal(verify('application/x-msdownload', 'application/pdf', allowed), null);
        assert.equal(verify('image/gif', 'image/png', allowed), null, 'an image type that is not allowed');
        assert.equal(verify('image/svg+xml', 'image/png', ['image/svg+xml', 'image/png']), null, 'SVG can\'t be enabled');
        assert.equal(verify(null, 'text/plain', ['text/plain']), null, 'no signature, no upload');
    });

    test('audio over its cap is refused before any work', async () => {
        const previousCap = process.env.MAX_AUDIO_FILE_SIZE;
        process.env.MAX_AUDIO_FILE_SIZE = '10';
        try {
            const req = incoming(WEBM, 'audio/webm', 'long.webm');
            assert.equal((await security.processUpload(req)).status, 400);
            assert.equal(fs.existsSync(req.file.path), false);
        } finally {
            if (previousCap === undefined) delete process.env.MAX_AUDIO_FILE_SIZE;
            else process.env.MAX_AUDIO_FILE_SIZE = previousCap;
        }
    });

    // Reads the frames like clamd: zINSTREAM\0, then <length><bytes>... until a length of 0
    function fakeClamd(answer) {
        return new Promise((resolve) => {
            const received = [];
            const server = net.createServer((socket) => {
                let answered = false;
                socket.on('data', (data) => {
                    received.push(data);
                    const all = Buffer.concat(received);
                    for (let at = 10; at + 4 <= all.length && !answered;) {
                        const length = all.readUInt32BE(at);
                        if (length === 0) {
                            answered = true;
                            socket.end(answer);
                        }
                        at += 4 + length;
                    }
                });
            }).listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
        });
    }

    test('ClamAV: clean files pass over INSTREAM, framed with lengths', async () => {
        const clamd = await fakeClamd('stream: OK\0');
        process.env.CLAMAV_ENABLED = 'true';
        process.env.CLAMAV_PORT = String(clamd.port);
        try {
            const req = incoming(WEBM, 'audio/webm', 'clean.webm');
            assert.equal(await security.processUpload(req), null);
            const sent = Buffer.concat(clamd.received);
            assert.ok(sent.subarray(0, 10).equals(Buffer.from('zINSTREAM\0')));
            assert.equal(sent.readUInt32BE(10), WEBM.length);
        } finally {
            process.env.CLAMAV_ENABLED = 'false';
            clamd.server.close();
        }
    });

    test('ClamAV: an infected file goes to quarantine outside uploads and is recorded', async () => {
        const clamd = await fakeClamd('stream: Eicar-Test-Signature FOUND\0');
        process.env.CLAMAV_ENABLED = 'true';
        process.env.CLAMAV_PORT = String(clamd.port);
        try {
            const req = incoming(WEBM, 'audio/webm', 'bad.webm');
            const refused = await security.processUpload(req);
            assert.equal(refused.status, 422);
            assert.equal(fs.existsSync(req.file.path), false);

            const stored = fs.readdirSync(process.env.QUARANTINE_PATH);
            assert.equal(stored.length, 1);
            assert.ok(!path.join(process.env.QUARANTINE_PATH, stored[0]).startsWith(process.env.UPLOAD_PATH));

            const insert = fakeDb.calls.find(call => /INSERT INTO quarantined_files/.test(call.sql));
            assert.ok(insert.params.includes('Eicar-Test-Signature'));
            assert.ok(fakeDb.calls.some(call => /INSERT INTO audit_log/.test(call.sql) && call.params[0] === 'upload_quarantined'));
        } finally {
            process.env.CLAMAV_ENABLED = 'false';
            clamd.server.close();
        }
    });

    test('ClamAV unreachable: refused by default, allowed with CLAMAV_FAIL_OPEN, and off when disabled', async () => {
        const error = console.error;
        console.error = () => {};
        const closed = net.createServer().listen(0, '127.0.0.1');
        await new Promise(resolve => closed.once('listening', resolve));
        const port = closed.address().port;
        await new Promise(resolve => closed.close(resolve));

        process.env.CLAMAV_ENABLED = 'true';
        process.env.CLAMAV_PORT = String(port);
        try {
            const req = incoming(WEBM, 'audio/webm', 'a.webm');
            assert.equal((await security.processUpload(req)).status, 503);
            assert.equal(fs.existsSync(req.file.path), false);

            process.env.CLAMAV_FAIL_OPEN = 'true';
            assert.equal(await security.processUpload(incoming(WEBM, 'audio/webm', 'b.webm')), null);
        } finally {
            console.error = error;
            process.env.CLAMAV_ENABLED = 'false';
            delete process.env.CLAMAV_FAIL_OPEN;
        }
    });

    test('private folders can\'t be pointed inside uploads', () => {
        const error = console.error;
        console.error = () => {};
        process.env.QUARANTINE_PATH = path.join(process.env.UPLOAD_PATH, 'quarantine');
        try {
            const chosen = security.privateDir('QUARANTINE_PATH', 'quarantine');
            assert.ok(!chosen.startsWith(path.resolve(process.env.UPLOAD_PATH)));
        } finally {
            console.error = error;
            process.env.QUARANTINE_PATH = path.join(root, 'private', 'quarantine');
        }
    });
});

describe('serving /uploads through the real server', () => {
    let ctx;
    const dir = path.join(BACKEND, 'uploads', 'files');
    const probes = {};

    before(async () => {
        ctx = await startApp('mysql');
        fs.mkdirSync(dir, { recursive: true });
        const write = (name, content) => {
            probes[name] = path.join(dir, name);
            fs.writeFileSync(probes[name], content);
        };
        write('phase13-probe.html', '<script>alert(document.domain)</script>');
        write('phase13-probe.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        write('phase13-probe.png', 'not really a png');
        write('report-probe.pdf', '%PDF-1.7');
    });

    after(async () => {
        await ctx.stop();
        for (const file of Object.values(probes)) fs.rmSync(file, { force: true });
    });

    for (const name of ['phase13-probe.html', 'phase13-probe.svg']) {
        test(`${name} can't run: download, generic type, nosniff, sandbox`, async () => {
            const res = await ctx.request('GET', `/uploads/files/${name}`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'application/octet-stream');
            assert.match(res.headers.get('content-disposition'), /^attachment/);
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
            assert.match(res.headers.get('content-security-policy'), /sandbox/);
            assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
        });
    }

    test('case tricks don\'t get a file shown', async () => {
        const res = await ctx.request('GET', '/uploads/files/phase13-probe.HTML'.toLowerCase());
        assert.match(res.headers.get('content-disposition'), /^attachment/);
    });

    test('media stays inline, still with nosniff', async () => {
        const res = await ctx.request('GET', '/uploads/files/phase13-probe.png');
        assert.equal(res.headers.get('content-disposition'), null);
        assert.equal(res.headers.get('content-type'), 'image/png');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });

    test('downloads keep the original name, safely encoded', async () => {
        const header = (await ctx.request('GET', '/uploads/files/report-probe.pdf')).headers.get('content-disposition');
        assert.match(header, /^attachment; filename="r_sum_ _final_\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22\.pdf$/);
    });

    test('the waiting room is never served', async () => {
        const incomingDir = path.join(BACKEND, 'uploads', '.incoming');
        fs.mkdirSync(incomingDir, { recursive: true });
        const file = path.join(incomingDir, 'phase13probe');
        fs.writeFileSync(file, 'x');
        try {
            assert.equal((await ctx.request('GET', '/uploads/.incoming/phase13probe')).status, 404);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });
});

describe('phase 13 validation and migrations', () => {
    const DB = path.join(BACKEND, '..', 'database');
    const read = (file) => fs.readFileSync(path.join(DB, file), 'utf8');

    test('both engines get the same tables, in the migration and in the fresh schema', () => {
        for (const file of ['add_abuse_handling.sql', 'add_abuse_handling_postgresql.sql', 'schema.sql', 'schema_postgresql.sql']) {
            const sql = read(file);
            for (const table of ['reports', 'report_evidence', 'audit_log', 'user_warnings', 'quarantined_files']) {
                assert.match(sql, new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`), `${table} in ${file}`);
            }
            assert.match(sql, /is_admin BOOLEAN NOT NULL DEFAULT FALSE/);
            assert.match(sql, /suspended_at TIMESTAMP/);
        }
    });

    test('evidence and audit rows have no foreign key that a deletion could reach', () => {
        for (const file of ['add_abuse_handling.sql', 'add_abuse_handling_postgresql.sql']) {
            const sql = read(file);
            const body = (table) => new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)[1];
            assert.ok(!/REFERENCES (messages|users|chats)/.test(body('report_evidence')));
            assert.ok(!/REFERENCES/.test(body('audit_log')));
            assert.ok(!/REFERENCES (messages|chats)/.test(body('reports')));
        }
    });
});
