/**
 * Phase 7 frontend rules, loaded from the real files: search highlights are built from text
 * nodes (message text is never parsed as HTML), date filters, the Enter-to-send setting,
 * per-user per-chat drafts and the upload tray's type/size checks.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

// Just enough DOM for h() and text nodes
class FakeNode {
    constructor(tagName, text = '') {
        this.tagName = tagName;
        this.children = [];
        this.attributes = {};
        this.text = text;
        this.className = '';
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener() {}
    get textContent() {
        return this.tagName === '#text' ? this.text : this.children.map(c => c.textContent).join('');
    }
    set textContent(value) {
        this.children = [new FakeNode('#text', String(value))];
    }
}

function loadFrontend() {
    const storage = new Map();
    const sandbox = {
        console: { log() {}, error() {} },
        URLSearchParams,
        setTimeout,
        clearTimeout,
        CONFIG: {
            API_BASE_URL: 'http://localhost:3000/api',
            ENDPOINTS: {},
            STORAGE_KEYS: { ENTER_TO_SEND: 'enterToSend', DRAFT_PREFIX: 'draft:' },
            SEARCH_PAGE_SIZE: 20,
            MAX_TRAY_FILES: 10
        },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: (k) => storage.delete(k)
        },
        window: {},
        document: {
            getElementById: () => null,
            querySelector: () => null,
            createElement: (tag) => new FakeNode(tag),
            createTextNode: (text) => new FakeNode('#text', text)
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(read('js/groups.js'), sandbox);
    vm.runInContext(read('js/messages.js'), sandbox);
    vm.runInContext(read('js/composer.js'), sandbox);
    vm.runInContext(read('js/search.js'), sandbox);
    let user = { userId: 1 };
    sandbox.getCurrentUser = () => user;
    sandbox.isEditingMessage = () => false;
    return { sandbox, storage, setUser: (u) => { user = u; } };
}

describe('search result highlighting', () => {
    const { sandbox } = loadFrontend();

    test('matches become <mark> nodes and the rest stays plain text', () => {
        const span = sandbox.highlightedSnippet({ text: 'ship the needle today', highlights: [[9, 15]] });
        assert.deepEqual(span.children.map(c => [c.tagName, c.textContent]), [
            ['#text', 'ship the '],
            ['mark', 'needle'],
            ['#text', ' today']
        ]);
    });

    test('HTML in a message is only ever text', () => {
        const text = '<img src=x onerror=alert(1)> needle';
        const span = sandbox.highlightedSnippet({ text, highlights: [[29, 35]] });
        assert.equal(span.children[0].tagName, '#text');
        assert.equal(span.children[0].textContent, '<img src=x onerror=alert(1)> ');
        assert.equal(span.textContent, text);
        assert.ok(!span.children.some(c => c.tagName === 'img'));
    });

    test('overlapping or broken ranges are skipped, not duplicated', () => {
        const span = sandbox.highlightedSnippet({ text: 'abcdef', highlights: [[0, 3], [2, 4], [5, 5], [4, 6]] });
        assert.equal(span.textContent, 'abcdef');
        assert.deepEqual(span.children.filter(c => c.tagName === 'mark').map(c => c.textContent), ['abc', 'ef']);
    });

    test('a "to" date includes that whole local day', () => {
        const from = new Date(sandbox.localDayToIso('2026-03-10'));
        const to = new Date(sandbox.localDayToIso('2026-03-10', 1));
        assert.equal(from.getDate(), 10);
        assert.equal(from.getHours(), 0);
        assert.equal(to.getDate(), 11);
        assert.equal(to - from, 24 * 3600 * 1000);
    });
});

describe('Enter to send', () => {
    test('default: Enter sends, Shift+Enter is a new line, Ctrl+Enter sends', () => {
        const { sandbox } = loadFrontend();
        assert.equal(sandbox.isSendShortcut({ shiftKey: false }), true);
        assert.equal(sandbox.isSendShortcut({ shiftKey: true }), false);
        assert.equal(sandbox.isSendShortcut({ ctrlKey: true }), true);
    });

    test('reversed: Enter is a new line, Shift+Enter sends, Cmd+Enter sends', () => {
        const { sandbox, storage } = loadFrontend();
        sandbox.setEnterToSend(false);
        assert.equal(storage.get('enterToSend'), '0');
        assert.equal(sandbox.isSendShortcut({ shiftKey: false }), false);
        assert.equal(sandbox.isSendShortcut({ shiftKey: true }), true);
        assert.equal(sandbox.isSendShortcut({ metaKey: true }), true);
    });
});

describe('drafts', () => {
    test('kept per user and per chat; blank text removes the draft', () => {
        const { sandbox, storage, setUser } = loadFrontend();
        sandbox.saveDraft(5, 'half a thought');
        sandbox.saveDraft(6, 'other chat');
        assert.equal(storage.get('draft:1:5'), 'half a thought');
        assert.equal(sandbox.getDraft(5), 'half a thought');

        setUser({ userId: 2 });
        assert.equal(sandbox.getDraft(5), '', 'another account on this browser sees nothing');

        setUser({ userId: 1 });
        sandbox.saveDraft(5, '   \n ');
        assert.equal(storage.has('draft:1:5'), false);
        sandbox.clearDraft(6);
        assert.equal(storage.has('draft:1:6'), false);
    });

    test('chat list preview is one line and short', () => {
        const { sandbox } = loadFrontend();
        sandbox.saveDraft(5, `line one\nline two ${'x'.repeat(100)}`);
        const preview = sandbox.getDraftPreview(5);
        assert.ok(!preview.includes('\n'));
        assert.ok(preview.startsWith('line one line two'));
        assert.equal(preview.length, 60);
        assert.ok(preview.endsWith('…'));
        assert.equal(sandbox.getDraftPreview(99), '');
    });
});

describe('upload tray checks', () => {
    const { sandbox } = loadFrontend();
    const limits = { maxFileSize: 1000, allowedTypes: ['image/png', 'application/pdf'] };

    test('allowed type within the size limit is fine', () => {
        assert.equal(sandbox.checkUploadFile({ name: 'a.png', type: 'image/png', size: 10 }, limits), null);
    });

    test('wrong type, too large and empty files are refused with a reason', () => {
        assert.match(sandbox.checkUploadFile({ name: 'a.exe', type: 'application/x-msdownload', size: 10 }, limits), /can't be sent/);
        assert.match(sandbox.checkUploadFile({ name: 'big.pdf', type: 'application/pdf', size: 1001 }, limits), /larger than/);
        assert.match(sandbox.checkUploadFile({ name: 'e.png', type: 'image/png', size: 0 }, limits), /empty/);
    });

    test('without the server limits only the server decides', () => {
        assert.equal(sandbox.checkUploadFile({ name: 'a.exe', type: 'application/x-msdownload', size: 10 }, null), null);
    });
});
