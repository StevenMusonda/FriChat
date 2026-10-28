/**
 * Phase 5 frontend rules, loaded from the real files: the login ?next= target can only be an
 * invite page (no open redirect), invite codes are validated before they are remembered, group
 * avatars only load from the server's own avatar paths, member tags are escaped, the composer
 * lock follows can_post, and the locally served QR library draws a real QR code.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');
const CODE = 'abcDEF123_-abcDEF123_-';

function loadFrontend() {
    const session = new Map();
    const sandbox = {
        console: { log() {}, error() {} },
        URLSearchParams,
        CONFIG: {
            API_BASE_URL: 'http://localhost:3000/api',
            SOCKET_URL: 'http://localhost:3000',
            ENDPOINTS: {},
            STORAGE_KEYS: { AUTH_TOKEN: 't', ARCHIVED_EXPANDED: 'a', PENDING_INVITE: 'pendingInvite' }
        },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: {
            getItem: (k) => (session.has(k) ? session.get(k) : null),
            setItem: (k, v) => session.set(k, String(v)),
            removeItem: (k) => session.delete(k)
        },
        window: { location: { search: '' } },
        document: { getElementById: () => null, querySelector: () => null }
    };
    vm.createContext(sandbox);
    vm.runInContext(read('js/auth.js'), sandbox);
    vm.runInContext(read('js/chat.js'), sandbox);
    vm.runInContext(read('vendor/qrcode-generator/qrcode.js'), sandbox);
    vm.runInContext(read('js/groups.js'), sandbox);
    sandbox.getCurrentUser = () => ({ userId: 1 });
    return { sandbox, session, run: (code) => vm.runInContext(code, sandbox) };
}

describe('login ?next= only goes back to an invite page', () => {
    const { sandbox } = loadFrontend();

    test('a join link is accepted', () => {
        assert.equal(sandbox.getSafeNextUrl(`?next=${encodeURIComponent(`join.html?code=${CODE}`)}`), `join.html?code=${CODE}`);
    });

    for (const next of [
        'https://evil.example/',
        '//evil.example/join.html?code=' + CODE,
        'javascript:alert(1)',
        'chat.html',
        'join.html?code=short',
        `join.html?code=${CODE}&next=https://evil.example`,
        `join.html?code=${CODE}#x`,
        `/join.html?code=${CODE}`,
        `JOIN.html?code=${CODE}`,
        ''
    ]) {
        test(`refuses ${JSON.stringify(next)}`, () => {
            assert.equal(sandbox.getSafeNextUrl(`?next=${encodeURIComponent(next)}`), null);
        });
    }

    test('no parameter means no target', () => {
        assert.equal(sandbox.getSafeNextUrl(''), null);
    });
});

describe('pending invite code', () => {
    test('only valid codes are remembered, and taking one forgets it', () => {
        const { sandbox, session } = loadFrontend();
        sandbox.rememberPendingInvite('<script>');
        assert.equal(session.size, 0);

        sandbox.rememberPendingInvite(CODE);
        assert.equal(sandbox.takePendingInvite(), CODE);
        assert.equal(sandbox.takePendingInvite(), null);

        session.set('pendingInvite', 'javascript:alert(1)');
        assert.equal(sandbox.takePendingInvite(), null, 'a tampered value is ignored');
        assert.equal(session.size, 0);
    });
});

describe('group panel helpers', () => {
    test('avatars load only from the server\'s own avatar paths', () => {
        const { sandbox } = loadFrontend();
        const good = 'uploads/group-avatars/0123456789abcdef0123456789abcdef.webp';
        assert.equal(sandbox.groupAvatarSrc(good), `http://localhost:3000/${good}`);
        for (const bad of [
            'javascript:alert(1)',
            'https://evil.example/a.png',
            'uploads/group-avatars/../../server.js',
            'uploads/images/photo.png',
            'uploads/group-avatars/0123456789abcdef0123456789abcdef.svg',
            null
        ]) {
            assert.equal(sandbox.groupAvatarSrc(bad), null, String(bad));
        }
    });

    test('member tags in message sender lines are escaped', () => {
        const { run } = loadFrontend();
        run(`currentChatId = 10; currentChatDetails = { id: 10, chat_type: 'group', participants: [
            { id: 2, member_tag: '<img src=x onerror=alert(1)>' }, { id: 3, member_tag: null } ] };`);
        const html = run('renderMemberTagHtml(2)');
        assert.ok(!html.includes('<img'), html);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.equal(run('renderMemberTagHtml(3)'), '');
        assert.equal(run('renderMemberTagHtml(99)'), '');

        // Another chat open: tags of the old group are not used
        run('currentChatId = 11;');
        assert.equal(run('renderMemberTagHtml(2)'), '');
    });

    test('the composer is locked only for the open chat when the server says can_post is false', () => {
        const { run } = loadFrontend();
        run("currentChatId = 10; currentChatDetails = { id: 10, chat_type: 'group', can_post: false };");
        assert.equal(run('canPostInCurrentChat()'), false);
        run('currentChatId = 12;');
        assert.equal(run('canPostInCurrentChat()'), true);
        run("currentChatId = 10; currentChatDetails = { id: 10, chat_type: 'group', can_post: true };");
        assert.equal(run('canPostInCurrentChat()'), true);
        run('currentChatDetails = null;');
        assert.equal(run('canPostInCurrentChat()'), true);
    });

    test('the QR library served from vendor/ draws a scannable-looking code for an invite link', () => {
        const { sandbox } = loadFrontend();
        const url = `https://chat.example.com/join.html?code=${CODE}`;

        const qr = sandbox.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        const n = qr.getModuleCount();
        assert.ok(n >= 21 && (n - 17) % 4 === 0, `valid QR size, got ${n}`);
        // The three finder patterns: dark 7x7 border in three corners
        for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
            for (let i = 0; i < 7; i++) {
                assert.ok(qr.isDark(r, c + i) && qr.isDark(r + 6, c + i) && qr.isDark(r + i, c) && qr.isDark(r + i, c + 6));
            }
        }

        let filled = 0;
        const ctx = { fillStyle: '', fillRect() { filled++; } };
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        assert.equal(sandbox.drawQrCode(canvas, url), true);
        assert.equal(canvas.width, canvas.height);
        assert.ok(canvas.width >= (n + 8) * 3);
        assert.ok(filled > n, 'modules were drawn');
    });
});
