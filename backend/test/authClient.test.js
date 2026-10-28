/**
 * Phase 6 frontend auth (frontend/js/auth.js run in a sandbox): the access token stays in memory,
 * a 401 refreshes once and retries, a failed refresh ends the session, 403 keeps it, the sign-in
 * pages never refresh, and the pre-phase-6 localStorage token is deleted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AUTH_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'auth.js'), 'utf8');

/**
 * @param {Object} options
 *   routes: { [endpoint]: Array<{ status, body }> } - responses in order (the last one repeats)
 *   storage: initial localStorage contents
 */
function loadAuth({ routes = {}, storage = {} } = {}) {
    const store = new Map(Object.entries(storage));
    const requests = [];
    const location = { href: 'chat.html', pathname: '/frontend/chat.html', search: '' };
    const counters = {};

    const sandbox = {
        console: { log() {}, error() {}, warn() {} },
        CONFIG: {
            API_BASE_URL: '',
            ENDPOINTS: { REFRESH: '/auth/refresh', LOGIN: '/auth/login', LOGOUT: '/auth/logout', REGISTER: '/auth/register', PROFILE: '/auth/profile' },
            STORAGE_KEYS: { AUTH_TOKEN: 'authToken', USER_DATA: 'userData', CURRENT_CHAT: 'currentChat', PENDING_INVITE: 'pendingInvite' }
        },
        localStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: (key) => store.delete(key)
        },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        window: { location, addEventListener() {} },
        navigator: {},
        setTimeout: (fn, ms) => (ms > 1000 ? 0 : setTimeout(fn, 0)),
        clearTimeout() {},
        URLSearchParams,
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            const list = routes[url] || [{ status: 404, body: { success: false } }];
            const index = Math.min(counters[url] || 0, list.length - 1);
            counters[url] = (counters[url] || 0) + 1;
            const { status, body } = list[index];
            return { status, ok: status >= 200 && status < 300, json: async () => body };
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(AUTH_JS, sandbox);
    return { sandbox, store, requests, location };
}

const USER = JSON.stringify({ userId: 1, username: 'me' });
const refreshOk = (token) => ({ status: 200, body: { success: true, data: { userId: 1, username: 'me', email: 'me@x', emailVerified: true, accessToken: token, expiresIn: 900 } } });
const refreshFails = { status: 401, body: { success: false, code: 'SESSION_EXPIRED' } };

