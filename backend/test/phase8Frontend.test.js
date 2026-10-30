/**
 * Phase 8 frontend rules, loaded from the real files: the poll card escapes every user text,
 * shows names only for non-anonymous polls, clicking computes the right selection, and the
 * scheduling helpers work in the browser's own timezone.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runFrontendScript } = require('./helpers/frontendScripts');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

function loadFrontend() {
    const sandbox = {
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
        Intl,
        CONFIG: { ENDPOINTS: {}, POLL_MIN_OPTIONS: 2, POLL_MAX_OPTIONS: 12 },
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        currentMessages: [],
        getCurrentUser: () => ({ userId: 1 })
    };
    vm.createContext(sandbox);
    // The real escaping helper from chat.js (the rest of chat.js needs a DOM)
    const chat = read('js/chat.js');
    const escapeSource = chat.slice(chat.indexOf('function escapeHtml(text)'), chat.indexOf('}', chat.indexOf(".replace(/'/g, '&#39;');")) + 1);
    vm.runInContext(escapeSource, sandbox);
    runFrontendScript(read('js/planner.js'), sandbox);
    runFrontendScript(read('js/polls.js'), sandbox);
    return sandbox;
}

function poll(overrides = {}) {
    return {
        id: 7,
        messageId: 70,
        createdBy: 1,
        question: '<img src=x onerror=alert(1)> lunch?',
        multipleChoice: false,
        anonymous: false,
        closed: false,
        closesAt: null,
        voterCount: 2,
        myVotes: [11],
        options: [
            { id: 11, text: '<script>alert(1)</script>', votes: 1, percent: 50, voters: [{ userId: 1, name: '<b>Alice</b>' }] },
            { id: 12, text: 'Sushi "&" rice', votes: 1, percent: 50, voters: [{ userId: 2, name: 'Bob' }] }
        ],
        ...overrides
    };
}

describe('poll card', () => {
    const sandbox = loadFrontend();

    test('question, options and voter names are escaped', () => {
        const html = sandbox.renderPollHtml({ id: 70, content: 'x', poll: poll() });
        assert.ok(!html.includes('<script>'));
        assert.ok(!html.includes('<img'));
        assert.ok(!html.includes('<b>Alice'));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(html.includes('Sushi &quot;&amp;&quot; rice'));
        assert.ok(html.includes('&lt;b&gt;Alice&lt;/b&gt;'));
        assert.match(html, /class="poll-option chosen"[^>]*data-option-id="11"/);
        assert.ok(html.includes('Close poll')); // user 1 created it
    });

    test('anonymous polls show counts but no names; closed polls disable the options', () => {
        const html = sandbox.renderPollHtml({ id: 70, poll: poll({ anonymous: true, closed: true }) });
        assert.ok(!html.includes('Alice'));
        assert.ok(!html.includes('View votes'));
        assert.ok(!html.includes('Close poll'));
        assert.equal((html.match(/ disabled>/g) || []).length, 2);
        assert.ok(html.includes('50% · 1'));
        assert.ok(html.includes('Closed'));
    });

    test('bar widths are clamped numbers, never strings from the payload', () => {
        const html = sandbox.renderPollHtml({ id: 70, poll: poll({ options: [{ id: 1, text: 'a', votes: 1, percent: '50%;background:url(x)', voters: [] }, { id: 2, text: 'b', votes: 0, percent: 900, voters: [] }] }) });
        assert.ok(!html.includes('url(x)'));
        assert.ok(html.includes('width: 50%'));
        assert.ok(html.includes('width: 100%'));
    });

    test('clicking: single choice switches or takes back, multiple choice toggles', () => {
        assert.deepEqual([...sandbox.nextPollSelection({ multipleChoice: false, myVotes: [11] }, 12)], [12]);
        assert.deepEqual([...sandbox.nextPollSelection({ multipleChoice: false, myVotes: [11] }, 11)], []);
        assert.deepEqual([...sandbox.nextPollSelection({ multipleChoice: true, myVotes: [11] }, 12)], [11, 12]);
        assert.deepEqual([...sandbox.nextPollSelection({ multipleChoice: true, myVotes: [11, 12] }, 11)], [12]);
    });
});

describe('scheduling times', () => {
    const sandbox = loadFrontend();

    test('datetime-local values are read and written in local time', () => {
        const date = sandbox.parseDateTimeLocal('2026-11-02T08:30');
        assert.equal(date.getFullYear(), 2026);
        assert.equal(date.getMonth(), 10);
        assert.equal(date.getDate(), 2);
        assert.equal(date.getHours(), 8);
        assert.equal(date.getMinutes(), 30);
        assert.equal(sandbox.toDateTimeLocalValue(date), '2026-11-02T08:30');
        // What goes to the server is the matching UTC instant
        assert.equal(new Date(date.toISOString()).getTime(), date.getTime());
        assert.equal(sandbox.parseDateTimeLocal(''), null);
        assert.equal(sandbox.parseDateTimeLocal('2026-11-02 08:30'), null);
    });

    test('presets: in 1 hour, tonight at 20:00 (until 19:30), tomorrow at 09:00 - all local', () => {
        const morning = new Date(2026, 9, 29, 10, 15);
        const presets = sandbox.plannerPresets(morning);
        assert.deepEqual([...presets.map(p => p.key)], ['hour', 'tonight', 'tomorrow']);
        assert.equal(presets[0].at.getTime() - morning.getTime(), 3600 * 1000);
        assert.equal(presets[1].at.getHours(), 20);
        assert.equal(presets[1].at.getDate(), 29);
        assert.equal(presets[2].at.getHours(), 9);
        assert.equal(presets[2].at.getDate(), 30);

        const evening = sandbox.plannerPresets(new Date(2026, 9, 29, 19, 45));
        assert.deepEqual([...evening.map(p => p.key)], ['hour', 'tomorrow']);

        // Month end rolls over
        const lastDay = sandbox.plannerPresets(new Date(2026, 9, 31, 12, 0));
        assert.equal(lastDay.find(p => p.key === 'tomorrow').at.getMonth(), 10);
    });

    test('labels are relative to the viewer\'s day', () => {
        const now = new Date(2026, 9, 29, 12, 0);
        assert.match(sandbox.formatPlannerTime(new Date(2026, 9, 29, 18, 0).toISOString(), now), /^today /);
        assert.match(sandbox.formatPlannerTime(new Date(2026, 9, 30, 9, 0).toISOString(), now), /^tomorrow /);
        assert.ok(!/today|tomorrow/.test(sandbox.formatPlannerTime(new Date(2026, 10, 5, 9, 0).toISOString(), now)));
        assert.equal(sandbox.formatPlannerTime('not a date', now), '');
    });
});

/**
 * Just enough DOM to run initializePolls() and the "View votes" dialog for real
 */
