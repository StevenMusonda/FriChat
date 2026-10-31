/**
 * Phase 6 sessions, end to end through the real Express app (both fake drivers):
 * HttpOnly refresh cookie, 15-minute access JWT, rotation, reuse detection (a stolen old refresh
 * token revokes the whole session), the two-tabs race, Settings > Devices, password change/reset
 * revoking sessions, and the Socket.IO handshake re-checking the session.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { setupFakeDb, stubModule, listenForFetch } = require('./helpers/fakeDb');

const ALICE = 1;
const BOB = 2;
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const PASSWORD_HASH = bcrypt.hashSync('correct-horse', bcrypt.genSaltSync(4));

/**
 * In-memory users, sessions, rotated tokens and verification links answering the auth queries
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        now: Date.now(),
        users: {
            [ALICE]: { id: ALICE, username: 'alice', email: 'alice@example.com', password_hash: PASSWORD_HASH, full_name: 'Alice', avatar_url: null, status: 'offline', email_verified_at: '2026-10-01 00:00:00' },
            [BOB]: { id: BOB, username: 'bob', email: 'bob@example.com', password_hash: PASSWORD_HASH, full_name: null, avatar_url: null, status: 'offline', email_verified_at: null }
        },
        sessions: {},
        rotated: [], // { session_id, token_hash, rotated_at }
        resets: [],
        verifications: [],
        nextId: 100
    };
    const written = (n) => pg ? Array.from({ length: n }, () => ({ id: 1 })) : { affectedRows: n };
    const inserted = (id) => pg ? [{ id }] : { insertId: id };
    const userRow = (u) => u && ({ ...u });

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?').replace(/ RETURNING id$/, '');

        // --- users ---
        if (/^SELECT \* FROM users WHERE username = \? OR email = \?$/.test(sql)) {
            const u = Object.values(world.users).find(x => x.username === params[0] || x.email === params[1]);
            return u ? [userRow(u)] : [];
        }
        if (/^SELECT id FROM users WHERE username = \? OR email = \?$/.test(sql)) {
            const u = Object.values(world.users).find(x => x.username === params[0] || x.email === params[1]);
            return u ? [{ id: u.id }] : [];
        }
        if (/^INSERT INTO users /.test(sql)) {
            const id = ++world.nextId;
            world.users[id] = { id, username: params[0], email: params[1], password_hash: params[2], full_name: params[3], avatar_url: null, status: 'offline', email_verified_at: null };
            return inserted(id);
        }
        if (/^SELECT id, username, email, full_name, avatar_url, email_verified_at, is_admin, suspended_at, deleted_at, totp_enabled_at FROM users WHERE id = \?$/.test(sql)) {
            const u = world.users[params[0]];
            return u ? [userRow(u)] : [];
        }
        if (/^SELECT password_hash FROM users WHERE id = \?$/.test(sql)) {
            const u = world.users[params[0]];
            return u ? [{ password_hash: u.password_hash }] : [];
        }
        if (/^UPDATE users SET password_hash = \?, updated_at = CURRENT_TIMESTAMP WHERE id = \?$/.test(sql)) {
            world.users[params[1]].password_hash = params[0];
            return written(1);
        }
        if (/^UPDATE users SET status = \?, last_seen = CURRENT_TIMESTAMP WHERE id = \?$/.test(sql)) {
            if (world.users[params[1]]) world.users[params[1]].status = params[0];
            return written(1);
        }
        if (/^UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = \? AND email_verified_at IS NULL$/.test(sql)) {
            const u = world.users[params[0]];
            if (u && !u.email_verified_at) u.email_verified_at = 'now';
            return written(1);
        }

        // --- password resets ---
        if (/^DELETE FROM password_resets WHERE user_id = \?$/.test(sql)) {
            world.resets = world.resets.filter(r => r.user_id !== Number(params[0]));
            return written(1);
        }
        if (/^SELECT id, user_id FROM password_resets WHERE token_hash = \? AND expires_at > \?$/.test(sql)) {
            const r = world.resets.find(x => x.token_hash === params[0]);
            return r ? [{ id: 1, user_id: r.user_id }] : [];
        }

        // --- email verification ---
        if (/^DELETE FROM email_verifications WHERE user_id = \?$/.test(sql)) {
            world.verifications = world.verifications.filter(v => v.user_id !== Number(params[0]));
            return written(1);
        }
        if (/^INSERT INTO email_verifications \(user_id, token_hash, expires_at\) VALUES \(\?, \?, /.test(sql)) {
            world.verifications.push({ user_id: Number(params[0]), token_hash: params[1], hours: params[2] });
            return inserted(++world.nextId);
        }
        if (/^SELECT user_id FROM email_verifications WHERE token_hash = \? AND expires_at > CURRENT_TIMESTAMP$/.test(sql)) {
            const v = world.verifications.find(x => x.token_hash === params[0] && !x.expired);
            return v ? [{ user_id: v.user_id }] : [];
        }

        // --- sessions ---
        if (/^INSERT INTO sessions \(user_id, refresh_token_hash, user_agent, device_label, ip_address, expires_at, mfa_verified_at\) VALUES \(\?, \?, \?, \?, \?, /.test(sql)) {
            const id = ++world.nextId;
            world.sessions[id] = { id, user_id: Number(params[0]), refresh_token_hash: params[1], user_agent: params[2], device_label: params[3], ip_address: params[4], ttl_days: params[5], revoked_at: null, revoked_reason: null, expired: false, created_at: 'c', last_active_at: id };
            return inserted(id);
        }
        if (/^SELECT id, user_id, revoked_at, mfa_verified_at, CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_expired FROM sessions WHERE refresh_token_hash = \?$/.test(sql)) {
            const s = Object.values(world.sessions).find(x => x.refresh_token_hash === params[0]);
            return s ? [{ id: s.id, user_id: s.user_id, revoked_at: s.revoked_at, is_expired: s.expired ? 1 : 0 }] : [];
        }
        if (/^INSERT INTO session_refresh_tokens \(session_id, token_hash\) VALUES \(\?, \?\)$/.test(sql)) {
            if (world.rotated.some(r => r.token_hash === params[1])) {
                const error = new Error('duplicate');
                error.code = pg ? '23505' : 'ER_DUP_ENTRY';
                throw error;
            }
            world.rotated.push({ session_id: Number(params[0]), token_hash: params[1], rotated_at: world.now });
            return inserted(++world.nextId);
        }
        if (/^UPDATE sessions SET refresh_token_hash = \?, last_active_at = CURRENT_TIMESTAMP, ip_address = \?, expires_at = .+ WHERE id = \? AND refresh_token_hash = \? AND revoked_at IS NULL$/.test(sql)) {
            const s = world.sessions[params[3]];
            const ok = !!s && s.refresh_token_hash === params[4] && !s.revoked_at;
            if (ok) s.refresh_token_hash = params[0];
            return written(ok ? 1 : 0);
        }
        if (/^SELECT t.session_id, s.user_id, s.revoked_at, CASE WHEN t.rotated_at > .+ THEN 1 ELSE 0 END AS in_grace FROM session_refresh_tokens t JOIN sessions s ON s.id = t.session_id WHERE t.token_hash = \?$/.test(sql)) {
            const r = world.rotated.find(x => x.token_hash === params[1]);
            if (!r) return [];
            const s = world.sessions[r.session_id];
            return [{ session_id: s.id, user_id: s.user_id, revoked_at: s.revoked_at, in_grace: world.now - r.rotated_at < params[0] * 1000 ? 1 : 0 }];
        }
        if (/^SELECT id, user_id FROM sessions WHERE refresh_token_hash = \? AND revoked_at IS NULL$/.test(sql)) {
            const s = Object.values(world.sessions).find(x => x.refresh_token_hash === params[0] && !x.revoked_at);
            return s ? [{ id: s.id, user_id: s.user_id }] : [];
        }
        if (/^UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = \? WHERE id = \? AND revoked_at IS NULL( AND user_id = \?)?$/.test(sql)) {
            const s = world.sessions[params[1]];
            const ok = !!s && !s.revoked_at && (params[2] === undefined || s.user_id === Number(params[2]));
            if (ok) { s.revoked_at = 'now'; s.revoked_reason = params[0]; }
            return written(ok ? 1 : 0);
        }
        if (/^SELECT id FROM sessions WHERE user_id = \? AND revoked_at IS NULL( AND id <> \?)?$/.test(sql)) {
            return Object.values(world.sessions).filter(s => s.user_id === Number(params[0]) && !s.revoked_at && s.id !== Number(params[1])).map(s => ({ id: s.id }));
        }
        if (/^UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = \? WHERE user_id = \? AND revoked_at IS NULL( AND id <> \?)?$/.test(sql)) {
            let n = 0;
            for (const s of Object.values(world.sessions)) {
                if (s.user_id === Number(params[1]) && !s.revoked_at && s.id !== Number(params[2])) { s.revoked_at = 'now'; s.revoked_reason = params[0]; n++; }
            }
            return written(n);
        }
        if (/^SELECT id, device_label, user_agent, ip_address, created_at, last_active_at FROM sessions WHERE user_id = \? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY/.test(sql)) {
            return Object.values(world.sessions).filter(s => s.user_id === Number(params[0]) && !s.revoked_at && !s.expired)
                .sort((a, b) => b.last_active_at - a.last_active_at).map(s => ({ ...s }));
        }
        if (/^SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.status, u.email_verified_at, u.is_admin, u.totp_enabled_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = \? AND s.user_id = \? AND s.revoked_at IS NULL AND u.suspended_at IS NULL AND u.deleted_at IS NULL AND \(u.totp_enabled_at IS NULL OR s.mfa_verified_at IS NOT NULL\)$/.test(sql)) {
            const s = world.sessions[params[0]];
            return s && s.user_id === Number(params[1]) && !s.revoked_at ? [userRow(world.users[s.user_id])] : [];
        }
        if (/^UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP, ip_address = COALESCE\(\?, ip_address\) WHERE id = \? AND revoked_at IS NULL$/.test(sql)) {
            return written(1);
        }

        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

/**
 * The real app on an ephemeral port, plus a recorder for session disconnects
 */