describe('frontend auth.js (phase 6 tokens)', () => {
    test('a pre-phase-6 token left in localStorage is deleted on load', () => {
        const { store } = loadAuth({ storage: { authToken: 'old.jwt.token', userData: USER } });
        assert.equal(store.has('authToken'), false);
        assert.equal(store.get('userData'), USER, 'profile hint is kept');
    });

    test('the access token comes from the refresh cookie and is never written to storage', async () => {
        const { sandbox, store, requests } = loadAuth({
            storage: { userData: USER },
            routes: { '/auth/refresh': [refreshOk('access-1')], '/x': [{ status: 200, body: { success: true } }] }
        });
        const result = await sandbox.apiRequest('/x');
        assert.equal(result.success, true);

        const refresh = requests.find(r => r.url === '/auth/refresh');
        assert.equal(refresh.options.credentials, 'include');
        assert.equal(refresh.options.headers['X-FriChat-Refresh'], '1');

        const call = requests.find(r => r.url === '/x');
        assert.equal(call.options.headers.Authorization, 'Bearer access-1');
        for (const value of store.values()) assert.ok(!value.includes('access-1'), 'token must not be in localStorage');
    });

    test('403 is returned to the caller and keeps the session', async () => {
        const { sandbox, location } = loadAuth({
            storage: { userData: USER },
            routes: { '/auth/refresh': [refreshOk('a')], '/x': [{ status: 403, body: { success: false, message: 'status 403' } }] }
        });
        const result = await sandbox.apiRequest('/x');
        assert.equal(result.message, 'status 403');
        assert.equal(location.href, 'chat.html');
    });

    test('401: refresh once and retry with the new token', async () => {
        const { sandbox, requests } = loadAuth({
            storage: { userData: USER },
            routes: {
                '/auth/refresh': [refreshOk('a'), refreshOk('b')],
                '/x': [{ status: 401, body: { success: false } }, { status: 200, body: { success: true, data: 42 } }]
            }
        });
        const result = await sandbox.apiRequest('/x');
        assert.equal(result.data, 42);
        const calls = requests.filter(r => r.url === '/x');
        assert.deepEqual(calls.map(c => c.options.headers.Authorization), ['Bearer a', 'Bearer b']);
    });

    test('401 and the refresh fails: the session has ended (local data cleared, sent to login)', async () => {
        const { sandbox, store, location } = loadAuth({
            storage: { userData: USER, currentChat: '5' },
            routes: { '/auth/refresh': [refreshOk('a'), refreshFails], '/x': [{ status: 401, body: { success: false } }] }
        });
        await assert.rejects(sandbox.apiRequest('/x'));
        assert.equal(store.has('userData'), false);
        assert.equal(store.has('currentChat'), false);
        assert.match(location.href, /^login\.html\?signedOut=expired$/);
    });

    test('a revoked session (SESSION_REVOKED) goes straight to login without another refresh', async () => {
        const { sandbox, requests, location } = loadAuth({
            storage: { userData: USER },
            routes: { '/auth/refresh': [refreshOk('a')], '/x': [{ status: 401, body: { success: false, code: 'SESSION_REVOKED' } }] }
        });
        await assert.rejects(sandbox.apiRequest('/x'));
        assert.equal(requests.filter(r => r.url === '/auth/refresh').length, 1);
        assert.equal(location.href, 'login.html?signedOut=revoked');
    });

    test('a reused refresh token is reported as a security sign-out', async () => {
        const { sandbox, location } = loadAuth({
            storage: { userData: USER },
            routes: { '/auth/refresh': [{ status: 401, body: { success: false, code: 'TOKEN_REUSED' } }] }
        });
        const session = await sandbox.ensureSession();
        assert.equal(session.ok, false);
        assert.equal(location.href, 'login.html?signedOut=security');
    });

    test('two tabs racing (409) retry and then succeed', async () => {
        const { sandbox, requests } = loadAuth({
            storage: { userData: USER },
            routes: { '/auth/refresh': [{ status: 409, body: { success: false, code: 'REFRESH_RACE' } }, refreshOk('after-race')] }
        });
        const session = await sandbox.ensureSession();
        assert.equal(session.ok, true);
        assert.equal(await sandbox.getAccessToken(), 'after-race');
        assert.equal(requests.filter(r => r.url === '/auth/refresh').length, 2);
    });

    test('concurrent callers share one refresh request', async () => {
        const { sandbox, requests } = loadAuth({
            storage: { userData: USER },
            routes: { '/auth/refresh': [refreshOk('shared')] }
        });
        const tokens = await Promise.all([sandbox.getAccessToken(), sandbox.getAccessToken(), sandbox.getAccessToken()]);
        assert.deepEqual(tokens, ['shared', 'shared', 'shared']);
        assert.equal(requests.filter(r => r.url === '/auth/refresh').length, 1);
    });

    test('a network error during refresh does not sign the user out', async () => {
        const { sandbox, store, location } = loadAuth({ storage: { userData: USER } });
        sandbox.fetch = async () => { throw new Error('offline'); };
        const session = await sandbox.ensureSession();
        assert.deepEqual({ ...session }, { ok: false, network: true });
        assert.equal(store.get('userData'), USER);
        assert.equal(location.href, 'chat.html');
    });

    test('sign-in pages: a 401 is "wrong credentials", no refresh and no redirect', async () => {
        const { sandbox, requests, location } = loadAuth({
            routes: { '/auth/login': [{ status: 401, body: { success: false, message: 'Invalid credentials' } }] }
        });
        const result = await sandbox.login('me', 'wrong');
        assert.equal(result.success, false);
        assert.equal(requests.some(r => r.url === '/auth/refresh'), false);
        assert.equal(location.href, 'chat.html');
    });

    test('login keeps the token in memory and only profile data in storage', async () => {
        const { sandbox, store, requests } = loadAuth({
            routes: { '/auth/login': [{ status: 200, body: { success: true, data: { userId: 1, username: 'me', emailVerified: false, accessToken: 'login-token', expiresIn: 900 } } }] }
        });
        await sandbox.login('me', 'pw');
        assert.equal(requests[0].options.credentials, 'include', 'the refresh cookie must be accepted');
        assert.equal(JSON.parse(store.get('userData')).emailVerified, false);
        assert.ok(![...store.values()].some(v => v.includes('login-token')));
        assert.equal(await sandbox.getAccessToken(), 'login-token');
    });
});