class FakeEl {
    constructor(tagName, id = null) {
        this.tagName = tagName;
        this.id = id;
        this.children = [];
        this.listeners = {};
        this.style = {};
        this.dataset = {};
        this.attributes = {};
        this.className = '';
        this.hidden = false;
        this.value = '';
        this.ownText = '';
    }
    append(...nodes) { nodes.forEach(n => this.children.push(n)); }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    focus() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    get textContent() { return [this.ownText, ...this.children.map(c => c.textContent)].filter(Boolean).join(' '); }
    set textContent(value) { this.children = []; this.ownText = String(value); }
}

function loadDialog(serverPoll) {
    const sandbox = loadFrontend();
    const elements = {};
    const documentListeners = {};
    const created = [];
    sandbox.document = {
        getElementById: (id) => (elements[id] = elements[id] || new FakeEl('div', id)),
        createElement: (tag) => { const el = new FakeEl(tag); created.push(el); return el; },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (type, fn) => (documentListeners[type] = documentListeners[type] || []).push(fn)
    };
    sandbox.CONFIG.ENDPOINTS.POLL = (id) => `/polls/${id}`;
    sandbox.onPlannerEvent = () => {};
    sandbox.onSocketError = () => {};
    sandbox.showNotification = () => {};
    sandbox.requests = [];
    sandbox.apiRequest = async (endpoint) => { sandbox.requests.push(endpoint); return { success: true, data: serverPoll() }; };
    sandbox.initializePolls();

    const modal = elements.pollVotesModal;
    const body = () => elements.pollVotesBody;
    // The click as the browser delivers it: to the container's delegated listener, target inside the card
    const clickViewVotes = (pollId) => {
        const button = { dataset: { pollVotes: String(pollId) } };
        const target = { closest: (selector) => (selector === '[data-poll-votes]' ? button : null) };
        elements.messagesContainer.listeners.click.forEach(fn => fn({ target }));
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    return { sandbox, elements, modal, body, clickViewVotes, settle, documentListeners, created };
}

// The poll from the bug report: closed, single choice, not anonymous, yes = 2 voters, no = 0
function reportedPoll(overrides = {}) {
    return poll({
        question: 'Ok?',
        closed: true,
        closedAt: new Date().toISOString(),
        closedAutomatically: false,
        closedBy: { userId: 1, name: 'Steven Musonda' },
        voterCount: 2,
        myVotes: [11],
        options: [
            { id: 11, text: 'yes', votes: 2, percent: 100, voters: [{ userId: 1, name: 'Steven Musonda' }, { userId: 2, name: 'Bob Mali' }] },
            { id: 12, text: 'no', votes: 0, percent: 0, voters: [] }
        ],
        ...overrides
    });
}

describe('"View votes" dialog', () => {
    test('bug repro: with 3 or fewer voters per option, View votes opens a dialog with every voter', async () => {
        const { sandbox, modal, body, clickViewVotes, settle } = loadDialog(() => reportedPoll());
        sandbox.currentMessages.push({ id: 70, message_type: 'poll', poll: reportedPoll() });

        assert.match(sandbox.renderPollHtml(sandbox.currentMessages[0]), /data-poll-votes="7"/);

        clickViewVotes(7);
        assert.equal(modal.style.display, 'flex');
        await settle();
        const text = body().textContent;
        for (const expected of ['Ok?', 'Steven Musonda', 'Bob Mali', 'yes', '2 votes · 100%', 'no', '0 votes · 0%', 'No votes', 'Closed by Steven Musonda']) {
            assert.ok(text.includes(expected), `missing "${expected}" in: ${text}`);
        }
        assert.deepEqual([...sandbox.requests], ['/polls/7']);
    });

    test('still works after the card is re-rendered by a live update, and the open dialog follows updates', async () => {
        const { sandbox, modal, body, clickViewVotes, settle } = loadDialog(() => reportedPoll());
        sandbox.currentMessages.push({ id: 70, message_type: 'poll', poll: reportedPoll({ closed: false, closedBy: null, closedAt: null }) });

        // poll_updated replaces the card HTML (and here closes the poll)
        sandbox.applyPollUpdate(reportedPoll());
        clickViewVotes(7);
        assert.equal(modal.style.display, 'flex');
        await settle();
        assert.ok(body().textContent.includes('Bob Mali'));

        // A live update while open: a third voter appears in the dialog
        sandbox.applyPollUpdate(reportedPoll({
            voterCount: 3,
            options: [
                { id: 11, text: 'yes', votes: 2, percent: 67, voters: [{ userId: 1, name: 'Steven Musonda' }, { userId: 2, name: 'Bob Mali' }] },
                { id: 12, text: 'no', votes: 1, percent: 33, voters: [{ userId: 3, name: 'Cara' }] }
            ]
        }));
        assert.ok(body().textContent.includes('Cara'));
        assert.ok(body().textContent.includes('1 vote · 33%'));
    });

    test('closes with the button, Esc and a click outside, and opens again', async () => {
        const { sandbox, elements, modal, clickViewVotes, documentListeners, settle } = loadDialog(() => reportedPoll());
        sandbox.currentMessages.push({ id: 70, message_type: 'poll', poll: reportedPoll() });

        clickViewVotes(7);
        await settle();
        documentListeners.keydown.forEach(fn => fn({ key: 'Escape', preventDefault() {} }));
        assert.equal(modal.style.display, 'none');

        clickViewVotes(7);
        modal.listeners.click.forEach(fn => fn({ target: { inside: true } }));
        assert.equal(modal.style.display, 'flex', 'a click inside the dialog keeps it open');
        modal.listeners.click.forEach(fn => fn({ target: modal }));
        assert.equal(modal.style.display, 'none');

        clickViewVotes(7);
        elements.closePollVotes.listeners.click.forEach(fn => fn({}));
        assert.equal(modal.style.display, 'none');
    });

    test('works for a poll that is not in the loaded page (fetched from the server), open or closed', async () => {
        const { modal, body, clickViewVotes, settle } = loadDialog(() => reportedPoll({ closed: false, closedBy: null, closedAt: null, closesAt: null }));
        clickViewVotes(7);
        await settle();
        assert.equal(modal.style.display, 'flex');
        assert.ok(body().textContent.includes('Open · no end time'));
        assert.ok(body().textContent.includes('Steven Musonda'));
    });

    test('a poll closed at its closing time says so', async () => {
        const auto = () => reportedPoll({ closedAutomatically: true, closedBy: null });
        const { sandbox, body, clickViewVotes, settle } = loadDialog(auto);
        sandbox.currentMessages.push({ id: 70, message_type: 'poll', poll: auto() });
        clickViewVotes(7);
        await settle();
        assert.ok(body().textContent.includes('Closed automatically'));
    });

    test('user text goes in as text: no element is ever created from a name or an option', async () => {
        const evil = '<img src=x onerror=alert(1)>';
        const payload = () => reportedPoll({
            question: evil,
            options: [{ id: 11, text: evil, votes: 1, percent: 100, voters: [{ userId: 2, name: evil }] }]
        });
        const { sandbox, body, clickViewVotes, settle, created } = loadDialog(payload);
        sandbox.currentMessages.push({ id: 70, message_type: 'poll', poll: payload() });
        clickViewVotes(7);
        await settle();
        assert.ok(body().textContent.includes(evil));
        assert.ok(!created.some(el => el.tagName.toLowerCase() === 'img'));
    });

    test('anonymous polls: no View votes link, and the dialog shows counts only', () => {
        const anonymous = reportedPoll({ anonymous: true, closedBy: null, closedAutomatically: true });
        assert.ok(!loadFrontend().renderPollHtml({ id: 70, poll: anonymous }).includes('data-poll-votes'));

        // Even if names somehow arrived, the dialog does not show them
        const { sandbox, body } = loadDialog(() => anonymous);
        sandbox.renderPollVotes(anonymous);
        const text = body().textContent;
        assert.ok(text.includes('2 votes · 100%'));
        assert.ok(text.includes('only the counts are shown'));
        assert.ok(!text.includes('Bob Mali'));
        assert.ok(!text.includes('Steven Musonda'));
    });
});
