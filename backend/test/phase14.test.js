/**
 * Phase 14 on both fake drivers (MySQL has no server in CI-less setups, so this is its coverage) and
 * rules read from the repository: the sign-in steps through the real server, SQL dialect on the paths
 * the integration tests only run on PostgreSQL, migrations that match their schemas, and a guard that
 * fails when a new table with a users foreign key isn't handled by account deletion.
 * The full behaviour runs on real PostgreSQL in phase14.integration.test.js.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { generateSync } = require('otplib');
const { setupFakeDb, fakeIo, stubModule, listenForFetch } = require('./helpers/fakeDb');

const ROOT = path.join(__dirname, '..', '..');
const readRepo = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ALICE = 1;
const SESSION = 21;
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse';

/**
 * The parts of a database the sign-in steps use
 */
function createWorld(dbType, twoFactor) {
    const pg = dbType === 'postgresql';
    const changed = (n) => (pg ? Array.from({ length: n }, () => ({ id: 1 })) : { affectedRows: n });
    const world = {
        user: {
            id: ALICE, username: 'alice', email: 'a@x.io', full_name: null, avatar_url: null, is_admin: pg ? false : 0,
            password_hash: bcrypt.hashSync(PASSWORD, 4), suspended_at: null, deleted_at: null, deletion_due_at: null,
            totp_secret_enc: null, totp_enabled_at: twoFactor ? new Date() : null, totp_last_step: null,
            totp_failed_attempts: 0, totp_locked_until: null, email_verified_at: new Date()
        },
        sessions: [],
        audit: [],
        rotatedSession: null
    };

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');
        const user = world.user;

        if (/^SELECT \* FROM users WHERE (username = \? OR email = \?|id = \?)/.test(sql)) return [{ ...user }];
        if (/^SELECT id, totp_secret_enc, totp_enabled_at FROM users/.test(sql)) return [{ ...user }];
        if (/^UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = \? AND totp_locked_until <=/.test(sql)) {
            return changed(0);
        }
        if (/^UPDATE users SET totp_failed_attempts = totp_failed_attempts \+ 1/.test(sql)) {
            if (user.totp_locked_until || user.totp_failed_attempts >= params[1]) return changed(0);
            user.totp_failed_attempts++;
            return changed(1);
        }
        if (/^UPDATE users SET totp_last_step = \?/.test(sql)) {
            if (user.totp_last_step !== null && user.totp_last_step >= params[2]) return changed(0);
            user.totp_last_step = params[0];
            return changed(1);
        }
        if (/^UPDATE users SET totp_failed_attempts = 0 WHERE id = \?$/.test(sql)) {
            user.totp_failed_attempts = 0;
            return changed(1);
        }
        if (/^SELECT totp_failed_attempts FROM users/.test(sql)) return [{ totp_failed_attempts: user.totp_failed_attempts }];
        if (/^UPDATE users SET totp_locked_until = /.test(sql)) {
            user.totp_locked_until = 'locked';
            return changed(1);
        }
        if (/AS seconds_left FROM users/.test(sql)) return [{ seconds_left: 900 }];

        if (/^UPDATE users SET status = \?, last_seen/.test(sql)) return changed(1);
        if (/^INSERT INTO sessions/.test(sql)) {
            world.sessions.push({ mfa: /CURRENT_TIMESTAMP\)( RETURNING id)?$/.test(sql) });
            return pg ? [{ id: SESSION }] : { insertId: SESSION };
        }
        if (/^INSERT INTO audit_log/.test(sql)) {
            world.audit.push(params[0]);
            return pg ? [{ id: 1 }] : { insertId: 1 };
        }
        if (/FROM sessions s JOIN users u/.test(sql)) {
            world.sessionSql = sql;
            return [];
        }
        if (/^UPDATE sessions SET last_active_at/.test(sql)) return changed(1);
        if (/^SELECT id, user_id, revoked_at, mfa_verified_at/.test(sql)) {
            return [{ id: SESSION, user_id: ALICE, revoked_at: null, mfa_verified_at: world.sessionVerified ? new Date() : null, is_expired: 0 }];
        }
        if (/^INSERT INTO session_refresh_tokens/.test(sql)) return pg ? [] : { insertId: 1 };
        if (/^UPDATE sessions SET refresh_token_hash/.test(sql)) return changed(1);
        if (/^SELECT id, username, email, full_name, avatar_url, email_verified_at, is_admin, suspended_at, deleted_at, totp_enabled_at FROM users WHERE id/.test(sql)) {
            return [{ ...user }];
        }
        if (/^UPDATE sessions SET revoked_at/.test(sql)) {
            world.revoked = params[0];
            return changed(1);
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

async function startApp(dbType, { twoFactor = true } = {}) {
    process.env.JWT_SECRET = 'test-secret';
    process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.PORT = '0';
    process.env.TRUST_PROXY = '1';

    const world = createWorld(dbType, twoFactor);
    const fake = setupFakeDb(dbType, world.handler);
    stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {}, runTimedJobs() {} });
    const twoFactorUtils = fake.load('utils/twoFactor.js');
    world.user.totp_secret_enc = twoFactorUtils.encryptSecret(SECRET, ALICE);

    const log = console.log;
    console.log = () => {};
    const { app, io } = fake.load('server.js');
    console.log = log;
    const server = await listenForFetch(app);
    const base = `http://127.0.0.1:${server.address().port}`;

    let ip = 0;
    const post = async (url, body, headers = {}) => {
        const res = await fetch(`${base}${url}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.2.0.${++ip}`, ...headers },
            body: JSON.stringify(body)
        });
        return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() };
    };

    return {
        world,
        post,
        close: async () => {
            await new Promise(resolve => server.close(resolve));
            io.close();
        }
    };
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`two-step sign-in (${dbType})`, () => {
        test('the password alone starts nothing; a valid code starts a verified session', async () => {
            const ctx = await startApp(dbType);
            try {
                const first = await ctx.post('/api/auth/login', { username: 'alice', password: PASSWORD });
                assert.equal(first.status, 200);
                assert.equal(first.body.data.twoFactorRequired, true);
                assert.equal(first.body.data.accessToken, undefined);
                assert.deepEqual(first.cookies, []);
                assert.equal(ctx.world.sessions.length, 0);

                const code = generateSync({ secret: SECRET });
                const second = await ctx.post('/api/auth/login/2fa', { challengeToken: first.body.data.challengeToken, code });
                assert.equal(second.status, 200);
                assert.ok(second.body.data.accessToken);
                assert.deepEqual(ctx.world.sessions, [{ mfa: true }]);

                // The step is spent
                const replay = await ctx.post('/api/auth/login/2fa', { challengeToken: first.body.data.challengeToken, code });
                assert.equal(replay.status, 401);
            } finally {
                await ctx.close();
            }
        });

        test('five wrong codes lock it, and a right code then fails', async () => {
            const ctx = await startApp(dbType);
            try {
                const { challengeToken } = (await ctx.post('/api/auth/login', { username: 'alice', password: PASSWORD })).body.data;
                const results = [];
                for (let i = 0; i < 5; i++) results.push(await ctx.post('/api/auth/login/2fa', { challengeToken, code: '000000' }));
                assert.deepEqual(results.map(res => res.status), [401, 401, 401, 401, 429]);
                assert.ok(ctx.world.audit.includes('2fa_locked'));

                const right = await ctx.post('/api/auth/login/2fa', { challengeToken, code: generateSync({ secret: SECRET }) });
                assert.equal(right.status, 429);
                assert.equal(ctx.world.sessions.length, 0);
            } finally {
                await ctx.close();
            }
        });

        test('refresh refuses a session that never passed the second factor, and revokes it', async () => {
            const ctx = await startApp(dbType);
            try {
                const token = crypto.randomBytes(32).toString('base64url');
                const res = await ctx.post('/api/auth/refresh', {}, { 'X-FriChat-Refresh': '1', Cookie: `frichat_refresh=${token}` });
                assert.equal(res.status, 401);
                assert.equal(res.body.data, undefined);
                assert.equal(ctx.world.revoked, '2fa');

                ctx.world.sessionVerified = true;
                const fine = await ctx.post('/api/auth/refresh', {}, { 'X-FriChat-Refresh': '1', Cookie: `frichat_refresh=${crypto.randomBytes(32).toString('base64url')}` });
                assert.equal(fine.status, 200);
            } finally {
                await ctx.close();
            }
        });

        test('a user without 2FA signs in with the password alone, as before', async () => {
            const ctx = await startApp(dbType, { twoFactor: false });
            try {
                const res = await ctx.post('/api/auth/login', { username: 'alice', password: PASSWORD });
                assert.ok(res.body.data.accessToken);
                assert.deepEqual(ctx.world.sessions, [{ mfa: false }]);
            } finally {
                await ctx.close();
            }
        });

        test('every session lookup carries the 2FA rule', async () => {
            const world = createWorld(dbType, true);
            const fake = setupFakeDb(dbType, world.handler);
            await fake.load('utils/sessions.js').findSessionUser(ALICE, SESSION);
            assert.match(world.sessionSql, /\(u\.totp_enabled_at IS NULL OR s\.mfa_verified_at IS NOT NULL\)/);
            assert.match(world.sessionSql, /u\.deleted_at IS NULL/);
        });
    });

    describe(`account jobs speak the dialect (${dbType})`, () => {
        const POSTGRES_ONLY = [/\bRETURNING\b/, /::/, /\bILIKE\b/, /INTERVAL '/, /CAST\(\? AS INTEGER\)/];
        const MYSQL_ONLY = [/\bDATE_ADD\b/, /\bDATE_SUB\b/, /TIMESTAMPDIFF/, /INTERVAL \? /];

        function spyWorld() {
            const pg = dbType === 'postgresql';
            const seen = [];
            const users = { id: ALICE, username: 'alice', email: 'a@x.io', avatar_url: null, deleted_at: null, deletion_due_at: new Date() };
            const handler = (rawSql) => {
                seen.push(rawSql);
                const sql = rawSql.replace(/\$\d+/g, '?');
                if (/^SELECT .*\bFROM users WHERE id = \?/.test(sql)) return [{ ...users, total: 0, seconds_left: 60 }];
                if (/^SELECT COUNT\(\*\)/.test(sql)) return [{ total: 0 }];
                if (/^(SELECT|WITH)\b/.test(sql)) return [];
                if (/\bRETURNING\b/.test(sql) && !/^INSERT/.test(sql)) return [{ id: 1 }];
                return pg ? [{ id: 1 }] : { affectedRows: 1, insertId: 1 };
            };
            return { seen, handler };
        }

        function assertDialect(seen) {
            assert.ok(seen.length > 5);
            for (const sql of seen) {
                for (const pattern of dbType === 'mysql' ? POSTGRES_ONLY : MYSQL_ONLY) {
                    assert.ok(!pattern.test(sql), `${pattern} in: ${sql}`);
                }
                assert.ok(!/LIMIT \?/.test(sql), `bound LIMIT: ${sql}`);
            }
        }

        test('the purge', async () => {
            const { seen, handler } = spyWorld();
            const fake = setupFakeDb(dbType, handler, { realBookkeeping: true });
            await fake.load('utils/accountDeletion.js').purgeAccount(fakeIo(), ALICE);
            assertDialect(seen);
            assert.ok(seen.some(sql => /^UPDATE users SET username = /.test(sql.trim())), 'reached the tombstone');
        });

        test('scheduling and cancelling a deletion', async () => {
            const { seen, handler } = spyWorld();
            const fake = setupFakeDb(dbType, handler, { realBookkeeping: true });
            const deletion = fake.load('utils/accountDeletion.js');
            await deletion.scheduleDeletion(fakeIo(), { id: ALICE, email: 'a@x.io', username: 'alice' });
            await deletion.cancelDeletion({ id: ALICE, email: 'a@x.io', username: 'alice' });
            assertDialect(seen);
        });

        test('exports: requesting, listing, sweeping, requeueing', async () => {
            const { seen, handler } = spyWorld();
            const fake = setupFakeDb(dbType, handler, { realBookkeeping: true });
            const dataExport = fake.load('utils/dataExport.js');
            await dataExport.requestExport(ALICE);
            await dataExport.listExports(ALICE);
            await dataExport.processPendingExports();
            await dataExport.sweepExpiredExports();
            await dataExport.deleteUserExports(ALICE);
            assertDialect(seen);
        });

        test('security activity and device housekeeping', async () => {
            const { seen, handler } = spyWorld();
            const fake = setupFakeDb(dbType, handler, { realBookkeeping: true });
            await fake.load('utils/auditLog.js').forUser(ALICE, { before: 5 });
            await fake.load('utils/knownDevices.js').purgeOldDevices();
            await fake.load('utils/twoFactor.js').getStatus(ALICE);
            await fake.load('utils/twoFactor.js').replaceRecoveryCodes(ALICE);
            assertDialect(seen);
        });
    });
}

