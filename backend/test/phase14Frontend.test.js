/**
 * Phase 14 frontend. The sign-in steps run frontend/js/auth.js in a sandbox; the rest reads the real
 * files: nothing from the server goes through innerHTML, recovery codes are never stored, and the
 * Security tab, the two-step form and the service worker are wired up.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');
const withoutComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '');

function loadAuth(routes) {
    const store = new Map();
    const session = new Map();
    const sandbox = {
        console: { log() {}, error() {}, warn() {} },
        CONFIG: {
            API_BASE_URL: '',
            ENDPOINTS: { LOGIN: '/auth/login', LOGIN_2FA: '/auth/login/2fa', REFRESH: '/auth/refresh' },
            STORAGE_KEYS: { AUTH_TOKEN: 'authToken', USER_DATA: 'userData', CURRENT_CHAT: 'currentChat', ACCOUNT_NOTICE: 'accountNotice' }
        },
        localStorage: { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) },
        sessionStorage: { getItem: key => (session.has(key) ? session.get(key) : null), setItem: (key, value) => session.set(key, String(value)), removeItem: key => session.delete(key) },
        window: { location: { href: 'login.html', pathname: '/login.html', search: '' }, addEventListener() {} },
        navigator: {},
        setTimeout: () => 0,
        clearTimeout() {},
        URLSearchParams,
        fetch: async (url) => {
            const { status, body } = routes[url];
            return { status, ok: status < 300, json: async () => body };
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(read('js/auth.js'), sandbox);
    return { sandbox, store, session };
}

const signedIn = (extra = {}) => ({ userId: 1, username: 'me', email: 'me@x', twoFactorEnabled: true, accessToken: 'token', expiresIn: 900, ...extra });

describe('phase 14 sign-in client', () => {
    test('the password step stores nothing and reports the challenge', async () => {
        const { sandbox, store } = loadAuth({
            '/auth/login': { status: 200, body: { success: true, data: { twoFactorRequired: true, challengeToken: 'c', expiresIn: 300 } } }
        });
        const result = await vm.runInContext("login('me', 'pw')", sandbox);
        assert.equal(result.data.twoFactorRequired, true);
        assert.equal(store.has('userData'), false, 'not signed in yet');
        assert.equal(vm.runInContext('accessToken', sandbox), null);
    });

    test('the code step signs in, and keeps the 2FA flag', async () => {
        const { sandbox, store } = loadAuth({ '/auth/login/2fa': { status: 200, body: { success: true, data: signedIn() } } });
        await vm.runInContext("verifyTwoFactorLogin('c', '123456')", sandbox);
        assert.equal(vm.runInContext('accessToken', sandbox), 'token');
        assert.equal(JSON.parse(store.get('userData')).twoFactorEnabled, true);
    });

    test('a wrong code leaves the page signed out and doesn\'t try to refresh', async () => {
        const { sandbox, store } = loadAuth({ '/auth/login/2fa': { status: 401, body: { success: false, code: 'INVALID_2FA_CODE', message: 'no' } } });
        const result = await vm.runInContext("verifyTwoFactorLogin('c', '000000')", sandbox);
        assert.equal(result.code, 'INVALID_2FA_CODE');
        assert.equal(store.has('userData'), false);
    });

    test('a cancelled deletion and a used recovery code leave a notice for the app', async () => {
        const first = loadAuth({ '/auth/login': { status: 200, body: { success: true, data: signedIn({ deletionCancelled: true }) } } });
        await vm.runInContext("login('me', 'pw')", first.sandbox);
        assert.match(first.session.get('accountNotice'), /will not be deleted/);

        const second = loadAuth({ '/auth/login/2fa': { status: 200, body: { success: true, data: signedIn({ recoveryCodesLeft: 3 }) } } });
        await vm.runInContext("verifyTwoFactorLogin('c', 'code')", second.sandbox);
        assert.match(second.session.get('accountNotice'), /3 left/);
    });
});

describe('phase 14 frontend files', () => {
    test('account.js never builds HTML from strings', () => {
        const code = withoutComments(read('js/account.js'));
        assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
    });

    test('recovery codes and the setup key are never stored', () => {
        const code = withoutComments(read('js/account.js'));
        const storageLines = code.split('\n').filter(line => /(local|session)Storage\.setItem/.test(line));
        assert.deepEqual(storageLines.map(line => line.trim()), ['localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(user));']);
        assert.ok(!/recoveryCodes/.test(read('js/auth.js')));
    });

    test('a QR code must be a PNG data URL before it reaches an img', () => {
        const code = read('js/account.js');
        assert.match(code, /if \(QR_DATA_URL\.test\(data\.qrCode\)\) qr\.src = data\.qrCode/);
    });

    test('chat.html has the Security tab and panel, and starts account.js after moderation', () => {
        const page = read('chat.html');
        assert.ok(page.includes('data-settings-tab="security"'));
        assert.ok(page.includes('data-settings-panel="security"'));
        assert.ok(page.includes('<script src="js/account.js"></script>'));
        assert.ok(page.includes('FriChat.initializeAccount()'));
        for (const id of ['twoFactorPanel', 'securityActivityList', 'exportList', 'deleteAccountForm', 'changeEmailForm']) {
            assert.ok(page.includes(`id="${id}"`), id);
        }
    });

    test('every id account.js looks up exists in chat.html', () => {
        const page = read('chat.html');
        const ids = [...read('js/account.js').matchAll(/byId\('([A-Za-z]+)'\)/g)].map(match => match[1]);
        assert.ok(ids.length > 10);
        for (const id of ids) assert.ok(page.includes(`id="${id}"`), id);
    });

    test('login.html has the second step, and offers a recovery code', () => {
        const page = read('login.html');
        assert.match(page, /id="twoFactorForm"[^>]*hidden/);
        assert.match(page, /autocomplete="one-time-code"/);
        assert.ok(page.includes('verifyTwoFactorLogin(challengeToken'));
        assert.ok(page.includes('Use a recovery code instead'));
        assert.ok(page.includes("deletion: 'Your account will be deleted"));
    });

    test('a device signed out by a deletion lands on that message', () => {
        assert.match(read('js/websocket.js'), /deletion: 'deletion'/);
    });

    test('the service worker caches account.js in a new shell version', () => {
        const worker = read('sw.js');
        assert.ok(worker.includes("'js/account.js'"));
        assert.ok(!worker.includes("'frichat-shell-v16'"));
    });

    test('the new styles use theme variables, and only the QR code keeps a fixed background', () => {
        const css = read('css/style.css');
        const section = css.slice(css.indexOf('Security settings and two-step sign-in'));
        assert.ok(section.length > 100);
        const fixed = [...section.matchAll(/#[0-9a-fA-F]{3,6}\b/g)];
        assert.equal(fixed.length, 1);
        assert.match(section, /\.two-factor-qr[\s\S]*background-color: #ffffff/);
    });

    test('a hidden button stays hidden: .btn sets display, which beats the attribute', () => {
        assert.match(read('css/style.css'), /\.btn\[hidden\]/);
    });

    test('the admin page says why it refuses an admin without 2FA', () => {
        assert.match(read('js/admin.js'), /config\.code === 'TWO_FACTOR_REQUIRED'/);
    });
});
