/**
 * Phase 14 acceptance tests on a real PostgreSQL database, through the real server.js over HTTP.
 * Skipped unless TEST_PG_DATABASE names a database that already has the schema. It is written to and
 * emptied of test users, so never point it at one you care about:
 *
 *   TEST_PG_DATABASE=frichat_test npm test
 *
 * The connection settings come from the environment or .env, as for the server. Nothing here stubs
 * the database, and only the SMTP transport is replaced (to read the emails). The fake-driver tests
 * in phase14.test.js cover the same rules on MySQL.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const yauzl = require('yauzl');
const { generateSync } = require('otplib');
const { stubModule, listenForFetch } = require('./helpers/fakeDb');

const DATABASE = process.env.TEST_PG_DATABASE;
const PASSWORD = 'correct horse battery';
const BOB_PRIVATE_EMAIL = 'bob-private@example.test';

const ctx = {};
let ipCounter = 0;

// Every call gets its own client IP, so the per-IP limiters only count where a test means them to
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function call(method, url, { body, token, cookie, ip, headers = {} } = {}) {
    const res = await fetch(`${ctx.base}${url}`, {
        method,
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': ip || freshIp(),
            ...(token && { Authorization: `Bearer ${token}` }),
            ...(cookie && { Cookie: cookie }),
            ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: data, headers: res.headers, cookies: res.headers.getSetCookie() };
}

function cookieHeader(res) {
    return res.cookies.map(cookie => cookie.split(';')[0]).join('; ');
}

const sql = (text, params) => ctx.db.executeQuery(text, params);
const one = (text, params) => ctx.db.queryOne(text, params);

async function createUser(name, overrides = {}) {
    const id = await ctx.db.insertAndGetId(
        'INSERT INTO users (username, email, password_hash, full_name, bio, email_verified_at, is_admin) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)',
        [name, overrides.email || `${name}@example.test`, await bcrypt.hash(PASSWORD, 4), `${name} Fullname`, `${name} private bio`, !!overrides.isAdmin]
    );
    return { id: Number(id), username: name, email: overrides.email || `${name}@example.test` };
}

const login = (user, password = PASSWORD, options = {}) => call('POST', '/api/auth/login', { body: { username: user.username, password }, ...options });

/**
 * A code nobody has used yet: the replay guard is cleared unless a test is about it
 */
async function totp(user, { keepStep = false, epochOffset = 0 } = {}) {
    if (!keepStep) await sql('UPDATE users SET totp_last_step = NULL WHERE id = ?', [user.id]);
    return generateSync({ secret: user.secret, epoch: Math.floor(Date.now() / 1000) + epochOffset });
}

async function enableTwoFactor(user, token) {
    const setup = await call('POST', '/api/auth/2fa/setup', { token, body: { password: PASSWORD } });
    assert.equal(setup.status, 200);
    user.secret = setup.body.data.secret;
    const confirm = await call('POST', '/api/auth/2fa/confirm', { token, body: { code: await totp(user) } });
    assert.equal(confirm.status, 200);
    user.recoveryCodes = confirm.body.data.recoveryCodes;
    return confirm;
}

async function loginWithCode(user, options = {}) {
    const first = await login(user, PASSWORD, options);
    assert.equal(first.body.data.twoFactorRequired, true);
    return call('POST', '/api/auth/login/2fa', { body: { challengeToken: first.body.data.challengeToken, code: await totp(user) }, ...options });
}

function handshake(token) {
    const middleware = ctx.io.of('/')._fns[0];
    return new Promise((resolve) => {
        const socket = { handshake: { auth: { token }, headers: {}, address: '127.0.0.1' } };
        middleware(socket, error => resolve(error ? error.message : 'connected'));
    });
}

function refreshWith(cookie) {
    return call('POST', '/api/auth/refresh', { cookie, headers: { 'X-FriChat-Refresh': '1' } });
}

async function mailsTo(address) {
    await new Promise(resolve => setImmediate(resolve));
    return ctx.mails.filter(mail => mail.to === address).map(mail => mail.subject);
}