describe('the export folder stays private', () => {
    let root;
    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-p14-'));
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    test('a path inside the uploads folder is ignored', () => {
        process.env.DB_TYPE = 'postgresql';
        const fake = setupFakeDb('postgresql', () => []);
        const { UPLOAD_DIR } = fake.load('utils/uploads.js');
        const { privateDir } = fake.load('utils/uploadSecurity.js');
        const error = console.error;
        console.error = () => {};
        process.env.DATA_EXPORT_PATH = path.join(UPLOAD_DIR, 'exports');
        const chosen = privateDir('DATA_EXPORT_PATH', 'exports');
        console.error = error;
        delete process.env.DATA_EXPORT_PATH;
        assert.ok(!chosen.startsWith(UPLOAD_DIR));
    });
});

describe('recovery codes and names', () => {
    const fake = () => setupFakeDb('postgresql', () => []);

    test('codes are 80 bits in a readable alphabet, and hash the same however they are typed', () => {
        const twoFactor = fake().load('utils/twoFactor.js');
        const code = twoFactor.generateRecoveryCode();
        assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
        assert.equal(twoFactor.hashRecoveryCode(code), twoFactor.hashRecoveryCode(code.toLowerCase().replace(/-/g, ' ')));
        assert.equal(32 ** 16, 2 ** 80);
    });

    test('a file name can\'t climb out of the zip', () => {
        const { archiveName } = fake().load('utils/dataExport.js');
        for (const name of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', 'C:\\x.txt', '.hidden', '', 'a\0b', '...']) {
            const result = archiveName(7, name);
            assert.match(result, /^uploads\/7-[^/\\\0]+$/, name);
            assert.ok(!result.slice('uploads/'.length).split('/').includes('..'));
        }
        assert.equal(archiveName(7, 'Foto día 1.jpg'), 'uploads/7-Foto día 1.jpg');
    });

    test('the two kinds of short-lived token can\'t stand in for each other', () => {
        process.env.JWT_SECRET = 'test-secret';
        const f = fake();
        const twoFactor = f.load('utils/twoFactor.js');
        const dataExport = f.load('utils/dataExport.js');
        const sessions = f.load('utils/sessions.js');

        const challenge = twoFactor.signLoginChallenge({ id: 1, password_hash: 'x' }).challengeToken;
        const link = dataExport.signDownloadToken(5, 1);
        const access = sessions.signAccessToken({ id: 1, username: 'a' }, 9).accessToken;

        assert.equal(sessions.verifyAccessToken(challenge), null);
        assert.equal(sessions.verifyAccessToken(link), null);
        assert.equal(dataExport.verifyDownloadToken(challenge), null);
        assert.equal(dataExport.verifyDownloadToken(access), null);
        assert.equal(twoFactor.verifyLoginChallenge(link), null);
        assert.equal(twoFactor.verifyLoginChallenge(access), null);
        assert.equal(twoFactor.verifyLoginChallenge(jwt.sign({ purpose: '2fa_login', userId: 1 }, 'other-secret')), null);
    });

    test('a broken email template or mailer never reaches the caller', () => {
        const f = fake();
        const { notifySecurityEvent } = f.load('utils/securityEmails.js');
        assert.doesNotThrow(() => notifySecurityEvent({ email: 'a@x.io', username: 'a' }, 'no_such_kind'));
        assert.doesNotThrow(() => notifySecurityEvent(null, 'password_changed'));
    });
});

