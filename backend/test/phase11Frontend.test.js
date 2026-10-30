/**
 * Phase 11 frontend rules, loaded from the real files: call notice wording for caller and callee,
 * durations, camera/microphone error messages (blocked, missing, busy, timeout, insecure page),
 * the media timeout stopping a late stream, system notices routed to the call text, and the page wiring
 * (buttons, modals, script order, service worker cache, socket events).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runFrontendScript } = require('./helpers/frontendScripts');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

function loadFrontend({ secure = true, getUserMedia } = {}) {
    const sandbox = {
        console: { log() {}, error() {}, warn() {} },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {},
        Date,
        URLSearchParams,
        window: { isSecureContext: secure, addEventListener() {} },
        navigator: { userAgent: 'Mozilla/5.0', mediaDevices: { getUserMedia: getUserMedia || (() => Promise.resolve({ getTracks: () => [] })) } },
        RTCPeerConnection: function RTCPeerConnection() {},
        CONFIG: {
            ENDPOINTS: {},
            CALL_MEDIA_TIMEOUT_MS: 30,
            CALL_RING_TIMEOUT_MS: 30000,
            CALL_RECONNECT_TIMEOUT_MS: 12000,
            DISAPPEARING_OPTIONS: [{ seconds: 0, label: 'Off' }, { seconds: 86400, label: '24 hours' }]
        },
        document: { getElementById: () => null, querySelector: () => null },
        getCurrentUser: () => ({ userId: 1 }),
        formatTime: () => '10:00',
        allChats: [],
        currentChatId: null
    };
    vm.createContext(sandbox);
    const chat = read('js/chat.js');
    const escapeSource = chat.slice(chat.indexOf('function escapeHtml(text)'), chat.indexOf('}', chat.indexOf(".replace(/'/g, '&#39;');")) + 1);
    vm.runInContext(escapeSource, sandbox);
    runFrontendScript(read('js/calls.js'), sandbox);
    runFrontendScript(read('js/disappearing.js'), sandbox);
    return sandbox;
}

describe('call notices', () => {
    const sandbox = loadFrontend();
    const notice = (content, senderId) => ({ id: 1, content, sender_id: senderId, created_at: '2026-10-30T10:00:00Z' });

    test('durations', () => {
        assert.equal(sandbox.formatCallDuration(0), '0:00');
        assert.equal(sandbox.formatCallDuration(252), '4:12');
        assert.equal(sandbox.formatCallDuration(3725), '1:02:05');
    });

    test('worded for the viewer: caller (sender) vs callee', () => {
        const d = (content, sender) => sandbox.describeCallNotice(notice(content, sender));
        assert.equal(d('call:voice:completed:252', 1), 'Voice call, 4:12');
        assert.equal(d('call:voice:completed:252', 2), 'Voice call, 4:12');
        assert.equal(d('call:video:missed:0', 2), 'Missed video call');
        assert.equal(d('call:video:missed:0', 1), 'Video call, no answer');
        assert.equal(d('call:video:cancelled:0', 2), 'Missed video call');
        assert.equal(d('call:voice:busy:0', 1), 'Voice call, busy');
        assert.equal(d('call:voice:declined:0', 1), 'Voice call declined');
        assert.equal(d('call:voice:declined:0', 2), 'You declined a voice call');
        assert.equal(d('call:video:failed:0', 1), 'Video call failed');
        assert.equal(d('call:video:failed:65', 1), 'Video call, 1:05 (connection lost)');
    });

    test('missed (red) only for the callee', () => {
        assert.equal(sandbox.isMissedCallNotice(notice('call:video:missed:0', 2)), true);
        assert.equal(sandbox.isMissedCallNotice(notice('call:video:missed:0', 1)), false);
        assert.equal(sandbox.isMissedCallNotice(notice('call:video:completed:3', 2)), false);
    });

    test('system notices route call codes to the call text; anything else stays a settings notice', () => {
        assert.equal(sandbox.describeSystemMessage(notice('call:video:missed:0', 2)), 'Missed video call');
        assert.equal(sandbox.describeSystemMessage(notice('call:<img src=x>:missed:0', 2)), 'Chat settings were changed');
        const html = sandbox.renderSystemMessageHtml(notice('call:video:missed:0', 2));
        assert.match(html, /class="system-message call-notice missed"/);
        assert.match(html, /<polygon/, 'camera icon');
        assert.match(html, /Missed video call/);
    });
});

describe('camera and microphone errors', () => {
    test('clear messages for each failure', () => {
        const sandbox = loadFrontend();
        const m = (name, type = 'video') => sandbox.mediaErrorMessage({ name }, type);
        assert.match(m('NotAllowedError'), /blocked/);
        assert.match(m('NotAllowedError', 'voice'), /microphone was blocked|Access to your microphone/);
        assert.match(m('NotFoundError'), /No camera or microphone/);
        assert.match(m('NotFoundError', 'voice'), /No microphone/);
        assert.match(m('NotReadableError'), /another app/);
        assert.match(m('TimeoutError'), /Timed out/);
        assert.match(m('Whatever'), /Couldn't start/);
    });

    test('an insecure page explains HTTPS before asking for anything', () => {
        const sandbox = loadFrontend({ secure: false });
        assert.match(sandbox.mediaSupportError(), /https/);
        assert.match(sandbox.mediaErrorMessage({ name: 'InsecureContextError' }, 'voice'), /https/);
    });

    test('an unanswered permission prompt times out, and a stream that arrives later is stopped', async () => {
        let resolveLate;
        let stopped = 0;
        const sandbox = loadFrontend({ getUserMedia: () => new Promise(resolve => { resolveLate = resolve; }) });
        await assert.rejects(sandbox.getMediaWithTimeout({ audio: true }, 20), error => error.name === 'TimeoutError');
        resolveLate({ getTracks: () => [{ stop: () => { stopped++; } }] });
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(stopped, 1);
    });

    test('a video call without a camera continues with audio only; a refusal does not', async () => {
        const calls = [];
        const sandbox = loadFrontend({
            getUserMedia: (constraints) => {
                calls.push(constraints);
                if (constraints.video) return Promise.reject({ name: 'NotFoundError' });
                return Promise.resolve({ getTracks: () => [], getVideoTracks: () => [] });
            }
        });
        const media = await sandbox.getCallMedia('video');
        assert.equal(media.cameraMissing, true);
        assert.equal(calls.length, 2);

        const refused = loadFrontend({ getUserMedia: () => Promise.reject({ name: 'NotAllowedError' }) });
        await assert.rejects(refused.getCallMedia('video'), error => error.name === 'NotAllowedError');
    });
});

describe('page wiring', () => {
    const html = read('chat.html');

    test('call buttons, incoming modal, call screen and Calls panel are on the page', () => {
        for (const id of ['voiceCallBtn', 'videoCallBtn', 'incomingCallModal', 'acceptCallBtn', 'declineCallBtn', 'callScreen',
            'remoteVideo', 'remoteAudio', 'localVideo', 'callMuteBtn', 'callCameraBtn', 'callScreenBtn', 'callHangupBtn', 'callsBtn', 'callsModal']) {
            assert.ok(html.includes(`id="${id}"`), id);
        }
        assert.match(html, /id="localVideo"[^>]*\bmuted\b/, 'own audio never plays back');
        assert.match(html, /id="remoteVideo"[^>]*\bplaysinline\b/, 'iOS plays inline');
        assert.ok(html.indexOf('js/disappearing.js') < html.indexOf('js/calls.js'));
        assert.match(html, /startFeature\('Calls', \(\) => FriChat\.initializeCalls\(\)\)/);
    });

    test('socket events and the service worker cache', () => {
        const ws = read('js/websocket.js');
        for (const event of ['call_invite', 'call_ringing', 'call_accept', 'call_reject', 'call_busy', 'call_cancel', 'call_timeout',
            'call_offer', 'call_answer', 'call_ice_candidate', 'call_hangup']) {
            assert.ok(ws.includes(`'${event}'`), event);
        }
        const sw = read('sw.js');
        assert.match(sw, /'js\/calls\.js'/);
        assert.match(sw, /requireInteraction: isCall/);
    });

    test('names reach the call UI through textContent only', () => {
        const source = read('js/calls.js');
        const innerHtmlLines = source.split('\n').filter(line => /innerHTML\s*=/.test(line));
        assert.ok(innerHtmlLines.every(line => /svgIcon\(/.test(line)), innerHtmlLines.join('\n'));
    });
});