function readZip(buffer) {
    return new Promise((resolve, reject) => {
        const entries = {};
        yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (error, zip) => {
            if (error) return reject(error);
            zip.on('entry', (entry) => {
                zip.openReadStream(entry, (openError, stream) => {
                    if (openError) return reject(openError);
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.on('end', () => {
                        entries[entry.fileName] = Buffer.concat(chunks);
                        zip.readEntry();
                    });
                });
            });
            zip.on('end', () => resolve(entries));
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}

async function createChat(type, name, members) {
    const chatId = Number(await ctx.db.insertAndGetId('INSERT INTO chats (chat_type, chat_name) VALUES (?, ?)', [type, name]));
    for (const [user, role] of members) {
        await sql('INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, ?)', [chatId, user.id, role || 'member']);
    }
    return chatId;
}

const sendMessage = async (chatId, user, content, extra = {}) => Number(await ctx.db.insertAndGetId(
    'INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, is_forwarded) VALUES (?, ?, ?, ?, ?, ?)',
    [chatId, user.id, extra.type || 'text', content, extra.fileId || null, !!extra.forwarded]
));

async function addUpload(user, originalName, bytes) {
    const stored = `${crypto.randomBytes(8).toString('hex')}.txt`;
    const fullPath = path.join(ctx.uploadDir, stored);
    fs.writeFileSync(fullPath, bytes);
    const fileId = Number(await ctx.db.insertAndGetId(
        'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [originalName, stored, 'file', bytes.length, 'application/pdf', fullPath, user.id]
    ));
    return { fileId, fullPath };
}

/**
 * Every text-like column of every table, for anything still holding one of these strings
 */
async function findEverywhere(needles) {
    const columns = await sql(`
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'character')
    `);
    const hits = [];
    for (const { table_name: table, column_name: column } of columns) {
        for (const needle of needles) {
            const row = await one(`SELECT COUNT(*) AS total FROM "${table}" WHERE "${column}" ILIKE ?`, [`%${needle}%`]);
            if (Number(row.total) > 0) hits.push(`${table}.${column}: ${needle}`);
        }
    }
    return hits;
}

describe('phase 14 on PostgreSQL', { skip: DATABASE ? false : 'set TEST_PG_DATABASE to run' }, () => {
    before(async () => {
        ctx.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-p14-uploads-'));
        ctx.privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-p14-private-'));
        Object.assign(process.env, {
            DB_TYPE: 'postgresql',
            DB_NAME: DATABASE,
            PORT: '0',
            JWT_SECRET: 'integration-test-secret',
            TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
            UPLOAD_PATH: ctx.uploadDir,
            DATA_EXPORT_PATH: path.join(ctx.privateDir, 'exports'),
            TRUST_PROXY: '1',
            SMTP_HOST: 'smtp.test',
            VAPID_PUBLIC_KEY: '',
            VAPID_PRIVATE_KEY: ''
        });
        ctx.mails = [];
        stubModule('nodemailer', { createTransport: () => ({ sendMail: async (mail) => { ctx.mails.push(mail); } }) });

        ctx.log = console.log;
        console.log = () => {};

        // The jobs run when a test calls them: the timers would keep this process alive
        ctx.scheduler = require('../utils/scheduler');
        ctx.scheduler.startScheduler = () => {};

        const { app, io } = require('../server');
        ctx.io = io;
        ctx.db = require('../config/database');
        ctx.dataExport = require('../utils/dataExport');
        ctx.deletion = require('../utils/accountDeletion');
        ctx.server = await listenForFetch(app);
        ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
    });

    after(async () => {
        console.log = ctx.log;
        if (!ctx.server) return;
        await new Promise(resolve => ctx.server.close(resolve));
        ctx.io.close();
        await ctx.db.db.end();
        fs.rmSync(ctx.uploadDir, { recursive: true, force: true });
        fs.rmSync(ctx.privateDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        ctx.mails.length = 0;
        // Children go with their users; audit_log has no foreign keys and is simply left behind
        await sql('DELETE FROM chats');
        await sql('DELETE FROM files');
        await sql('DELETE FROM reports');
        await sql('DELETE FROM users');
    });

    describe('a second factor can\'t be skipped', () => {
        test('setup: password, QR code and manual key, the secret is encrypted, and it starts only after a first code', async () => {
            const alice = await createUser('alice');
            const { body: { data: { accessToken } } } = await login(alice);

            assert.equal((await call('POST', '/api/auth/2fa/setup', { token: accessToken, body: { password: 'wrong' } })).status, 400);

            const setup = await call('POST', '/api/auth/2fa/setup', { token: accessToken, body: { password: PASSWORD } });
            assert.equal(setup.status, 200);
            assert.match(setup.body.data.qrCode, /^data:image\/png;base64,/);
            assert.match(setup.body.data.secret, /^[A-Z2-7]{32}$/);
            assert.match(setup.body.data.otpauthUrl, /^otpauth:\/\/totp\/FriChat:alice\?/);

            const row = await one('SELECT totp_pending_enc, totp_enabled_at FROM users WHERE id = ?', [alice.id]);
            assert.equal(row.totp_enabled_at, null, 'not on until confirmed');
            assert.ok(!row.totp_pending_enc.includes(setup.body.data.secret), 'never stored in the clear');

            // Until confirmed, a sign-in still needs only the password
            assert.ok((await login(alice)).body.data.accessToken);

            alice.secret = setup.body.data.secret;
            assert.equal((await call('POST', '/api/auth/2fa/confirm', { token: accessToken, body: { code: '000000' } })).status, 400);
            const confirm = await call('POST', '/api/auth/2fa/confirm', { token: accessToken, body: { code: await totp(alice) } });
            assert.equal(confirm.status, 200);
            assert.equal(confirm.body.data.recoveryCodes.length, 10);
            assert.equal(new Set(confirm.body.data.recoveryCodes).size, 10);

            const stored = await sql('SELECT code_hash FROM recovery_codes WHERE user_id = ?', [alice.id]);
            assert.equal(stored.length, 10);
            for (const code of confirm.body.data.recoveryCodes) {
                assert.ok(!stored.some(row2 => row2.code_hash.includes(code)), 'stored hashed');
            }

            const after2 = await one('SELECT totp_secret_enc FROM users WHERE id = ?', [alice.id]);
            assert.ok(!after2.totp_secret_enc.includes(alice.secret));

            // The device that set it up stays signed in
            assert.equal((await call('GET', '/api/auth/profile', { token: accessToken })).body.data.twoFactorEnabled, true);
        });

        test('turning it on ends every session that never passed it: REST, refresh and sockets', async () => {
            const alice = await createUser('alice');
            const other = await login(alice);
            const mine = await login(alice);
            assert.equal(await handshake(other.body.data.accessToken), 'connected');

            await enableTwoFactor(alice, mine.body.data.accessToken);

            assert.equal((await call('GET', '/api/auth/profile', { token: other.body.data.accessToken })).status, 401);
            assert.equal((await refreshWith(cookieHeader(other))).status, 401);
            assert.equal(await handshake(other.body.data.accessToken), 'Session revoked');
            assert.equal((await call('GET', '/api/auth/profile', { token: mine.body.data.accessToken })).status, 200);

            // Actually ended, not only refused, so turning 2FA off again can't bring them back
            const reasons = await sql('SELECT revoked_reason FROM sessions WHERE user_id = ? ORDER BY id', [alice.id]);
            assert.deepEqual(reasons.map(row => row.revoked_reason), ['2fa', null]);
        });

        test('the password alone gets nothing: no session, no cookie, and the challenge opens nothing', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const before2 = await one('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?', [alice.id]);

            const res = await login(alice);
            assert.equal(res.status, 200);
            assert.equal(res.body.data.twoFactorRequired, true);
            assert.equal(res.body.data.accessToken, undefined);
            assert.deepEqual(res.cookies, [], 'no refresh or device cookie before the second factor');
            assert.equal(res.body.data.userId, undefined);

            const after2 = await one('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?', [alice.id]);
            assert.equal(after2.total, before2.total, 'no session row');

            const { challengeToken } = res.body.data;
            assert.equal((await call('GET', '/api/auth/profile', { token: challengeToken })).status, 401);
            assert.equal((await call('GET', '/api/chats', { token: challengeToken })).status, 401);
            assert.equal((await call('POST', '/api/account/exports', { token: challengeToken })).status, 401);
            assert.equal(await handshake(challengeToken), 'Invalid or expired token');

            // Nor can an access token stand in for a challenge
            const full = await loginWithCode(alice);
            const swapped = await call('POST', '/api/auth/login/2fa', { body: { challengeToken: full.body.data.accessToken, code: await totp(alice) } });
            assert.equal(swapped.status, 401);
            assert.equal(swapped.body.code, 'CHALLENGE_EXPIRED');
        });

        test('a session without the second factor is refused however it came to exist', async () => {
            const alice = await createUser('alice');
            const res = await login(alice);
            await enableTwoFactor(alice, res.body.data.accessToken);

            // As if some other code path had started a session and skipped the check
            const sessions = require('../utils/sessions');
            const forged = await sessions.createSession(alice.id, { userAgent: 'x', ip: '10.0.0.1' });
            const { accessToken } = sessions.signAccessToken({ id: alice.id, username: 'alice' }, forged.sessionId);
            const cookie = `frichat_refresh=${forged.refreshToken}`;

            assert.equal((await call('GET', '/api/auth/profile', { token: accessToken })).status, 401);
            assert.equal((await call('GET', '/api/chats', { token: accessToken })).status, 401);
            assert.equal(await handshake(accessToken), 'Session revoked');

            const refresh = await refreshWith(cookie);
            assert.equal(refresh.status, 401);
            assert.equal(refresh.body.data, undefined, 'no new access token');
            const row = await one('SELECT revoked_at, revoked_reason FROM sessions WHERE id = ?', [forged.sessionId]);
            assert.ok(row.revoked_at, 'and the session is ended');
            assert.equal(row.revoked_reason, '2fa');
        });

        test('a password reset does not sign anyone in or remove the second factor', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);

            await call('POST', '/api/auth/forgot-password', { body: { email: alice.email } });
            const link = ctx.mails.find(mail => /reset/i.test(mail.subject));
            const token = /token=([a-f0-9]{64})/.exec(link.text)[1];
            const reset = await call('POST', '/api/auth/reset-password', { body: { token, password: 'a brand new password' } });
            assert.equal(reset.status, 200);
            assert.equal(reset.body.data, undefined);
            assert.deepEqual(reset.cookies, []);

            const after2 = await login(alice, 'a brand new password');
            assert.equal(after2.body.data.twoFactorRequired, true);
            assert.equal(after2.body.data.accessToken, undefined);
        });

        test('a valid code signs in and that session keeps working through refresh and sockets; the code is then spent', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);

            const first = await login(alice);
            const code = await totp(alice);
            const res = await call('POST', '/api/auth/login/2fa', { body: { challengeToken: first.body.data.challengeToken, code } });
            assert.equal(res.status, 200);
            assert.ok(res.body.data.accessToken);
            assert.equal(res.body.data.twoFactorEnabled, true);
            assert.equal(await handshake(res.body.data.accessToken), 'connected');

            const stored = Number((await one('SELECT totp_last_step FROM users WHERE id = ?', [alice.id])).totp_last_step);
            assert.ok(Math.abs(stored - Math.floor(Date.now() / 30000)) <= 1, 'the step of the code that was used');

            const refreshed = await refreshWith(cookieHeader(res));
            assert.equal(refreshed.status, 200);
            assert.equal(await handshake(refreshed.body.data.accessToken), 'connected');

            // The same code on a new challenge
            const second = await login(alice);
            const replay = await call('POST', '/api/auth/login/2fa', { body: { challengeToken: second.body.data.challengeToken, code } });
            assert.equal(replay.status, 401);
            assert.equal(replay.body.code, 'INVALID_2FA_CODE');
        });

        test('a code from the step before the last one used can\'t be replayed either', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            await sql('UPDATE users SET totp_last_step = NULL WHERE id = ?', [alice.id]);

            const challenge = async () => (await login(alice)).body.data.challengeToken;
            const newer = await totp(alice, { keepStep: true });
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken: await challenge(), code: newer } })).status, 200);

            const older = await totp(alice, { keepStep: true, epochOffset: -30 });
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken: await challenge(), code: older } })).status, 401);
        });

        test('wrong codes lock the account: a right code then fails too, a new challenge doesn\'t help, and it passes', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const { challengeToken } = (await login(alice)).body.data;

            for (let i = 0; i < 4; i++) {
                assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: '000000' } })).status, 401);
            }
            const locked = await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: '000000' } });
            assert.equal(locked.status, 429);
            assert.equal(locked.body.code, 'TWO_FACTOR_LOCKED');
            assert.ok(Number(locked.headers.get('retry-after')) > 0);

            const correct = await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: await totp(alice) } });
            assert.equal(correct.status, 429, 'a valid code is refused during the lock');

            const fresh = (await login(alice)).body.data.challengeToken;
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken: fresh, code: await totp(alice) } })).status, 429);
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken: fresh, code: alice.recoveryCodes[0] } })).status, 429);

            await sql('UPDATE users SET totp_locked_until = CURRENT_TIMESTAMP - INTERVAL \'1 minute\' WHERE id = ?', [alice.id]);
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken: fresh, code: await totp(alice) } })).status, 200);
            const row = await one('SELECT totp_failed_attempts, totp_locked_until FROM users WHERE id = ?', [alice.id]);
            assert.equal(row.totp_failed_attempts, 0);
            assert.equal(row.totp_locked_until, null);
        });

        test('parallel guesses can\'t get past the limit', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const { challengeToken } = (await login(alice)).body.data;

            const results = await Promise.all(Array.from({ length: 20 }, () => (
                call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: '000000' } })
            )));
            const checked = results.filter(res => res.body.code === 'INVALID_2FA_CODE').length;
            assert.ok(checked <= 5, `${checked} codes were actually checked`);
            assert.ok(results.some(res => res.status === 429));
        });

        test('the IP limiter stops a run of attempts before the account lock would', async () => {
            const alice = await createUser('alice');
            const ip = '10.9.9.9';
            let limited = null;
            for (let i = 0; i < 25 && !limited; i++) {
                const res = await call('POST', '/api/auth/login/2fa', { ip, body: { challengeToken: 'x', code: '000000' } });
                if (res.status === 429) limited = res;
            }
            assert.ok(limited, 'rate limited');
            assert.ok(alice);
        });

        test('recovery codes work once, in any format, and report what is left', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const [code] = alice.recoveryCodes;

            const res = await call('POST', '/api/auth/login/2fa', {
                body: { challengeToken: (await login(alice)).body.data.challengeToken, code: code.toLowerCase().replace(/-/g, ' ') }
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.recoveryCodesLeft, 9);
            assert.ok((await mailsTo(alice.email)).includes('A FriChat recovery code was used'));

            const again = await call('POST', '/api/auth/login/2fa', { body: { challengeToken: (await login(alice)).body.data.challengeToken, code } });
            assert.equal(again.status, 401);
        });

        test('turning it off and new recovery codes need the password and a code', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const token = (await loginWithCode(alice)).body.data.accessToken;

            for (const route of ['/api/auth/2fa/disable', '/api/auth/2fa/recovery-codes']) {
                assert.equal((await call('POST', route, { token, body: { password: 'wrong', code: await totp(alice) } })).body.code, 'WRONG_PASSWORD');
                assert.equal((await call('POST', route, { token, body: { password: PASSWORD } })).body.code, 'TWO_FACTOR_CODE_REQUIRED');
                assert.equal((await call('POST', route, { token, body: { password: PASSWORD, code: '000000' } })).body.code, 'INVALID_2FA_CODE');
            }

            const regenerated = await call('POST', '/api/auth/2fa/recovery-codes', { token, body: { password: PASSWORD, code: await totp(alice) } });
            assert.equal(regenerated.status, 200);
            assert.equal(regenerated.body.data.recoveryCodes.length, 10);
            const dead = await call('POST', '/api/auth/login/2fa', { body: { challengeToken: (await login(alice)).body.data.challengeToken, code: alice.recoveryCodes[1] } });
            assert.equal(dead.status, 401, 'the old set is gone');

            assert.equal((await call('POST', '/api/auth/2fa/disable', { token, body: { password: PASSWORD, code: await totp(alice) } })).status, 200);
            assert.ok((await login(alice)).body.data.accessToken, 'the password is enough again');
            const row = await one('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = ?', [alice.id]);
            assert.equal(row.totp_secret_enc, null);
            assert.equal(row.totp_enabled_at, null);
            assert.equal((await one('SELECT COUNT(*) AS total FROM recovery_codes WHERE user_id = ?', [alice.id])).total, '0');
        });

        test('wrong codes in settings share the sign-in lock, and don\'t sign anyone out', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const token = (await loginWithCode(alice)).body.data.accessToken;

            let last;
            for (let i = 0; i < 5; i++) {
                last = await call('POST', '/api/auth/2fa/disable', { token, body: { password: PASSWORD, code: '000000' } });
                assert.notEqual(last.status, 401);
            }
            assert.equal(last.status, 429);
            const { challengeToken } = (await login(alice)).body.data;
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: await totp(alice) } })).status, 429);
        });

        test('a challenge dies when the password changes or the account is suspended', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);

            const { challengeToken } = (await login(alice)).body.data;
            await sql('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash('changed password', 4), alice.id]);
            const expired = await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: await totp(alice) } });
            assert.equal(expired.status, 401);
            assert.equal(expired.body.code, 'CHALLENGE_EXPIRED');

            const next = (await login(alice, 'changed password')).body.data.challengeToken;
            await sql('UPDATE users SET suspended_at = CURRENT_TIMESTAMP WHERE id = ?', [alice.id]);
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken: next, code: await totp(alice) } })).status, 403);
        });

        test('without the encryption key, sign-in fails closed', async () => {
            const alice = await createUser('alice');
            await enableTwoFactor(alice, (await login(alice)).body.data.accessToken);
            const { challengeToken } = (await login(alice)).body.data;

            const key = process.env.TOTP_ENCRYPTION_KEY;
            process.env.TOTP_ENCRYPTION_KEY = '';
            const log = console.error;
            console.error = () => {};
            try {
                const res = await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: await totp(alice) } });
                assert.equal(res.status, 500);
                assert.equal(res.body.data, undefined);
                const start = await call('POST', '/api/auth/2fa/setup', { token: (await login(await createUser('bob'))).body.data.accessToken, body: { password: PASSWORD } });
                assert.equal(start.status, 503);
            } finally {
                console.error = log;
                process.env.TOTP_ENCRYPTION_KEY = key;
            }
        });

        test('a secret copied onto another row won\'t decrypt', async () => {
            const twoFactor = require('../utils/twoFactor');
            const stored = twoFactor.encryptSecret('SECRET', 1);
            assert.equal(twoFactor.decryptSecret(stored, 1), 'SECRET');
            assert.throws(() => twoFactor.decryptSecret(stored, 2));
            const [v, iv, tag, body] = stored.split('.');
            const flipped = Buffer.from(body, 'base64url');
            flipped[0] ^= 1;
            assert.throws(() => twoFactor.decryptSecret([v, iv, tag, flipped.toString('base64url')].join('.'), 1));
        });

        test('admins need 2FA for the console, and the session must have passed it', async () => {
            const admin = await createUser('root', { isAdmin: true });
            const token = (await login(admin)).body.data.accessToken;

            const refused = await call('GET', '/api/admin/users', { token });
            assert.equal(refused.status, 403);
            assert.equal(refused.body.code, 'TWO_FACTOR_REQUIRED');
            assert.equal((await call('GET', '/api/admin/config', { token })).status, 403);

            await enableTwoFactor(admin, token);
            assert.equal((await call('GET', '/api/admin/config', { token })).status, 200);

            const fresh = await loginWithCode(admin);
            assert.equal((await call('GET', '/api/admin/users', { token: fresh.body.data.accessToken })).status, 200);
        });
    });

    describe('security activity and emails', () => {
        test('a new device gets an email; a known one, a first sign-in and a registration don\'t', async () => {
            const alice = await createUser('alice');
            const first = await login(alice);
            assert.deepEqual(await mailsTo(alice.email), [], 'the first device is the baseline');
            const device = cookieHeader(first).split('; ').find(cookie => cookie.startsWith('frichat_device'));
            assert.ok(device);
            assert.ok(first.cookies.some(cookie => /^frichat_device=.*HttpOnly/i.test(cookie)));

            await login(alice, PASSWORD, { cookie: device });
            assert.deepEqual(await mailsTo(alice.email), []);

            await login(alice, PASSWORD, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' }, ip: '203.0.113.9' });
            assert.deepEqual(await mailsTo(alice.email), ['New sign-in to your FriChat account']);
            const mail = ctx.mails.find(item => item.to === alice.email);
            assert.match(mail.text, /Chrome on Windows/);
            assert.match(mail.text, /203\.0\.113\.9/);

            const stored = await sql('SELECT device_hash FROM known_devices WHERE user_id = ?', [alice.id]);
            assert.equal(stored.length, 2);
            assert.ok(!stored.some(row => device.includes(row.device_hash)), 'the cookie is stored hashed');
        });

        test('a browser with a live session from before this feature is adopted on refresh, without an email', async () => {
            const alice = await createUser('alice');
            const sessions = require('../utils/sessions');
            const old = await sessions.createSession(alice.id, { userAgent: 'x', ip: null });

            const refreshed = await refreshWith(`frichat_refresh=${old.refreshToken}`);
            assert.equal(refreshed.status, 200);
            assert.ok(refreshed.cookies.some(cookie => cookie.startsWith('frichat_device=')));
            assert.deepEqual(await mailsTo(alice.email), []);

            // So a sign-in from somewhere else now does count as new
            await login(alice);
            assert.deepEqual(await mailsTo(alice.email), ['New sign-in to your FriChat account']);
        });

        test('password, email and 2FA changes each send an email; email changes reach the old address', async () => {
            const alice = await createUser('alice');
            const first = await login(alice);
            const token = first.body.data.accessToken;

            assert.equal((await call('PUT', '/api/auth/password', { token, body: { currentPassword: PASSWORD, newPassword: 'another password' } })).status, 200);
            assert.ok((await mailsTo(alice.email)).includes('Your FriChat password was changed'));
            await sql('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(PASSWORD, 4), alice.id]);

            await enableTwoFactor(alice, token);
            assert.ok((await mailsTo(alice.email)).includes('Two-factor authentication is on'));

            assert.equal((await call('PUT', '/api/auth/email', { token, body: { password: PASSWORD, code: await totp(alice), newEmail: 'wrong' } })).status, 400);
            assert.equal((await call('PUT', '/api/auth/email', { token, body: { password: PASSWORD, newEmail: 'new@example.test' } })).body.code, 'TWO_FACTOR_CODE_REQUIRED');
            const changed = await call('PUT', '/api/auth/email', { token, body: { password: PASSWORD, code: await totp(alice), newEmail: 'new@example.test' } });
            assert.equal(changed.status, 200);
            assert.ok((await mailsTo(alice.email)).includes('Your FriChat email address was changed'));
            assert.ok((await mailsTo('new@example.test')).includes('Verify your FriChat email address'));
            const row = await one('SELECT email, email_verified_at FROM users WHERE id = ?', [alice.id]);
            assert.equal(row.email, 'new@example.test');
            assert.equal(row.email_verified_at, null);

            const bob = await createUser('bob');
            assert.equal((await call('PUT', '/api/auth/email', { token, body: { password: PASSWORD, code: await totp(alice), newEmail: bob.email } })).body.code, 'EMAIL_UNAVAILABLE');

            assert.equal((await call('POST', '/api/auth/2fa/disable', { token, body: { password: PASSWORD, code: await totp(alice) } })).status, 200);
            assert.ok((await mailsTo('new@example.test')).includes('Two-factor authentication is off'));
        });

        test('a failing mail server doesn\'t fail the change it reports', async () => {
            const alice = await createUser('alice');
            const token = (await login(alice)).body.data.accessToken;
            const mailer = require('nodemailer');
            assert.ok(mailer);
            const push = ctx.mails.push;
            const log = console.error;
            console.error = () => {};
            ctx.mails.push = () => { throw new Error('smtp down'); };
            try {
                assert.equal((await call('PUT', '/api/auth/password', { token, body: { currentPassword: PASSWORD, newPassword: 'another password' } })).status, 200);
                await new Promise(resolve => setImmediate(resolve));
            } finally {
                ctx.mails.push = push;
                console.error = log;
            }
        });

        test('the list shows your own events with device and IP, never someone else\'s or who acted', async () => {
            const alice = await createUser('alice');
            const bob = await createUser('bob');
            await login(alice, 'wrong password');
            const res = await login(alice, PASSWORD, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' }, ip: '203.0.113.7' });
            await login(bob);

            const activity = await call('GET', '/api/auth/security-activity', { token: res.body.data.accessToken });
            assert.equal(activity.status, 200);
            const events = activity.body.data.entries;
            assert.deepEqual(events.slice(0, 2).map(entry => entry.event), ['login', 'login_failed']);
            assert.equal(events[0].device, 'Chrome on Windows');
            assert.equal(events[0].ipAddress, '203.0.113.7');
            assert.deepEqual(Object.keys(events[0]).sort(), ['createdAt', 'device', 'event', 'id', 'ipAddress']);

            assert.equal((await call('GET', '/api/auth/security-activity?before=abc', { token: res.body.data.accessToken })).status, 400);
            assert.equal((await call('GET', '/api/auth/security-activity')).status, 401);
        });
    });

    describe('data export', () => {
        async function seed() {
            const alice = await createUser('alice');
            const bob = await createUser('bob', { email: BOB_PRIVATE_EMAIL });
            await sql('UPDATE users SET birthday_day = 5, birthday_month = 6 WHERE id = ?', [alice.id]);

            const direct = await createChat('direct', null, [[alice], [bob]]);
            const group = await createChat('group', 'Weekend plans', [[alice, 'admin'], [bob]]);
            const upload = await addUpload(alice, '../../evil<name>.pdf', Buffer.from('alice file bytes'));

            const own = await sendMessage(direct, alice, 'hello "bob"\nwith a line break');
            await sendMessage(group, alice, 'see attachment', { type: 'file', fileId: upload.fileId });
            const theirs = await sendMessage(direct, bob, 'BOBS SECRET TEXT');
            const gone = await sendMessage(direct, alice, 'expired already');
            await sql('UPDATE messages SET expires_at = CURRENT_TIMESTAMP - INTERVAL \'1 minute\' WHERE id = ?', [gone]);
            await sql('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [theirs, alice.id, '👍']);
            await sql('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [own, bob.id, '🎉']);

            const token = (await login(alice)).body.data.accessToken;
            return { alice, bob, direct, group, upload, own, token };
        }

        async function downloadZip(exportId, token) {
            const link = await call('POST', `/api/account/exports/${exportId}/link`, { token });
            assert.equal(link.status, 200);
            const res = await call('GET', link.body.data.path.replace('/account', '/api/account'));
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'application/zip');
            assert.match(res.headers.get('content-disposition'), /^attachment/);
            assert.equal(res.headers.get('cache-control'), 'no-store');
            return res.body;
        }

        test('the export is valid JSON, complete, and has nothing private of anyone else', async () => {
            const { alice, bob, direct, group, upload, own, token } = await seed();

            const asked = await call('POST', '/api/account/exports', { token });
            assert.equal(asked.status, 202);
            const { exportId } = asked.body.data;
            assert.equal((await call('GET', '/api/account/exports', { token })).body.data[0].status, 'pending');

            await ctx.scheduler.runAccountJobs(ctx.io);
            const listed = (await call('GET', '/api/account/exports', { token })).body.data[0];
            assert.equal(listed.status, 'ready');
            assert.ok(Date.parse(listed.expiresAt) > Date.now());
            assert.ok((await mailsTo(alice.email)).includes('Your FriChat data export is ready'));
            const mail = ctx.mails.find(item => /export is ready/.test(item.subject));
            assert.ok(!/token=/.test(mail.text), 'the email can\'t open the export by itself');

            const entries = await readZip(await downloadZip(exportId, token));
            const text = entries['data.json'].toString('utf8');
            const data = JSON.parse(text);

            assert.equal(data.format, 'frichat-data-export');
            assert.equal(data.profile.username, 'alice');
            assert.equal(data.profile.email, alice.email);
            assert.equal(data.profile.bio, 'alice private bio');
            assert.equal(data.profile.birthday_day, 5);

            assert.deepEqual(data.chats.map(chat => chat.id).sort(), [direct, group].sort());
            const groupChat = data.chats.find(chat => chat.id === group);
            assert.equal(groupChat.name, 'Weekend plans');
            assert.equal(groupChat.yourRole, 'admin');
            assert.deepEqual(groupChat.members.find(member => member.username === 'bob'), { username: 'bob', displayName: 'bob Fullname' });

            assert.equal(data.messages.length, 2, 'own messages, without the expired one');
            assert.equal(data.messages[0].id, own);
            assert.equal(data.messages[0].content, 'hello "bob"\nwith a line break');
            assert.equal(data.reactions.length, 1);
            assert.equal(data.reactions[0].emoji, '👍');

            assert.equal(data.files.length, 1);
            assert.equal(data.files[0].name, '../../evil<name>.pdf');
            assert.equal(data.files[0].size, 16);
            assert.deepEqual(data.summary, { chats: 2, messages: 2, reactions: 1, files: 1 });
            assert.ok(data.securityActivity.some(entry => entry.event === 'data_export_requested'));

            // Inside the zip the name is harmless, and the bytes are the file's
            const inZip = data.files[0].pathInArchive;
            assert.match(inZip, /^uploads\/\d+-[^/\\]+$/);
            assert.ok(!inZip.includes('/') || inZip.split('/').length === 2);
            assert.equal(entries[inZip].toString(), 'alice file bytes');
            assert.equal(data.files[0].id, upload.fileId);
            for (const name of Object.keys(entries)) {
                assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), name);
            }

            // Other people: names only
            assert.ok(!text.includes(BOB_PRIVATE_EMAIL));
            assert.ok(!text.includes('BOBS SECRET TEXT'));
            assert.ok(!text.includes('bob private bio'));
            assert.ok(!text.includes('🎉'));
            // No secrets of the user's own either
            assert.ok(!/password_hash|totp_secret|recovery|refresh_token/i.test(text));
            assert.ok(bob);
        });

        test('a soft-deleted message of your own is included and marked; a long history pages correctly', async () => {
            const { direct, token, alice } = await seed();
            const hidden = await sendMessage(direct, alice, 'deleted but still held');
            await sql('UPDATE messages SET deleted_for_everyone = TRUE WHERE id = ?', [hidden]);
            for (let i = 0; i < 2100; i++) {
                await sendMessage(direct, alice, `bulk ${i}`);
            }

            const { exportId } = (await call('POST', '/api/account/exports', { token })).body.data;
            await ctx.scheduler.runAccountJobs(ctx.io);
            const data = JSON.parse((await readZip(await downloadZip(exportId, token)))['data.json']);

            assert.equal(data.messages.length, 2103);
            assert.equal(new Set(data.messages.map(message => message.id)).size, 2103);
            assert.equal(data.messages.find(message => message.id === hidden).deletedForEveryone, true);
        });

        test('asking again: one at a time, then one per cooldown, surviving the in-memory limiter', async () => {
            const { token } = await seed();
            assert.equal((await call('POST', '/api/account/exports', { token })).status, 202);
            const second = await call('POST', '/api/account/exports', { token });
            assert.equal(second.status, 409);

            await ctx.scheduler.runAccountJobs(ctx.io);
            const third = await call('POST', '/api/account/exports', { token });
            assert.equal(third.status, 429);
            assert.equal(third.body.code, 'EXPORT_COOLDOWN');
        });

        test('the route limiter caps requests per user', async () => {
            const { token } = await seed();
            const statuses = [];
            for (let i = 0; i < 7; i++) statuses.push((await call('POST', '/api/account/exports', { token })).status);
            assert.equal(statuses[0], 202);
            assert.deepEqual(statuses.slice(1, 5), [409, 409, 409, 409], 'the database rule');
            assert.deepEqual(statuses.slice(5), [429, 429], 'then the limiter');
        });

        test('only the owner gets a link, a link opens only its own export, and access tokens aren\'t links', async () => {
            const { token, bob } = await seed();
            const { exportId } = (await call('POST', '/api/account/exports', { token })).body.data;
            await ctx.scheduler.runAccountJobs(ctx.io);

            const bobToken = (await login(bob)).body.data.accessToken;
            assert.equal((await call('POST', `/api/account/exports/${exportId}/link`, { token: bobToken })).status, 404);
            assert.equal((await call('GET', '/api/account/exports', { token: bobToken })).body.data.length, 0);

            assert.equal((await call('GET', `/api/account/exports/${exportId}/download`)).status, 400);
            assert.equal((await call('GET', `/api/account/exports/${exportId}/download?token=${token}`)).status, 404);
            const challenge = jwt.sign({ purpose: 'data_export', exportId: exportId + 1, userId: 1 }, process.env.JWT_SECRET);
            assert.equal((await call('GET', `/api/account/exports/${exportId}/download?token=${challenge}`)).status, 404);
            const expired = jwt.sign({ purpose: 'data_export', exportId, userId: 1, exp: 1 }, process.env.JWT_SECRET);
            assert.equal((await call('GET', `/api/account/exports/${exportId}/download?token=${expired}`)).status, 404);

            const link = (await call('POST', `/api/account/exports/${exportId}/link`, { token })).body.data.path;
            const linkToken = decodeURIComponent(link.split('token=')[1]);
            assert.equal((await call('GET', '/api/auth/profile', { token: linkToken })).status, 401);
            assert.equal(await handshake(linkToken), 'Invalid or expired token');
        });

        test('the zip has no URL, and expires off the disk', async () => {
            const { token } = await seed();
            const { exportId } = (await call('POST', '/api/account/exports', { token })).body.data;
            await ctx.scheduler.runAccountJobs(ctx.io);

            const row = await one('SELECT file_name FROM data_exports WHERE id = ?', [exportId]);
            const fullPath = path.join(process.env.DATA_EXPORT_PATH, row.file_name);
            assert.ok(fs.existsSync(fullPath));
            assert.ok(!fullPath.startsWith(ctx.uploadDir));
            assert.equal((await call('GET', `/uploads/${row.file_name}`)).status, 404);

            const link = (await call('POST', `/api/account/exports/${exportId}/link`, { token })).body.data.path;
            await sql('UPDATE data_exports SET expires_at = CURRENT_TIMESTAMP - INTERVAL \'1 minute\' WHERE id = ?', [exportId]);
            assert.equal((await call('GET', link.replace('/account', '/api/account'))).status, 404, 'an old link stops working');

            await ctx.scheduler.runAccountJobs(ctx.io);
            assert.ok(!fs.existsSync(fullPath));
            assert.equal((await one('SELECT status FROM data_exports WHERE id = ?', [exportId])).status, 'expired');
            assert.equal((await call('GET', '/api/account/exports', { token })).body.data[0].status, 'expired');
        });

        test('a build interrupted by a restart runs again; a build that keeps failing gives up', async () => {
            const { token, alice } = await seed();
            const { exportId } = (await call('POST', '/api/account/exports', { token })).body.data;
            await sql('UPDATE data_exports SET status = \'running\', attempts = 1, started_at = CURRENT_TIMESTAMP - INTERVAL \'2 hours\' WHERE id = ?', [exportId]);
            await ctx.scheduler.runAccountJobs(ctx.io);
            assert.equal((await one('SELECT status FROM data_exports WHERE id = ?', [exportId])).status, 'ready');

            await sql('UPDATE data_exports SET status = \'expired\', requested_at = CURRENT_TIMESTAMP - INTERVAL \'3 days\' WHERE id = ?', [exportId]);
            const stuck = Number(await ctx.db.insertAndGetId('INSERT INTO data_exports (user_id, status, attempts, started_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP - INTERVAL \'2 hours\')', [alice.id, 'running', 3]));
            await ctx.scheduler.runAccountJobs(ctx.io);
            assert.equal((await one('SELECT status FROM data_exports WHERE id = ?', [stuck])).status, 'failed');
        });
    });

    describe('account deletion', () => {
        async function seed() {
            const alice = await createUser('alice');
            const bob = await createUser('bob', { email: BOB_PRIVATE_EMAIL });
            const carol = await createUser('carol');
            const token = (await login(alice)).body.data.accessToken;

            const direct = await createChat('direct', null, [[alice], [bob]]);
            const group = await createChat('group', 'Shared group', [[alice, 'admin'], [bob], [carol]]);
            const solo = await createChat('group', 'Only alice', [[alice, 'admin']]);
            const upload = await addUpload(alice, 'alice-holiday-photo.pdf', Buffer.from('private bytes'));
            const soloUpload = await addUpload(alice, 'alice-solo-file.pdf', Buffer.from('solo bytes'));

            const text = await sendMessage(direct, alice, 'A message others should keep');
            const attachment = await sendMessage(direct, alice, 'caption with alice-private-words', { type: 'file', fileId: upload.fileId });
            const forwarded = await sendMessage(group, bob, null, { type: 'file', fileId: upload.fileId, forwarded: true });
            const bobs = await sendMessage(direct, bob, 'Bob replies');
            const hidden = await sendMessage(direct, alice, 'alice-deleted-for-everyone-words');
            await sql('UPDATE messages SET deleted_for_everyone = TRUE, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?', [alice.id, hidden]);
            await sendMessage(solo, alice, 'alone', { type: 'file', fileId: soloUpload.fileId });

            await sql('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [bobs, alice.id, '👍']);
            await sql('INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?, ?, ?, ?, ?)', [alice.id, 'https://push.test/alice-endpoint', 'a'.repeat(64), 'p', 'a']);
            await sql('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', [carol.id, alice.id]);
            await sql('INSERT INTO scheduled_messages (user_id, chat_id, content, send_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP + INTERVAL \'1 hour\')', [alice.id, direct, 'alice-scheduled-words']);
            await sql('INSERT INTO reports (reporter_id, reported_user_id, target_type, reason) VALUES (?, ?, ?, ?)', [bob.id, alice.id, 'user', 'spam']);

            const avatarDir = path.join(ctx.uploadDir, 'avatars');
            fs.mkdirSync(avatarDir, { recursive: true });
            const avatarName = `${'ab'.repeat(16)}.webp`;
            fs.writeFileSync(path.join(avatarDir, avatarName), 'photo');
            await sql('UPDATE users SET avatar_url = ?, custom_status_text = ? WHERE id = ?', [`uploads/avatars/${avatarName}`, 'alice-status-words', alice.id]);

            const { exportId } = (await call('POST', '/api/account/exports', { token })).body.data;
            await ctx.scheduler.runAccountJobs(ctx.io);
            const exportFile = (await one('SELECT file_name FROM data_exports WHERE id = ?', [exportId])).file_name;

            return { alice, bob, carol, token, direct, group, solo, upload, soloUpload, text, attachment, forwarded, avatarPath: path.join(avatarDir, avatarName), exportPath: path.join(process.env.DATA_EXPORT_PATH, exportFile) };
        }

        const makeDue = (user) => sql('UPDATE users SET deletion_due_at = CURRENT_TIMESTAMP - INTERVAL \'1 minute\' WHERE id = ?', [user.id]);

        test('it takes the password, and a code with 2FA on', async () => {
            const alice = await createUser('alice');
            const token = (await login(alice)).body.data.accessToken;
            assert.equal((await call('POST', '/api/account/delete', { token, body: {} })).status, 400);
            assert.equal((await call('POST', '/api/account/delete', { token, body: { password: 'wrong' } })).body.code, 'WRONG_PASSWORD');
            assert.equal((await call('POST', '/api/account/delete')).status, 401);

            await enableTwoFactor(alice, token);
            assert.equal((await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } })).body.code, 'TWO_FACTOR_CODE_REQUIRED');
            assert.equal((await call('POST', '/api/account/delete', { token, body: { password: PASSWORD, code: '000000' } })).body.code, 'INVALID_2FA_CODE');
            assert.equal((await one('SELECT deletion_due_at FROM users WHERE id = ?', [alice.id])).deletion_due_at, null);

            assert.equal((await call('POST', '/api/account/delete', { token, body: { password: PASSWORD, code: await totp(alice) } })).status, 200);
        });

        test('requesting: 14 days of grace, signed out everywhere, nothing goes out for them, an email says when', async () => {
            const { alice, token } = await seed();
            const other = await login(alice);

            const res = await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });
            assert.equal(res.status, 200);
            assert.ok(res.cookies.some(cookie => /^frichat_refresh=;/.test(cookie)), 'the cookie is cleared');
            const days = (Date.parse(res.body.data.deletionDueAt) - Date.now()) / (24 * 60 * 60 * 1000);
            assert.ok(days > 13.99 && days < 14.01, `${days} days`);

            for (const access of [token, other.body.data.accessToken]) {
                assert.equal((await call('GET', '/api/auth/profile', { token: access })).status, 401);
                assert.equal(await handshake(access), 'Session revoked');
            }
            assert.equal((await refreshWith(cookieHeader(other))).status, 401);
            assert.equal((await one('SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ?', [alice.id])).total, '0');
            assert.equal((await one('SELECT status FROM scheduled_messages WHERE user_id = ?', [alice.id])).status, 'cancelled');
            assert.ok((await mailsTo(alice.email)).includes('Your FriChat account will be deleted'));
        });

        test('signing in during the grace period cancels it, but only once sign-in is complete', async () => {
            const alice = await createUser('alice');
            const token = (await login(alice)).body.data.accessToken;
            await enableTwoFactor(alice, token);
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD, code: await totp(alice) } });

            assert.equal((await login(alice, 'wrong password')).status, 401);
            const { challengeToken } = (await login(alice)).body.data;
            assert.equal((await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: '000000' } })).status, 401);
            assert.ok((await one('SELECT deletion_due_at FROM users WHERE id = ?', [alice.id])).deletion_due_at, 'still scheduled: the password alone doesn\'t cancel');

            const res = await call('POST', '/api/auth/login/2fa', { body: { challengeToken, code: await totp(alice) } });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.deletionCancelled, true);
            assert.equal((await one('SELECT deletion_due_at FROM users WHERE id = ?', [alice.id])).deletion_due_at, null);
            assert.ok((await mailsTo(alice.email)).includes('Your FriChat account will not be deleted'));

            await ctx.scheduler.runAccountJobs(ctx.io);
            assert.equal((await one('SELECT username FROM users WHERE id = ?', [alice.id])).username, 'alice');
        });

        test('a password reset during the grace period doesn\'t cancel it; a cancelled deletion isn\'t purged', async () => {
            const alice = await createUser('alice');
            const token = (await login(alice)).body.data.accessToken;
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });

            await call('POST', '/api/auth/forgot-password', { body: { email: alice.email } });
            const link = ctx.mails.find(mail => /reset/i.test(mail.subject));
            await call('POST', '/api/auth/reset-password', { body: { token: /token=([a-f0-9]{64})/.exec(link.text)[1], password: 'a brand new password' } });
            assert.ok((await one('SELECT deletion_due_at FROM users WHERE id = ?', [alice.id])).deletion_due_at);

            const signedIn = await login(alice, 'a brand new password');
            assert.equal(signedIn.body.data.deletionCancelled, true);
            assert.equal(await ctx.deletion.purgeAccount(ctx.io, alice.id), false, 'cancelled, so there is nothing to purge');
            assert.equal((await one('SELECT username FROM users WHERE id = ?', [alice.id])).username, 'alice');
        });

        test('nothing happens before the grace period ends', async () => {
            const { alice, token } = await seed();
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });
            await ctx.scheduler.runAccountJobs(ctx.io);
            assert.equal((await one('SELECT username FROM users WHERE id = ?', [alice.id])).username, 'alice');
        });

        test('after the grace period, personal data is gone from every column and from disk', async () => {
            const world = await seed();
            const { alice, bob, carol, token } = world;
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });
            await makeDue(alice);
            ctx.mails.length = 0;
            await ctx.scheduler.runAccountJobs(ctx.io);

            // The row is a tombstone
            const row = await one('SELECT * FROM users WHERE id = ?', [alice.id]);
            assert.equal(row.full_name, 'Deleted user');
            assert.match(row.username, /^deleted_[a-f0-9]{16}$/);
            assert.match(row.email, /@deleted\.invalid$/);
            assert.ok(row.deleted_at);
            for (const column of ['avatar_url', 'bio', 'custom_status_text', 'last_seen', 'email_verified_at', 'totp_secret_enc', 'deletion_due_at', 'birthday_day']) {
                assert.equal(row[column], null, column);
            }

            // Searching every text column of every table for what identified them
            const needles = [alice.email, 'alice@', 'alice Fullname', 'alice private bio', 'alice-status-words', 'alice-holiday-photo',
                'alice-solo-file', 'alice-private-words', 'alice-deleted-for-everyone-words', 'alice-scheduled-words', 'alice-endpoint', `uploads/avatars/`];
            const hits = (await findEverywhere(needles)).filter(hit => !hit.startsWith('audit_log.'));
            assert.deepEqual(hits, []);

            // Rows about them, table by table
            for (const [table, column] of ctx.deletion.DELETED_ROWS) {
                const count = await one(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`, [alice.id]);
                assert.equal(count.total, '0', `${table}.${column}`);
            }
            assert.equal((await one('SELECT COUNT(*) AS total FROM data_exports WHERE user_id = ?', [alice.id])).total, '0');
            assert.equal((await one('SELECT COUNT(*) AS total FROM files WHERE uploaded_by = ?', [alice.id])).total, '0');

            // Disk
            for (const file of [world.upload.fullPath, world.soloUpload.fullPath, world.avatarPath, world.exportPath]) {
                assert.ok(!fs.existsSync(file), file);
            }

            // Their messages stay for the others, under "Deleted user"
            const bobToken = (await login(bob)).body.data.accessToken;
            const list = await call('GET', `/api/messages/chat/${world.direct}`, { token: bobToken });
            assert.equal(list.status, 200);
            const kept = list.body.data.find(message => message.id === world.text);
            assert.equal(kept.content, 'A message others should keep');
            assert.equal(kept.full_name, 'Deleted user');
            assert.equal(kept.avatar_url ?? null, null);

            // A message whose attachment is gone is deleted, for a forwarded copy too
            const attachment = await one('SELECT content, file_id, deleted_for_everyone FROM messages WHERE id = ?', [world.attachment]);
            assert.deepEqual(attachment, { content: null, file_id: null, deleted_for_everyone: true });
            const forwarded = await one('SELECT file_id, deleted_for_everyone FROM messages WHERE id = ?', [world.forwarded]);
            assert.deepEqual(forwarded, { file_id: null, deleted_for_everyone: true });

            // Groups go on without them, with an admin; a group left empty is gone
            const members = await sql('SELECT user_id, role FROM group_members WHERE chat_id = ? ORDER BY user_id', [world.group]);
            assert.deepEqual(members.map(member => member.user_id), [bob.id, carol.id]);
            assert.ok(members.some(member => member.role === 'admin'));
            assert.equal(await one('SELECT id FROM chats WHERE id = ?', [world.solo]), null);

            // The account is finished
            assert.equal((await login({ username: 'alice' })).status, 401);
            assert.equal((await login({ username: row.username })).status, 401);
            assert.equal((await login({ username: row.email })).status, 401);
            const forgotten = await call('POST', '/api/auth/forgot-password', { body: { email: alice.email } });
            assert.equal(forgotten.status, 200);
            const search = await call('GET', '/api/chats/search/users?query=Deleted', { token: bobToken });
            assert.deepEqual(search.body.data, []);

            // The direct chat stops taking messages
            const send = await call('POST', '/api/messages', { token: bobToken, body: { chatId: world.direct, messageType: 'text', content: 'hello?' } });
            assert.equal(send.status, 403);
            assert.equal(send.body.code, 'ACCOUNT_DELETED');

            // Nor can they be brought back into a chat
            const newGroup = await call('POST', '/api/chats', { token: bobToken, body: { chatType: 'group', chatName: 'New', participants: [alice.id] } });
            assert.equal(newGroup.status, 404);
            const added = await call('POST', `/api/chats/${world.group}/members`, { token: bobToken, body: { userId: alice.id } });
            assert.ok([403, 404].includes(added.status), 'only an admin can try, and it is refused');

            // Someone can use the old address and name again
            const again = await call('POST', '/api/auth/register', { body: { username: 'alice', email: alice.email, password: PASSWORD } });
            assert.equal(again.status, 201);

            assert.ok(ctx.mails.some(mail => mail.to === alice.email && mail.subject === 'Your FriChat account was deleted'));
        });

        test('what stays on purpose: the audit log, and report evidence without the name', async () => {
            const { alice, bob, token } = await seed();
            const report = Number(await ctx.db.insertAndGetId('INSERT INTO reports (reporter_id, reported_user_id, target_type, reason) VALUES (?, ?, ?, ?)', [alice.id, bob.id, 'user', 'spam']));
            await sql(
                'INSERT INTO report_evidence (report_id, position, is_reported, message_id, sender_id, sender_username, message_type, content) VALUES (?, 0, TRUE, 1, ?, ?, ?, ?)',
                [report, alice.id, 'alice', 'text', 'evidence text']
            );
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });
            await makeDue(alice);
            await ctx.scheduler.runAccountJobs(ctx.io);

            const evidence = await one('SELECT sender_id, sender_username, content FROM report_evidence WHERE report_id = ?', [report]);
            assert.deepEqual(evidence, { sender_id: null, sender_username: 'Deleted user', content: 'evidence text' });
            assert.equal((await one('SELECT reporter_id FROM reports WHERE id = ?', [report])).reporter_id, null);

            const audit = await sql('SELECT event FROM audit_log WHERE target_id = ? AND target_type = ?', [alice.id, 'user']);
            assert.ok(audit.some(row => row.event === 'account_deleted'));
            assert.ok(audit.some(row => row.event === 'account_deletion_requested'));
        });

        test('a purge that fails halfway leaves the account due, and the next run finishes it', async () => {
            const world = await seed();
            const { alice, token } = world;
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });
            await makeDue(alice);

            const realUnlink = fs.promises.unlink;
            const log = console.error;
            console.error = () => {};
            fs.promises.unlink = async (target) => {
                if (String(target) === world.upload.fullPath) throw Object.assign(new Error('disk says no'), { code: 'EIO' });
                return realUnlink(target);
            };
            try {
                await ctx.scheduler.runAccountJobs(ctx.io);
            } finally {
                fs.promises.unlink = realUnlink;
                console.error = log;
            }

            let row = await one('SELECT username, deleted_at, deletion_due_at FROM users WHERE id = ?', [alice.id]);
            assert.equal(row.username, 'alice', 'no tombstone yet');
            assert.ok(row.deleted_at, 'already claimed');
            assert.ok(row.deletion_due_at, 'still due');
            assert.ok(fs.existsSync(world.upload.fullPath));
            assert.ok(await one('SELECT id FROM files WHERE id = ?', [world.upload.fileId]), 'the row stays until the file is gone');

            // Half-deleted accounts can't sign in, and a session that somehow survived is refused
            assert.equal((await login(alice)).status, 401);
            const sessions = require('../utils/sessions');
            const leftover = await sessions.createSession(alice.id, { userAgent: 'x', ip: null });
            const { accessToken } = sessions.signAccessToken({ id: alice.id, username: 'alice' }, leftover.sessionId);
            assert.equal((await call('GET', '/api/auth/profile', { token: accessToken })).status, 401);
            assert.equal(await handshake(accessToken), 'Session revoked');
            assert.equal((await refreshWith(`frichat_refresh=${leftover.refreshToken}`)).status, 401);

            await ctx.scheduler.runAccountJobs(ctx.io);
            row = await one('SELECT username, deletion_due_at FROM users WHERE id = ?', [alice.id]);
            assert.match(row.username, /^deleted_/);
            assert.equal(row.deletion_due_at, null);
            assert.ok(!fs.existsSync(world.upload.fullPath));
        });

        test('the race: a sign-in after the purge starts is refused, and one before stops it', async () => {
            const alice = await createUser('alice');
            const token = (await login(alice)).body.data.accessToken;
            await call('POST', '/api/account/delete', { token, body: { password: PASSWORD } });
            await makeDue(alice);

            await sql('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [alice.id]);
            assert.equal((await login(alice)).status, 401);
            assert.equal(await ctx.deletion.cancelDeletion({ id: alice.id }), false);

            await sql('UPDATE users SET deleted_at = NULL, deletion_due_at = NULL WHERE id = ?', [alice.id]);
            assert.equal(await ctx.deletion.purgeAccount(ctx.io, alice.id), false, 'cancelled: nothing to do');
            assert.equal((await one('SELECT username FROM users WHERE id = ?', [alice.id])).username, 'alice');
        });

        test('two people deleted: their direct chat goes with them', async () => {
            const alice = await createUser('alice');
            const bob = await createUser('bob');
            const chat = await createChat('direct', null, [[alice], [bob]]);
            await sendMessage(chat, alice, 'hi');
            for (const user of [alice, bob]) {
                await sql('UPDATE users SET deletion_due_at = CURRENT_TIMESTAMP - INTERVAL \'1 minute\' WHERE id = ?', [user.id]);
            }
            await ctx.scheduler.runAccountJobs(ctx.io);
            assert.equal(await one('SELECT id FROM chats WHERE id = ?', [chat]), null);
        });
    });
});