describe('migrations and schemas agree', () => {
    const NEW_USER_COLUMNS = [
        'totp_secret_enc', 'totp_pending_enc', 'totp_pending_at', 'totp_enabled_at', 'totp_last_step', 'totp_failed_attempts',
        'totp_locked_until', 'deletion_requested_at', 'deletion_due_at', 'deleted_at'
    ];
    const NEW_TABLES = ['recovery_codes', 'known_devices', 'data_exports'];

    for (const file of ['add_account_security.sql', 'add_account_security_postgresql.sql', 'schema.sql', 'schema_postgresql.sql']) {
        test(`database/${file} has every new column and table`, () => {
            const sql = readRepo(`database/${file}`);
            for (const column of [...NEW_USER_COLUMNS, 'mfa_verified_at']) assert.ok(new RegExp(`\\b${column}\\b`).test(sql), column);
            for (const table of NEW_TABLES) assert.match(sql, new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`));
        });
    }

    test('the PostgreSQL migration can run twice; MySQL keeps NULL timestamps from getting a default', () => {
        const pg = readRepo('database/add_account_security_postgresql.sql');
        assert.ok(!/ADD COLUMN (?!IF NOT EXISTS)/.test(pg));
        assert.ok(!/CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/.test(pg));
        for (const file of ['database/add_account_security.sql', 'database/schema.sql']) {
            const lines = readRepo(file).split(/\r?\n/).filter(line => /(totp_pending_at|totp_enabled_at|totp_locked_until|deletion_requested_at|deletion_due_at|deleted_at|mfa_verified_at) TIMESTAMP/.test(line) && !/DEFAULT CURRENT_TIMESTAMP/.test(line));
            assert.ok(lines.length >= 7, file);
            for (const line of lines) assert.match(line, /TIMESTAMP NULL DEFAULT NULL/, line);
        }
    });
});

describe('account deletion covers the schema', () => {
    const NAMED_IN_PURGE = ['files.uploaded_by', 'quarantined_files.uploaded_by', 'reports.reporter_id', 'group_members.user_id', 'data_exports.user_id', 'messages.sender_id'];

    test('every column that references users is deleted, handled or kept on purpose', () => {
        const fake = setupFakeDb('postgresql', () => []);
        const { DELETED_ROWS, KEPT_REFERENCES } = fake.load('utils/accountDeletion.js');
        const covered = new Set([...DELETED_ROWS.map(([table, column]) => `${table}.${column}`), ...KEPT_REFERENCES, ...NAMED_IN_PURGE]);

        const schema = readRepo('database/schema_postgresql.sql');
        const references = [];
        let table = null;
        for (const line of schema.split(/\r?\n/)) {
            const opened = /^CREATE TABLE (\w+)/.exec(line);
            if (opened) table = opened[1];
            const column = /^\s+(\w+) .*REFERENCES users\(id\)/.exec(line);
            if (column && table && column[1] !== 'CONSTRAINT') references.push(`${table}.${column[1]}`);
            const constraint = /FOREIGN KEY \((\w+)\) REFERENCES users\(id\)/.exec(line);
            if (constraint && table) references.push(`${table}.${constraint[1]}`);
        }
        assert.ok(references.length > 40, 'the schema was parsed');
        assert.deepEqual(references.filter(reference => !covered.has(reference)), []);
    });

    test('the audit log is still only touched by its own module', () => {
        const text = readRepo('backend/utils/accountDeletion.js');
        assert.ok(!/\baudit_log\b/.test(text));
    });
});
