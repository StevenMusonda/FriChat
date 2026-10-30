/**
 * Phase 12 frontend rules, loaded from the real files: the event card escapes every user text and
 * shows the viewer's own answer (from the name lists, since room broadcasts don't carry myRsvp),
 * closed events can't be answered, event/list notices read well and only link to things that
 * still exist, and the list and event dialogs never put user text into innerHTML.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runFrontendScript } = require('./helpers/frontendScripts');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

function loadFrontend(userId = 2) {
    const sandbox = {
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
        Intl,
        Date,
        CONFIG: { ENDPOINTS: {} },
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        currentMessages: [],
        getCurrentUser: () => ({ userId })
    };
    vm.createContext(sandbox);
    // The real escaping helper from chat.js (the rest of chat.js needs a DOM)
    const chat = read('js/chat.js');
    const escapeSource = chat.slice(chat.indexOf('function escapeHtml(text)'), chat.indexOf('}', chat.indexOf(".replace(/'/g, '&#39;');")) + 1);
    vm.runInContext(escapeSource, sandbox);
    runFrontendScript(read('js/planner.js'), sandbox);
    runFrontendScript(read('js/events.js'), sandbox);
    return sandbox;
}

function event(overrides = {}) {
    return {
        id: 7,
        chatId: 5,
        messageId: 70,
        createdBy: 1,
        createdByName: 'Alice',
        title: '<img src=x onerror=alert(1)> dinner',
        description: '<script>alert(1)</script>',
        location: 'Mum\'s "place" & garden',
        timezone: 'UTC',
        startsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 7200 * 1000).toISOString(),
        status: 'active',
        started: false,
        ended: false,
        reminders: ['1h'],
        counts: { going: 1, maybe: 1, declined: 0 },
        rsvps: {
            going: [{ userId: 1, name: '<b>Alice</b>' }],
            maybe: [{ userId: 2, name: 'Bob' }],
            declined: []
        },
        ...overrides
    };
}

describe('event card', () => {
    test('title, place and names are escaped', () => {
        const sandbox = loadFrontend();
        const html = sandbox.FriChat.renderEventCardHtml({ id: 70, content: 'x', event: event() });
        assert.ok(!html.includes('<img'));
        assert.ok(!html.includes('<b>Alice'));
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; dinner'));
        assert.ok(html.includes('Mum&#39;s &quot;place&quot; &amp; garden'));
        assert.ok(html.includes('&lt;b&gt;Alice&lt;/b&gt;'));
        // The description is only in the details dialog (textContent)
        assert.ok(!html.includes('alert(1)</script>'));
    });

    test('the viewer\'s answer comes from the name lists when the broadcast has no myRsvp', () => {
        const bob = loadFrontend(2).FriChat.renderEventCardHtml({ id: 70, event: event() });
        assert.match(bob, /class="event-rsvp-btn chosen"\s+data-event-rsvp="maybe"/);
        assert.match(bob, /data-event-rsvp="maybe" data-event-id="7"\s+aria-pressed="true"/);
        const carol = loadFrontend(3).FriChat.renderEventCardHtml({ id: 70, event: event() });
        assert.ok(!carol.includes('event-rsvp-btn chosen'));
        assert.match(carol, /0 can't go|0 can&#39;t go/);
    });

    test('cancelled and ended events can\'t be answered or added to a calendar when cancelled', () => {
        const sandbox = loadFrontend();
        const cancelled = sandbox.FriChat.renderEventCardHtml({ id: 70, event: event({ status: 'cancelled' }) });
        assert.equal((cancelled.match(/disabled/g) || []).length, 3);
        assert.ok(cancelled.includes('Cancelled'));
        assert.ok(!cancelled.includes('data-event-ics'));
        const ended = sandbox.FriChat.renderEventCardHtml({ id: 70, event: event({ ended: true, started: true }) });
        assert.equal((ended.match(/disabled/g) || []).length, 3);
        assert.ok(ended.includes('data-event-ics'));
        const gone = sandbox.FriChat.renderEventCardHtml({ id: 70, content: '<i>x</i>', event: null });
        assert.ok(gone.includes('no longer available'));
        assert.ok(!gone.includes('<i>'));
    });

    test('an event planned in another timezone also shows the time there', () => {
        const sandbox = loadFrontend();
        const zone = sandbox.Intl.DateTimeFormat().resolvedOptions().timeZone;
        const other = zone === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';
        assert.ok(sandbox.FriChat.renderEventCardHtml({ id: 70, event: event({ timezone: other }) }).includes(`in ${other.replace(/_/g, ' ')}`));
        assert.ok(!sandbox.FriChat.renderEventCardHtml({ id: 70, event: event({ timezone: zone }) }).includes('event-card-zone'));
    });
});

describe('event and list notices', () => {
    const sandbox = loadFrontend(2);
    const { describePlanNotice, isPlanNotice, planNoticeTarget } = sandbox.FriChat;
    const notice = (content, extra = {}) => ({ message_type: 'system', content, sender_id: 1, full_name: 'Alice', ...extra });

    test('read as sentences with the current title', () => {
        assert.equal(describePlanNotice(notice('event_updated:7:time,location', { event_ref: { id: 7, title: 'Dinner' } })),
            'Alice changed the time and place of “Dinner”');
        assert.equal(describePlanNotice(notice('event_updated:7:title,time,location', { event_ref: { id: 7, title: 'Dinner' } })),
            'Alice changed the name, time and place of “Dinner”');
        assert.equal(describePlanNotice(notice('event_cancelled:7', { sender_id: 2, event_ref: { id: 7, title: 'Dinner' } })), 'You cancelled “Dinner”');
        assert.equal(describePlanNotice(notice('list_created:3', { list_ref: { id: 3, name: 'Groceries' } })), 'Alice created the list “Groceries”');
        assert.equal(describePlanNotice(notice('list_created:3')), 'Alice created a list');
        assert.equal(describePlanNotice(notice('event_cancelled:7')), 'Alice cancelled an event');
    });

    test('only plan codes count, and they link only while the event or list exists', () => {
        assert.equal(isPlanNotice(notice('disappearing:86400')), false);
        assert.equal(isPlanNotice(notice('call:voice:missed:0')), false);
        assert.equal(isPlanNotice({ message_type: 'text', content: 'event_cancelled:7' }), false);
        assert.deepEqual({ ...planNoticeTarget(notice('event_updated:7:time', { event_ref: { id: 7, title: 'x' } })) }, { kind: 'event', id: 7 });
        assert.deepEqual({ ...planNoticeTarget(notice('list_created:3', { list_ref: { id: 3, name: 'x' } })) }, { kind: 'list', id: 3 });
        assert.equal(planNoticeTarget(notice('list_created:3')), null);
    });
});

describe('page wiring', () => {
    test('chat.html loads both scripts after calls.js, starts them, and the service worker caches them', () => {
        const html = read('chat.html');
        assert.ok(html.indexOf('js/calls.js') < html.indexOf('js/events.js'));
        assert.ok(html.indexOf('js/events.js') < html.indexOf('js/lists.js'));
        assert.ok(html.includes('FriChat.initializeEvents()') && html.includes('FriChat.initializeLists()'));
        const sw = read('sw.js');
        assert.ok(sw.includes("'js/events.js'") && sw.includes("'js/lists.js'"));
        const ws = read('js/websocket.js');
        for (const event of ['event_updated', 'event_reminder', 'list_updated', 'list_deleted', 'list_item_due']) {
            assert.ok(ws.includes(`'${event}'`), event);
        }
    });
});

describe('no user text in innerHTML', () => {
    test('lists.js and the dialogs in events.js build their DOM with textContent', () => {
        const lists = read('js/lists.js');
        assert.ok(!/\.innerHTML\s*=/.test(lists));
        assert.ok(!/insertAdjacentHTML/.test(lists));
        const events = read('js/events.js');
        assert.ok(!/\.innerHTML\s*=/.test(events));
        // The only HTML strings are the escaped card and fixed icons
        const htmlAssignments = [...events.matchAll(/outerHTML\s*=\s*([A-Za-z]+)/g)].map(m => m[1]);
        assert.deepEqual([...new Set(htmlAssignments)], ['renderEventCardHtml']);
    });
});