async function startApp(dbType) {
    const world = createWorld(dbType);
    const fake = setupFakeDb(dbType, (sql, params) => world.handler(sql, params));
    process.env.JWT_SECRET = 'test-secret';
    process.env.PORT = '0';
    delete process.env.COOKIE_SAMESITE;
    delete process.env.COOKIE_SECURE;
    stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });
    stubModule(path.join(__dirname, '..', 'utils', 'mailer.js'), {
        sendSecurityEmail: async () => {},
        sendMail: async () => {},
        sendPasswordResetEmail: async () => {},
        sendVerificationEmail: async (to, username, url) => { world.lastVerificationUrl = url; }
    });

    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    const { app, io } = fake.load('server.js');

    // Record what revocation does to sockets
    const disconnected = [];
    const emitted = [];
    const realIn = io.in.bind(io);
    const realTo = io.to.bind(io);
    io.in = (room) => {
        const target = realIn(room);
        return {
            ...target,
            socketsJoin: (...a) => target.socketsJoin(...a),
            socketsLeave: (...a) => target.socketsLeave(...a),
            fetchSockets: (...a) => target.fetchSockets(...a),
            disconnectSockets: (close) => { disconnected.push(room); return target.disconnectSockets(close); }
        };
    };
    io.to = (room) => {
        const target = realTo(room);
        return { ...target, except: (...a) => target.except(...a), emit: (event, data) => { emitted.push({ room, event, data }); return target.emit(event, data); } };
    };

    const server = await listenForFetch(app);
    const base = `http://127.0.0.1:${server.address().port}/api`;

    async function request(method, urlPath, { body, cookie, token, refreshHeader = true, userAgent } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers.Cookie = `frichat_refresh=${cookie}`;
        if (token) headers.Authorization = `Bearer ${token}`;
        if (refreshHeader) headers['X-FriChat-Refresh'] = '1';
        if (userAgent) headers['User-Agent'] = userAgent;
        const res = await fetch(`${base}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const setCookie = res.headers.get('set-cookie');
        const match = setCookie && /frichat_refresh=([^;]*)/.exec(setCookie);
        return { status: res.status, body: await res.json(), setCookie, cookie: match ? decodeURIComponent(match[1]) : undefined };
    }

    async function stop() {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => io.close(() => resolve()));
        console.log = log;
        console.warn = warn;
    }

    const login = (username = 'alice', userAgent) => request('POST', '/auth/login', { body: { username, password: 'correct-horse' }, refreshHeader: false, userAgent });

    return { world, io, request, login, stop, disconnected, emitted };
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`sessions and refresh tokens (${dbType})`, () => {
        let ctx;
        before(async () => { ctx = await startApp(dbType); });
        after(async () => { await ctx.stop(); });

        test('login sets an HttpOnly, Secure, SameSite=Strict refresh cookie on /api/auth and returns a 15-minute access token', async () => {
            const res = await ctx.login('alice', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36');
            assert.equal(res.status, 200);
            assert.match(res.setCookie, /HttpOnly/i);
            assert.match(res.setCookie, /Secure/i);
            assert.match(res.setCookie, /SameSite=Strict/i);
            assert.match(res.setCookie, /Path=\/api\/auth/);
            assert.equal(res.body.data.token, undefined, 'no long-lived token in the body');

            const decoded = jwt.verify(res.body.data.accessToken, 'test-secret');
            assert.equal(decoded.userId, ALICE);
            assert.equal(decoded.exp - decoded.iat, 15 * 60);
            assert.equal(res.body.data.expiresIn, 900);

            // Only the hash is stored, and the device is described without any external lookup
            const session = ctx.world.sessions[decoded.sid];
            assert.equal(session.refresh_token_hash, sha256(res.cookie));
            assert.notEqual(session.refresh_token_hash, res.cookie);
            assert.equal(session.device_label, 'Chrome on Windows');
        });

        test('refresh rotates the token and keeps the session', async () => {
            const first = await ctx.login();
            const sid = jwt.decode(first.body.data.accessToken).sid;

            const refreshed = await ctx.request('POST', '/auth/refresh', { cookie: first.cookie });
            assert.equal(refreshed.status, 200);
            assert.ok(refreshed.cookie && refreshed.cookie !== first.cookie, 'a new refresh token');
            assert.equal(jwt.decode(refreshed.body.data.accessToken).sid, sid);
            assert.equal(ctx.world.sessions[sid].refresh_token_hash, sha256(refreshed.cookie));
            assert.ok(ctx.world.rotated.some(r => r.token_hash === sha256(first.cookie)), 'old hash remembered for reuse detection');
        });

        test('a stolen old refresh token is rejected and revokes the whole session (sockets disconnected)', async () => {
            const first = await ctx.login();
            const sid = jwt.decode(first.body.data.accessToken).sid;
            const rotated = await ctx.request('POST', '/auth/refresh', { cookie: first.cookie });

            ctx.world.now += 60 * 1000; // well past the 10-second race window
            const stolen = await ctx.request('POST', '/auth/refresh', { cookie: first.cookie });
            assert.equal(stolen.status, 401);
            assert.equal(stolen.body.code, 'TOKEN_REUSED');
            assert.equal(stolen.body.data, undefined, 'no token handed out');

            assert.equal(ctx.world.sessions[sid].revoked_reason, 'reuse');
            assert.ok(ctx.disconnected.includes(`session_${sid}`));
            assert.ok(ctx.emitted.some(e => e.room === `session_${sid}` && e.event === 'session_revoked' && e.data.reason === 'reuse'));

            // The legitimate holder's newer token is dead too, and so is the access token
            const legit = await ctx.request('POST', '/auth/refresh', { cookie: rotated.cookie });
            assert.equal(legit.status, 401);
            const api = await ctx.request('GET', '/auth/profile', { token: rotated.body.data.accessToken });
            assert.equal(api.status, 401);
            assert.equal(api.body.code, 'SESSION_REVOKED');
        });

        test('two tabs refreshing at once: the loser gets 409 (retry) and the session survives', async () => {
            const first = await ctx.login();
            const sid = jwt.decode(first.body.data.accessToken).sid;
            await ctx.request('POST', '/auth/refresh', { cookie: first.cookie });

            const late = await ctx.request('POST', '/auth/refresh', { cookie: first.cookie });
            assert.equal(late.status, 409);
            assert.equal(late.body.code, 'REFRESH_RACE');
            assert.equal(ctx.world.sessions[sid].revoked_at, null);
        });

        test('refresh needs the cookie and the X-FriChat-Refresh header', async () => {
            const first = await ctx.login();
            assert.equal((await ctx.request('POST', '/auth/refresh', {})).status, 401);
            assert.equal((await ctx.request('POST', '/auth/refresh', { cookie: 'x'.repeat(43) })).status, 401);
            const noHeader = await ctx.request('POST', '/auth/refresh', { cookie: first.cookie, refreshHeader: false });
            assert.equal(noHeader.status, 403);
        });

        test('Settings > Devices: list marks this device; Log out a device disconnects it at once; others\' sessions are off limits', async () => {
            const phone = await ctx.login('alice', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
            const laptop = await ctx.login('alice', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0');
            const phoneSid = jwt.decode(phone.body.data.accessToken).sid;
            const laptopSid = jwt.decode(laptop.body.data.accessToken).sid;

            const list = await ctx.request('GET', '/auth/sessions', { token: laptop.body.data.accessToken });
            assert.equal(list.status, 200);
            const current = list.body.data.filter(s => s.current);
            assert.deepEqual(current.map(s => s.id), [laptopSid]);
            const phoneRow = list.body.data.find(s => s.id === phoneSid);
            assert.equal(phoneRow.device, 'Safari on iPhone');
            assert.ok(!('refresh_token_hash' in phoneRow) && !JSON.stringify(list.body).includes(ctx.world.sessions[phoneSid].refresh_token_hash));

            const bob = await ctx.login('bob');
            const notMine = await ctx.request('DELETE', `/auth/sessions/${phoneSid}`, { token: bob.body.data.accessToken });
            assert.equal(notMine.status, 404);
            assert.equal(ctx.world.sessions[phoneSid].revoked_at, null);

            const revoke = await ctx.request('DELETE', `/auth/sessions/${phoneSid}`, { token: laptop.body.data.accessToken });
            assert.equal(revoke.status, 200);
            assert.ok(ctx.disconnected.includes(`session_${phoneSid}`));
            assert.equal((await ctx.request('GET', '/auth/profile', { token: phone.body.data.accessToken })).status, 401);
            assert.equal((await ctx.request('POST', '/auth/refresh', { cookie: phone.cookie })).status, 401);
            assert.equal((await ctx.request('GET', '/auth/profile', { token: laptop.body.data.accessToken })).status, 200);
        });

        test('Log out all other devices keeps this one', async () => {
            const a = await ctx.login();
            const b = await ctx.login();
            const res = await ctx.request('POST', '/auth/sessions/revoke-others', { token: b.body.data.accessToken });
            assert.equal(res.status, 200);
            assert.ok(res.body.data.revokedSessions >= 1);
            assert.equal((await ctx.request('GET', '/auth/profile', { token: a.body.data.accessToken })).status, 401);
            assert.equal((await ctx.request('GET', '/auth/profile', { token: b.body.data.accessToken })).status, 200);
        });

        test('change password needs the current one (wrong = 400, not a sign-out) and signs out every other device', async () => {
            const other = await ctx.login();
            const me = await ctx.login();

            const wrong = await ctx.request('PUT', '/auth/password', { token: me.body.data.accessToken, body: { currentPassword: 'nope', newPassword: 'battery-staple' } });
            assert.equal(wrong.status, 400);
            assert.equal(wrong.body.code, 'WRONG_PASSWORD');

            const same = await ctx.request('PUT', '/auth/password', { token: me.body.data.accessToken, body: { currentPassword: 'correct-horse', newPassword: 'correct-horse' } });
            assert.equal(same.status, 400);

            const ok = await ctx.request('PUT', '/auth/password', { token: me.body.data.accessToken, body: { currentPassword: 'correct-horse', newPassword: 'battery-staple' } });
            assert.equal(ok.status, 200);
            assert.ok(bcrypt.compareSync('battery-staple', ctx.world.users[ALICE].password_hash));
            assert.equal((await ctx.request('GET', '/auth/profile', { token: other.body.data.accessToken })).status, 401);
            assert.equal((await ctx.request('GET', '/auth/profile', { token: me.body.data.accessToken })).status, 200);

            ctx.world.users[ALICE].password_hash = PASSWORD_HASH;
        });

        test('password reset signs out every device', async () => {
            const a = await ctx.login();
            const resetToken = 'a'.repeat(64);
            ctx.world.resets.push({ user_id: ALICE, token_hash: sha256(resetToken) });

            const res = await ctx.request('POST', '/auth/reset-password', { body: { token: resetToken, password: 'new-password' }, refreshHeader: false });
            assert.equal(res.status, 200);
            const live = Object.values(ctx.world.sessions).filter(s => s.user_id === ALICE && !s.revoked_at);
            assert.equal(live.length, 0);
            assert.equal((await ctx.request('GET', '/auth/profile', { token: a.body.data.accessToken })).status, 401);

            ctx.world.users[ALICE].password_hash = PASSWORD_HASH;
        });

        test('logout revokes this session and clears the cookie, even with an expired access token', async () => {
            const a = await ctx.login();
            const sid = jwt.decode(a.body.data.accessToken).sid;
            const res = await ctx.request('POST', '/auth/logout', { cookie: a.cookie });
            assert.equal(res.status, 200);
            assert.match(res.setCookie, /frichat_refresh=;/);
            assert.equal(ctx.world.sessions[sid].revoked_reason, 'logout');
        });

        test('register: signs in, sends a single-use verification link (hash stored), verifying unlocks the account', async () => {
            const res = await ctx.request('POST', '/auth/register', { body: { username: 'carol', email: 'carol@example.com', password: 'secret1' }, refreshHeader: false });
            assert.equal(res.status, 201);
            assert.equal(res.body.data.emailVerified, false);
            assert.ok(res.cookie);

            const token = /token=([a-f0-9]{64})$/.exec(ctx.world.lastVerificationUrl)[1];
            const stored = ctx.world.verifications.find(v => v.user_id === res.body.data.userId);
            assert.equal(stored.token_hash, sha256(token));
            assert.equal(stored.hours, 24);

            const verified = await ctx.request('POST', '/auth/verify-email', { body: { token }, refreshHeader: false });
            assert.equal(verified.status, 200);
            assert.ok(ctx.world.users[res.body.data.userId].email_verified_at);
            assert.ok(ctx.emitted.some(e => e.room === `user_${res.body.data.userId}` && e.event === 'email_verified'));

            const again = await ctx.request('POST', '/auth/verify-email', { body: { token }, refreshHeader: false });
            assert.equal(again.status, 400, 'single use');
        });

        test('resend verification: refused once verified, works for unverified accounts', async () => {
            const alice = await ctx.login('alice');
            const done = await ctx.request('POST', '/auth/resend-verification', { token: alice.body.data.accessToken });
            assert.equal(done.status, 400);
            assert.equal(done.body.code, 'ALREADY_VERIFIED');

            const bob = await ctx.login('bob');
            const sent = await ctx.request('POST', '/auth/resend-verification', { token: bob.body.data.accessToken });
            assert.equal(sent.status, 200);
            assert.equal(ctx.world.verifications.filter(v => v.user_id === BOB).length, 1, 'older links are replaced');
        });
    });
}

describe('rate limiting of verification emails', () => {
    test('a user gets at most 3 resends per 15 minutes', async () => {
        const ctx = await startApp('mysql');
        try {
            const bob = await ctx.login('bob');
            const statuses = [];
            for (let i = 0; i < 4; i++) {
                statuses.push((await ctx.request('POST', '/auth/resend-verification', { token: bob.body.data.accessToken })).status);
            }
            assert.deepEqual(statuses, [200, 200, 200, 429]);
        } finally {
            await ctx.stop();
        }
    });
});

describe('Socket.IO handshake checks the session every time', () => {
    for (const dbType of ['mysql', 'postgresql']) {
        test(`valid, expired, legacy and revoked tokens (${dbType})`, async () => {
            const ctx = await startApp(dbType);
            try {
                const middleware = ctx.io.of('/')._fns[0];
                const handshake = (token) => new Promise((resolve) => {
                    const socket = { handshake: { auth: { token }, headers: {}, address: '::ffff:10.0.0.7' } };
                    middleware(socket, (error) => resolve({ error, socket }));
                });

                const res = await ctx.login();
                const sid = jwt.decode(res.body.data.accessToken).sid;

                const ok = await handshake(res.body.data.accessToken);
                assert.equal(ok.error, undefined);
                assert.equal(ok.socket.userId, ALICE);
                assert.equal(ok.socket.sessionId, sid);

                assert.equal((await handshake(null)).error.message, 'Access token required');
                const expired = jwt.sign({ userId: ALICE, sid, exp: Math.floor(Date.now() / 1000) - 5 }, 'test-secret');
                assert.equal((await handshake(expired)).error.message, 'Invalid or expired token');
                assert.equal((await handshake(jwt.sign({ userId: ALICE }, 'test-secret'))).error.message, 'Invalid or expired token');

                // Reconnecting with a token from a revoked session is refused
                ctx.world.sessions[sid].revoked_at = 'now';
                assert.equal((await handshake(res.body.data.accessToken)).error.message, 'Session revoked');
            } finally {
                await ctx.stop();
            }
        });
    }
});

describe('cookie settings', () => {
    test('COOKIE_SAMESITE=none forces Secure; COOKIE_SECURE=false is honoured otherwise', () => {
        const config = require('../config/auth');
        process.env.COOKIE_SAMESITE = 'none';
        process.env.COOKIE_SECURE = 'false';
        assert.deepEqual([config.refreshCookieOptions().sameSite, config.refreshCookieOptions().secure], ['none', true]);
        process.env.COOKIE_SAMESITE = 'lax';
        assert.deepEqual([config.refreshCookieOptions().sameSite, config.refreshCookieOptions().secure], ['lax', false]);
        process.env.COOKIE_SAMESITE = 'bogus';
        delete process.env.COOKIE_SECURE;
        assert.deepEqual([config.refreshCookieOptions().sameSite, config.refreshCookieOptions().secure], ['strict', true]);
        assert.equal(config.refreshCookieOptions().httpOnly, true);
        delete process.env.COOKIE_SAMESITE;
    });

    test('device labels', () => {
        const { describeDevice } = require('../utils/sessions');
        assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), 'Edge on Windows');
        assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), 'Chrome on Android');
        assert.equal(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'Safari on macOS');
        assert.equal(describeDevice(''), 'Unknown device');
        assert.equal(describeDevice('curl/8.0'), 'Unknown device');
    });
});
