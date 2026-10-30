/**
 * Phase 10 frontend rules, loaded from the real files: recorder format choice for Chrome/Firefox
 * (webm/opus), Safari (mp4) and older Firefox (ogg), waveform compression, microphone error messages,
 * the voice player markup (numbers only, so nothing user-supplied reaches innerHTML), system notices
 * with escaped names, and expired messages leaving the open thread.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runFrontendScript } = require('./helpers/frontendScripts');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

function element() {
    return {
        hidden: false,
        removed: false,
        textContent: '',
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        remove() { this.removed = true; },
        previousElementSibling: null
    };
}

function loadFrontend() {
    const elements = new Map();
    const sandbox = {
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {},
        Intl,
        Date,
        localStorage: { getItem: () => null, setItem() {} },
        window: {},
        navigator: {},
        performance: { now: () => 0 },
        CONFIG: {
            ENDPOINTS: {},
            VOICE_MAX_SECONDS: 300,
            VOICE_WAVEFORM_BARS: 48,
            VOICE_HOLD_MS: 300,
            DISAPPEARING_OPTIONS: [
                { seconds: 0, label: 'Off' },
                { seconds: 86400, label: '24 hours' },
                { seconds: 604800, label: '7 days' },
                { seconds: 7776000, label: '90 days' }
            ]
        },
        document: {
            getElementById: () => null,
            querySelector: (selector) => {
                const match = /data-message-id="(\d+)"/.exec(selector);
                return match ? (elements.get(Number(match[1])) || null) : null;
            },
            querySelectorAll: () => []
        },
        getCurrentUser: () => ({ userId: 1 }),
        formatTime: () => '10:00',
        allChats: [],
        currentChatId: 5,
        hasOlderMessages: false,
        rerendered: [],
        notifications: [],
        elements
    };
    vm.createContext(sandbox);
    const chat = read('js/chat.js');
    const escapeSource = chat.slice(chat.indexOf('function escapeHtml(text)'), chat.indexOf('}', chat.indexOf(".replace(/'/g, '&#39;');")) + 1);
    vm.runInContext(escapeSource, sandbox);
    // Globals other modules own (messages.js, messageActions.js, ui.js)
    vm.runInContext(`
        var currentMessages = [];
        function rerenderMessage(m) { rerendered.push(m.id); }
        function renderMessages() {}
        function refreshChatList() {}
        function showNotification(text) { notifications.push(text); }
    `, sandbox);
    runFrontendScript(read('js/voice.js'), sandbox);
    runFrontendScript(read('js/disappearing.js'), sandbox);
    return sandbox;
}

describe('voice recorder helpers', () => {
    const sandbox = loadFrontend();

    test('format: webm/opus where supported, mp4 on Safari, ogg on older Firefox, else the default', () => {
        const supports = (...types) => (mime) => types.includes(mime);
        assert.equal(sandbox.pickVoiceFormat(supports('audio/webm;codecs=opus', 'audio/mp4')).type, 'audio/webm');
        assert.equal(sandbox.pickVoiceFormat(supports('audio/mp4')).type, 'audio/mp4');
        assert.equal(sandbox.pickVoiceFormat(supports('audio/mp4')).ext, 'm4a');
        assert.equal(sandbox.pickVoiceFormat(supports('audio/ogg;codecs=opus')).type, 'audio/ogg');
        assert.equal(sandbox.pickVoiceFormat(supports()), null);
        assert.equal(sandbox.pickVoiceFormat(() => { throw new Error('unknown'); }), null);
        assert.equal(sandbox.pickVoiceFormat(undefined), null);
    });

    test('the uploaded type follows what the recorder really produced, without codec parameters', () => {
        assert.equal(sandbox.voiceFileFormat('audio/webm;codecs=opus', null).type, 'audio/webm');
        assert.equal(sandbox.voiceFileFormat('audio/mp4', null).ext, 'm4a');
        assert.equal(sandbox.voiceFileFormat('', { type: 'audio/ogg', ext: 'ogg' }).type, 'audio/ogg');
        assert.equal(sandbox.voiceFileFormat('', null).type, 'audio/webm');
    });

    test('waveform: requested number of bars, 5..100, loudest bar full height', () => {
        const bars = sandbox.compressWaveform([0, 0.1, 0.5, 0.2, 0, 0.25], 3);
        assert.equal(bars.length, 3);
        assert.equal(Math.max(...bars), 100);
        assert.ok(bars.every(v => Number.isInteger(v) && v >= 5 && v <= 100));
        const long = sandbox.compressWaveform(Array.from({ length: 3000 }, (_, i) => (i % 10) / 10), 48);
        assert.equal(long.length, 48);
        assert.deepEqual(Array.from(sandbox.compressWaveform([], 4)), [5, 5, 5, 5]);
        assert.deepEqual(Array.from(sandbox.compressWaveform([0, 0], 2)), [5, 5], 'silence');
        assert.equal(sandbox.compressWaveform([1], 200).length, 64, 'never more than the server accepts');
    });

    test('time format and microphone errors', () => {
        assert.equal(sandbox.formatVoiceTime(0), '0:00');
        assert.equal(sandbox.formatVoiceTime(83.9), '1:23');
        assert.equal(sandbox.formatVoiceTime(300), '5:00');
        assert.match(sandbox.microphoneErrorMessage({ name: 'NotAllowedError' }), /blocked/);
        assert.match(sandbox.microphoneErrorMessage({ name: 'NotFoundError' }), /No microphone/);
        assert.match(sandbox.microphoneErrorMessage({ name: 'NotReadableError' }), /in use/);
        assert.match(sandbox.microphoneErrorMessage(null), /Could not start/);
    });
});

describe('voice player markup', () => {
    const sandbox = loadFrontend();

    test('only numbers from the message reach the HTML', () => {
        const html = sandbox.renderVoiceNoteHtml({
            id: '7"><img src=x onerror=alert(1)>',
            sender_id: 2,
            duration_ms: 4200,
            waveform: ['<script>', 50, 100],
            played_by_me: false
        });
        assert.ok(!html.includes('<img'));
        assert.ok(!html.includes('<script>'));
        assert.match(html, /data-voice-play="7"/);
        assert.match(html, /0:04/);
        assert.match(html, /style="height:5%"/, 'a non-number level becomes the minimum');
        assert.match(html, /voice-note-unplayed/);
        assert.match(html, /type="range" class="voice-seek"/);
        assert.match(html, /data-voice-speed="7"[^>]*>1×</);
    });

    test('own notes show played state; others show nothing once played', () => {
        const own = sandbox.renderVoiceNoteHtml({ id: 8, sender_id: 1, duration_ms: 1000, waveform: null, voice_played: true });
        assert.match(own, /voice-note-state played/);
        assert.equal((own.match(/<span class="" style="height:30%"><\/span>/g) || []).length, 48, 'flat bars without a waveform');
        const theirs = sandbox.renderVoiceNoteHtml({ id: 9, sender_id: 2, duration_ms: 1000, played_by_me: true });
        assert.ok(!theirs.includes('voice-note-unplayed'));
    });
});

describe('disappearing messages UI', () => {
    test('timer labels and system notices; names are escaped', () => {
        const sandbox = loadFrontend();
        assert.equal(sandbox.disappearingLabel(604800), '7 days');
        assert.equal(sandbox.disappearingLabel(0), 'Off');

        assert.equal(
            sandbox.describeSystemMessage({ content: 'disappearing:86400', sender_id: 1 }),
            'You turned on disappearing messages. New messages will disappear 24 hours after they\'re sent.'
        );
        assert.equal(
            sandbox.describeSystemMessage({ content: 'disappearing:0', sender_id: 2, full_name: 'Bob' }),
            'Bob turned off disappearing messages.'
        );
        assert.equal(sandbox.describeSystemMessage({ content: 'something else', sender_id: 2 }), 'Chat settings were changed');

        const html = sandbox.renderSystemMessageHtml({ id: 3, content: 'disappearing:7776000', sender_id: 2, full_name: '<img src=x onerror=alert(1)>' });
        assert.ok(!html.includes('<img'));
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; turned on disappearing messages/);
        assert.match(html, /data-system-message-id="3"/);
    });

    test('expiry badge and chat list clock only when on', () => {
        const sandbox = loadFrontend();
        assert.equal(sandbox.renderExpiryBadgeHtml({ expires_at: null }), '');
        assert.match(sandbox.renderExpiryBadgeHtml({ expires_at: '2030-01-01T00:00:00.000Z' }), /class="message-expiry"/);
        assert.equal(sandbox.renderChatListDisappearingIcon({ disappearing_seconds: 0 }), '');
        assert.match(sandbox.renderChatListDisappearingIcon({ disappearing_seconds: 86400 }), /Disappearing messages: 24 hours/);
    });

    test('expired messages leave the thread and quotes of them become "deleted"', () => {
        const sandbox = loadFrontend();
        const expired = element();
        sandbox.elements.set(10, expired);
        vm.runInContext(`
            currentMessages = [
                { id: 10, expires_at: '2000-01-01T00:00:00.000Z' },
                { id: 11, expires_at: null, reply_to: { id: 10, deleted: false } },
                { id: 12, expires_at: '2999-01-01T00:00:00.000Z' }
            ];
        `, sandbox);

        sandbox.sweepExpiredMessages(Date.now());

        const ids = vm.runInContext('currentMessages.map(m => m.id)', sandbox);
        assert.deepEqual(Array.from(ids), [11, 12]);
        assert.equal(expired.removed, true);
        assert.equal(vm.runInContext('currentMessages[0].reply_to.deleted', sandbox), true);
        assert.deepEqual(Array.from(sandbox.rerendered), [11]);
    });

    test('messages_expired for the open chat removes exactly those messages', () => {
        const sandbox = loadFrontend();
        vm.runInContext(`currentMessages = [{ id: 1 }, { id: 2 }, { id: 3 }];`, sandbox);
        sandbox.applyMessagesExpired({ chatId: 99, messageIds: [1] }); // another chat
        sandbox.applyMessagesExpired({ chatId: 5, messageIds: [1, 3] });
        assert.deepEqual(Array.from(vm.runInContext('currentMessages.map(m => m.id)', sandbox)), [2]);
    });
});

describe('page wiring', () => {
    const html = read('chat.html');

    test('scripts, mic button, recorder bar and the timer dialog with its warning are on the page', () => {
        assert.ok(html.indexOf('js/voice.js') > html.indexOf('js/composer.js'));
        assert.ok(html.indexOf('js/disappearing.js') > html.indexOf('js/groups.js'), 'needs h() from groups.js');
        for (const id of ['voiceBtn', 'voiceRecorderBar', 'voiceCancelBtn', 'voiceSendBtn', 'voiceTimer', 'disappearingModal', 'chatDisappearingIcon']) {
            assert.ok(html.includes(`id="${id}"`), id);
        }
        assert.match(html, /can still copy, screenshot,\s+forward or save messages/);
        assert.match(html, /startFeature\('Voice notes', \(\) => FriChat\.initializeVoiceNotes\(\)\);\s+startFeature\('Disappearing messages', \(\) => FriChat\.initializeDisappearing\(\)\);/);
    });

    test('messages.js routes system notices and voice notes to their renderers', () => {
        const messages = read('js/messages.js');
        assert.match(messages, /message\.message_type === 'system'[\s\S]*renderSystemMessageHtml\(message\)/);
        assert.match(messages, /case 'voice':[\s\S]*renderVoiceNoteHtml\(message\)/);
    });

    test('the service worker caches the new scripts', () => {
        const sw = read('sw.js');
        assert.ok(sw.includes("'js/voice.js'"));
        assert.ok(sw.includes("'js/disappearing.js'"));
    });
});
