/**
 * Calls Module (phase 11)
 * 1:1 voice and video calls over WebRTC (peer to peer), with Socket.IO for signaling (backend/utils/calls.js).
 *
 *   - Voice/video buttons in a direct chat's header; the full-screen call view (remote video, local
 *     picture-in-picture, mute, camera, screen sharing on desktop, hang up, timer)
 *   - The incoming-call modal with Accept/Decline and a ringtone that stays silent during do-not-disturb
 *   - Camera/microphone errors (blocked, no device, in use, insecure page, no answer to the prompt)
 *     end with a clear message; every wait has a timeout so the UI never hangs
 *   - Connection drops: one ICE restart (by the caller), then the call ends with a message
 *   - "Missed video call" / "Voice call, 4:12" notices in the thread and the Calls panel
 *
 * Every name shown comes from the server and is set with textContent (never innerHTML).
 */

(function (FriChat) {

const SVG = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>',
    video: '<polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>'
};

function svgIcon(name, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`;
}

// Used when GET /calls/ice-servers fails (calls still work on most networks without TURN)
const FALLBACK_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

// Wait this long in "disconnected" before restarting ICE (it often recovers by itself)
const DISCONNECTED_GRACE_MS = 2500;

// The call in progress (this tab), and a call ringing here
let call = null;
let incoming = null;

// The open direct chat's call target, from GET /chats/:id
let headerTarget = null;

// Calls panel paging
let callsNextBefore = null;
let callsLoading = false;

// ===== Text =====

function formatCallDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * "call:video:missed:0" -> { type, status, seconds }, or null
 */
function parseCallNotice(content) {
    const match = /^call:(voice|video):([a-z]+):(\d+)$/.exec(String(content || ''));
    return match ? { type: match[1], status: match[2], seconds: Number(match[3]) } : null;
}

function isCallNotice(message) {
    return !!parseCallNotice(message && message.content);
}

/**
 * Plain text of a call notice, worded for the viewer (the notice's sender is the caller). Callers escape it.
 */
function describeCallNotice(message) {
    const notice = parseCallNotice(message && message.content);
    if (!notice) return 'Call';
    const label = notice.type === 'video' ? 'Video call' : 'Voice call';
    const lower = label.toLowerCase();
    const iCalled = Number(message.sender_id) === Number(getCurrentUser().userId);

    switch (notice.status) {
        case 'completed':
            return `${label}, ${formatCallDuration(notice.seconds)}`;
        case 'failed':
            return notice.seconds > 0 ? `${label}, ${formatCallDuration(notice.seconds)} (connection lost)` : `${label} failed`;
        case 'declined':
            return iCalled ? `${label} declined` : `You declined a ${lower}`;
        case 'missed':
            return iCalled ? `${label}, no answer` : `Missed ${lower}`;
        case 'cancelled':
            return iCalled ? `Cancelled ${lower}` : `Missed ${lower}`;
        case 'busy':
            return iCalled ? `${label}, busy` : `Missed ${lower}`;
        default:
            return label;
    }
}

function callNoticeIconHtml(message) {
    const notice = parseCallNotice(message && message.content);
    return svgIcon(notice && notice.type === 'video' ? 'video' : 'phone', 14);
}

/**
 * Was this notice a call the viewer missed? (shown in red)
 */
function isMissedCallNotice(message) {
    const notice = parseCallNotice(message && message.content);
    if (!notice || Number(message.sender_id) === Number(getCurrentUser().userId)) return false;
    return ['missed', 'cancelled', 'busy'].includes(notice.status);
}

function personName(person) {
    return (person && (person.fullName || person.full_name || person.username)) || 'Someone';
}

// ===== Media =====

class CallMediaError extends Error {
    constructor(name, message) {
        super(message || name);
        this.name = name;
    }
}

/**
 * Why this page can't make calls at all, or null
 */
function mediaSupportError() {
    if (!window.isSecureContext) {
        return 'Calls need a secure connection. Open FriChat over https:// (or on localhost) to make calls.';
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof RTCPeerConnection === 'undefined') {
        return 'This browser doesn\'t support calls. Try a recent version of Chrome, Firefox, Edge or Safari.';
    }
    return null;
}

function mediaErrorMessage(error, type) {
    const device = type === 'video' ? 'camera and microphone' : 'microphone';
    switch (error && error.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
        case 'SecurityError':
            return `Access to your ${device} was blocked. Allow it in your browser's site settings and try again.`;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
        case 'OverconstrainedError':
            return `No ${type === 'video' ? 'camera or microphone' : 'microphone'} was found. Connect one and try again.`;
        case 'NotReadableError':
        case 'TrackStartError':
        case 'AbortError':
            return `Your ${device} is being used by another app or couldn't be started.`;
        case 'TimeoutError':
            return `Timed out waiting for your ${device}. Answer the browser's permission prompt and try again.`;
        case 'InsecureContextError':
            return mediaSupportError() || 'Calls need a secure connection (HTTPS).';
        default:
            return `Couldn't start your ${device}.`;
    }
}

function stopStream(stream) {
    if (stream) stream.getTracks().forEach(track => track.stop());
}

/**
 * getUserMedia that gives up after CALL_MEDIA_TIMEOUT_MS (a permission prompt nobody answers).
 * A stream that arrives after the timeout is stopped.
 */
function getMediaWithTimeout(constraints, timeoutMs = CONFIG.CALL_MEDIA_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            reject(new CallMediaError('TimeoutError'));
        }, timeoutMs);
        navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
            if (settled) {
                stopStream(stream);
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(stream);
        }, (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

/**
 * Microphone (and camera for video). A video call whose camera is missing or busy goes on with
 * audio only; a blocked permission doesn't (the user said no).
 * @returns {Promise<{ stream: MediaStream, cameraMissing: boolean }>}
 */
async function getCallMedia(type) {
    if (mediaSupportError()) throw new CallMediaError('InsecureContextError');
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (type !== 'video') {
        return { stream: await getMediaWithTimeout({ audio, video: false }), cameraMissing: false };
    }
    try {
        const stream = await getMediaWithTimeout({
            audio,
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        });
        return { stream, cameraMissing: false };
    } catch (error) {
        if (['NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'OverconstrainedError'].includes(error && error.name)) {
            return { stream: await getMediaWithTimeout({ audio, video: false }), cameraMissing: true };
        }
        throw error;
    }
}

/**
 * STUN/TURN for this user (TURN credentials are short-lived, so fetched for every call and restart)
 */
async function fetchIceServers() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.CALL_ICE_SERVERS);
        if (response && response.success && Array.isArray(response.data.iceServers) && response.data.iceServers.length > 0) {
            return response.data.iceServers;
        }
    } catch (error) {
        console.error('ICE servers error:', error);
    }
    return FALLBACK_ICE_SERVERS;
}

function canShareScreen() {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')
        && !coarse
        && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// ===== Ringtone (Web Audio, no files) =====

const tone = { ctx: null, timer: null };

function audioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!tone.ctx) tone.ctx = new AudioCtx();
    if (tone.ctx.state === 'suspended') tone.ctx.resume().catch(() => {});
    return tone.ctx;
}

function playNote(ctx, frequency, startAt, duration, volume) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.02);
    gain.gain.setValueAtTime(volume, startAt + duration - 0.05);
    gain.gain.linearRampToValueAtTime(0, startAt + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.05);
}

/**
 * 'ring': incoming call; 'ringback': the caller hears it ringing
 */
function startTone(kind) {
    stopTone();
    let ctx;
    try {
        ctx = audioContext();
    } catch (error) {
        return;
    }
    if (!ctx) return;
    const play = () => {
        const t = ctx.currentTime + 0.05;
        if (kind === 'ring') {
            [0, 0.18, 0.36, 0.9, 1.08, 1.26].forEach((offset, i) => playNote(ctx, i % 2 ? 660 : 880, t + offset, 0.16, 0.18));
        } else {
            playNote(ctx, 440, t, 1.2, 0.06);
            playNote(ctx, 480, t, 1.2, 0.06);
        }
    };
    play();
    tone.timer = setInterval(play, kind === 'ring' ? 2500 : 4000);
    if (kind === 'ring' && navigator.vibrate) navigator.vibrate([400, 200, 400]);
}

function stopTone() {
    clearInterval(tone.timer);
    tone.timer = null;
    if (navigator.vibrate) navigator.vibrate(0);
}

function dndActiveHere() {
    return typeof notificationSettings !== 'undefined' && !!(notificationSettings && notificationSettings.dndActive);
}

// ===== UI =====

function el(id) {
    return document.getElementById(id);
}

function fillCallAvatar(container, person) {
    if (!container) return;
    const src = typeof FriChat.userAvatarSrc === 'function' ? FriChat.userAvatarSrc(person && (person.avatarUrl || person.avatar_url)) : null;
    container.replaceChildren(src
        ? FriChat.h('img', { attrs: { src, alt: '' } })
        : FriChat.h('span', { text: personName(person).charAt(0).toUpperCase() }));
}

function setCallStatus(text) {
    const status = el('callStatus');
    if (status) status.textContent = text;
}

function showCallScreen(current) {
    const screen = el('callScreen');
    el('callPeerName').textContent = personName(current.peer);
    fillCallAvatar(el('callPeerAvatar'), current.peer);
    screen.classList.toggle('is-video', current.type === 'video');
    screen.classList.remove('has-remote-video', 'has-local-video');
    screen.hidden = false;
    document.body.classList.add('in-call');
    updateControls(current);
    el('callHangupBtn').focus();
}

function hideCallScreen() {
    const screen = el('callScreen');
    if (!screen) return;
    screen.hidden = true;
    document.body.classList.remove('in-call');
    el('remoteVideo').srcObject = null;
    el('remoteAudio').srcObject = null;
    el('localVideo').srcObject = null;
}

function setPressed(button, pressed, label) {
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    button.classList.toggle('active', pressed);
    if (label) {
        button.setAttribute('aria-label', label);
        button.title = label;
    }
}

function updateControls(current) {
    const audioTrack = current.localStream && current.localStream.getAudioTracks()[0];
    const cameraTrack = current.cameraTrack;

    setPressed(el('callMuteBtn'), current.muted, current.muted ? 'Unmute microphone' : 'Mute microphone');
    el('callMuteBtn').disabled = !audioTrack;

    const cameraBtn = el('callCameraBtn');
    cameraBtn.hidden = !cameraTrack;
    setPressed(cameraBtn, current.cameraOff, current.cameraOff ? 'Turn camera on' : 'Turn camera off');
    cameraBtn.disabled = !!current.screenTrack;

    const screenBtn = el('callScreenBtn');
    screenBtn.hidden = !canShareScreen();
    screenBtn.disabled = !current.pc || current.phase !== 'active';
    setPressed(screenBtn, !!current.screenTrack, current.screenTrack ? 'Stop sharing screen' : 'Share screen');

    updateLocalPreview(current);
}

function updateLocalPreview(current) {
    const video = el('localVideo');
    const track = current.screenTrack || (current.cameraTrack && !current.cameraOff ? current.cameraTrack : null);
    if (track) {
        if (!video.srcObject || video.srcObject.getVideoTracks()[0] !== track) video.srcObject = new MediaStream([track]);
        video.hidden = false;
        video.classList.toggle('is-screen', !!current.screenTrack);
    } else {
        video.srcObject = null;
        video.hidden = true;
    }
    el('callScreen').classList.toggle('has-local-video', !!track);
}

function updateRemoteMedia(current) {
    const videoTrack = current.remoteStream.getVideoTracks().find(track => track.readyState === 'live' && !track.muted);
    const video = el('remoteVideo');
    if (videoTrack) {
        if (video.srcObject !== current.remoteStream) video.srcObject = current.remoteStream;
        video.hidden = false;
        video.play().catch(() => {});
    } else {
        video.hidden = true;
    }
    el('callScreen').classList.toggle('has-remote-video', !!videoTrack);

    const audio = el('remoteAudio');
    if (audio.srcObject !== current.remoteStream) {
        audio.srcObject = current.remoteStream;
        audio.play().catch(() => {});
    }
}

function startCallTimer(current) {
    clearInterval(current.clockTimer);
    const tick = () => {
        if (call !== current) return;
        setCallStatus(formatCallDuration((Date.now() - current.connectedAt) / 1000));
    };
    tick();
    current.clockTimer = setInterval(tick, 1000);
}

// ===== Call lifecycle =====

function newCall({ id = null, chatId, type, role, peer, phase }) {
    return {
        id,
        chatId: Number(chatId),
        type,
        role,
        peer: peer || {},
        phase, // starting | inviting | ringing | connecting | active
        pc: null,
        iceServers: FALLBACK_ICE_SERVERS,
        localStream: null,
        cameraTrack: null,
        screenTrack: null,
        remoteStream: new MediaStream(),
        pendingCandidates: [],
        tracksAttached: false,
        muted: false,
        cameraOff: false,
        connectedAt: null,
        iceRestarted: false,
        timers: {},
        clockTimer: null
    };
}

function clearCallTimers(current) {
    Object.values(current.timers).forEach(timer => clearTimeout(timer));
    current.timers = {};
    clearInterval(current.clockTimer);
}

/**
 * Tear down this tab's call (no signaling: callers send what the server must know first)
 */
function endCall({ message = null, type = 'info' } = {}) {
    const ending = call;
    if (!ending) return;
    call = null;

    stopTone();
    clearCallTimers(ending);
    if (ending.pc) {
        ending.pc.onicecandidate = null;
        ending.pc.ontrack = null;
        ending.pc.onconnectionstatechange = null;
        ending.pc.oniceconnectionstatechange = null;
        try { ending.pc.close(); } catch (e) { /* already closed */ }
    }
    stopStream(ending.localStream);
    if (ending.screenTrack) ending.screenTrack.stop();
    hideCallScreen();
    if (message) showNotification(message, type);
}

/**
 * The user ends the call (hang up button, or leaving the page)
 */
function hangUp(reason = 'hangup') {
    if (!call) return;
    if (call.id) emitCallEvent('call_hangup', { callId: call.id, reason });
    // Still inviting (no id yet): call_ringing will find no call here and cancel it
    endCall();
}

function attachLocalMedia(current, media) {
    current.localStream = media.stream;
    current.cameraTrack = media.stream.getVideoTracks()[0] || null;
    if (media.cameraMissing) showNotification('No camera available: the call continues with audio only.', 'info');
    updateControls(current);
}

/**
 * Start a call from this tab
 * @param {Object} peer - { id, username, fullName, avatarUrl } of the person being called
 */
async function startCall(chatId, type, peer) {
    if (call || incoming) {
        showNotification('You\'re already in a call.', 'info');
        return;
    }
    const supportError = mediaSupportError();
    if (supportError) {
        showNotification(supportError, 'error');
        return;
    }
    if (typeof socket === 'undefined' || !socket || !socket.connected) {
        showNotification('You\'re offline. Check your connection and try again.', 'error');
        return;
    }

    const current = newCall({ chatId, type, role: 'caller', peer, phase: 'starting' });
    call = current;
    showCallScreen(current);
    setCallStatus(type === 'video' ? 'Starting camera…' : 'Starting microphone…');

    let media;
    try {
        [media, current.iceServers] = await Promise.all([getCallMedia(type), fetchIceServers()]);
    } catch (error) {
        if (call === current) endCall({ message: mediaErrorMessage(error, type), type: 'error' });
        return;
    }
    if (call !== current) {
        stopStream(media.stream);
        return;
    }
    attachLocalMedia(current, media);

    current.phase = 'inviting';
    setCallStatus('Calling…');
    if (!emitCallEvent('call_invite', { chatId: current.chatId, type })) {
        endCall({ message: 'You\'re offline. Check your connection and try again.', type: 'error' });
        return;
    }
    // The server answers with call_ringing, call_busy or call_error
    current.timers.invite = setTimeout(() => {
        if (call === current && current.phase === 'inviting') endCall({ message: 'Couldn\'t reach the server. Try again.', type: 'error' });
    }, 10 * 1000);
}

function createPeerConnection(current) {
    const pc = new RTCPeerConnection({ iceServers: current.iceServers });
    current.pc = pc;

    pc.onicecandidate = (event) => {
        if (call !== current || !current.id || !event.candidate) return;
        emitCallEvent('call_ice_candidate', { callId: current.id, candidate: event.candidate.toJSON() });
    };

    pc.ontrack = (event) => {
        if (call !== current) return;
        const track = event.track;
        if (!current.remoteStream.getTracks().includes(track)) current.remoteStream.addTrack(track);
        track.onunmute = () => { if (call === current) updateRemoteMedia(current); };
        track.onmute = () => { if (call === current) updateRemoteMedia(current); };
        track.onended = () => { if (call === current) updateRemoteMedia(current); };
        updateRemoteMedia(current);
    };

    const onState = () => handleConnectionState(current);
    pc.onconnectionstatechange = onState;
    // Browsers without connectionState (older Safari) still report ICE state
    pc.oniceconnectionstatechange = () => { if (!('connectionState' in pc)) onState(); };
    return pc;
}

function connectionState(pc) {
    if (pc.connectionState) return pc.connectionState;
    const ice = pc.iceConnectionState;
    return ice === 'completed' ? 'connected' : ice;
}

function handleConnectionState(current) {
    if (call !== current || !current.pc) return;
    const state = connectionState(current.pc);

    if (state === 'connected') {
        clearTimeout(current.timers.disconnected);
        clearTimeout(current.timers.reconnect);
        current.iceRestarted = false; // a later drop gets its own restart
        if (current.phase !== 'active') {
            current.phase = 'active';
            if (!current.connectedAt) current.connectedAt = Date.now();
            updateControls(current);
        }
        startCallTimer(current);
        return;
    }

    if (state === 'disconnected') {
        clearInterval(current.clockTimer);
        setCallStatus('Reconnecting…');
        clearTimeout(current.timers.disconnected);
        current.timers.disconnected = setTimeout(() => {
            if (call === current && connectionState(current.pc) !== 'connected') tryIceRestart(current);
        }, DISCONNECTED_GRACE_MS);
        return;
    }

    if (state === 'failed') {
        clearInterval(current.clockTimer);
        tryIceRestart(current);
    }
}

/**
 * One ICE restart per drop (the caller sends the new offer; the callee waits for it), then give up
 */
function tryIceRestart(current) {
    if (call !== current) return;
    if (current.iceRestarted) {
        if (connectionState(current.pc) === 'failed') giveUp(current);
        return;
    }
    current.iceRestarted = true;
    setCallStatus('Reconnecting…');
    clearTimeout(current.timers.reconnect);
    current.timers.reconnect = setTimeout(() => giveUp(current), CONFIG.CALL_RECONNECT_TIMEOUT_MS);

    if (current.role === 'caller') {
        restartIce(current).catch((error) => {
            console.error('ICE restart error:', error);
            giveUp(current);
        });
    }
}

async function restartIce(current) {
    const iceServers = await fetchIceServers();
    if (call !== current) return;
    current.iceServers = iceServers;
    try {
        current.pc.setConfiguration({ ...current.pc.getConfiguration(), iceServers });
    } catch (e) {
        // Some browsers refuse a changed configuration mid-call; the restart still uses the old servers
    }
    const offer = await current.pc.createOffer({ iceRestart: true });
    if (call !== current) return;
    await current.pc.setLocalDescription(offer);
    emitCallEvent('call_offer', { callId: current.id, sdp: { type: 'offer', sdp: current.pc.localDescription.sdp }, iceRestart: true });
}

function giveUp(current) {
    if (call !== current || (current.pc && connectionState(current.pc) === 'connected')) return;
    emitCallEvent('call_hangup', { callId: current.id, reason: 'connection_failed' });
    endCall({ message: 'Call ended: the connection was lost.', type: 'error' });
}

/**
 * Callee: put the microphone/camera on the transceivers the caller's offer created (a video
 * transceiver with no camera stays sendrecv, so screen sharing can use it later without renegotiating)
 */
function attachTracksToTransceivers(current) {
    const pc = current.pc;
    const used = new Set();
    const tracks = { audio: current.localStream.getAudioTracks()[0] || null, video: current.cameraTrack };
    for (const kind of ['audio', 'video']) {
        const transceiver = pc.getTransceivers().find(t => !used.has(t) && t.receiver && t.receiver.track && t.receiver.track.kind === kind && !t.sender.track);
        const track = tracks[kind];
        if (transceiver) {
            used.add(transceiver);
            transceiver.direction = 'sendrecv';
            if (track) transceiver.sender.replaceTrack(track);
        } else if (track) {
            pc.addTrack(track, current.localStream);
        }
    }
    current.tracksAttached = true;
}

async function flushCandidates(current) {
    const pending = current.pendingCandidates;
    current.pendingCandidates = [];
    for (const candidate of pending) {
        try {
            await current.pc.addIceCandidate(candidate);
        } catch (error) {
            console.warn('ICE candidate rejected:', error);
        }
    }
}

// ----- Caller side -----

function onRinging(data) {
    // A call this tab no longer wants (hung up while the invite was on its way)
    if (!call || call.role !== 'caller' || call.id || call.chatId !== Number(data.chatId)) {
        emitCallEvent('call_cancel', { callId: data.callId });
        return;
    }
    const current = call;
    clearTimeout(current.timers.invite);
    current.id = Number(data.callId);
    current.phase = 'ringing';
    setCallStatus('Ringing…');
    startTone('ringback');
    // The server times the call out; this only guards against a lost event
    current.timers.ring = setTimeout(() => {
        if (call === current && current.phase === 'ringing') {
            hangUp();
            showNotification('No answer.', 'info');
        }
    }, (Number(data.ringTimeoutMs) || CONFIG.CALL_RING_TIMEOUT_MS) + 5000);
}

async function onAccepted(data) {
    const current = call;
    if (!current || current.role !== 'caller' || current.id !== Number(data.callId)) return;
    stopTone();
    clearTimeout(current.timers.ring);
    current.phase = 'connecting';
    setCallStatus('Connecting…');
    current.timers.connect = setTimeout(() => {
        if (call === current && !current.connectedAt) giveUp(current);
    }, CONFIG.CALL_MEDIA_TIMEOUT_MS + CONFIG.CALL_RECONNECT_TIMEOUT_MS);

    try {
        const pc = createPeerConnection(current);
        current.localStream.getAudioTracks().forEach(track => pc.addTrack(track, current.localStream));
        if (current.cameraTrack) {
            pc.addTrack(current.cameraTrack, current.localStream);
        } else {
            // No camera (voice call): a video slot anyway, for screen sharing
            pc.addTransceiver('video', { direction: 'sendrecv' });
        }
        const offer = await pc.createOffer();
        if (call !== current) return;
        await pc.setLocalDescription(offer);
        emitCallEvent('call_offer', { callId: current.id, sdp: { type: 'offer', sdp: pc.localDescription.sdp } });
    } catch (error) {
        console.error('Call offer error:', error);
        if (call === current) {
            emitCallEvent('call_hangup', { callId: current.id, reason: 'media_error' });
            endCall({ message: 'Couldn\'t start the call.', type: 'error' });
        }
    }
}

async function onAnswer(data) {
    const current = call;
    if (!current || current.id !== Number(data.callId) || !current.pc) return;
    try {
        if (current.pc.signalingState !== 'have-local-offer') return;
        await current.pc.setRemoteDescription(data.sdp);
        await flushCandidates(current);
    } catch (error) {
        console.error('Call answer error:', error);
    }
}

// ----- Callee side -----

function onInvite(data) {
    const callId = Number(data.callId);
    if (incoming && incoming.callId === callId) return; // shown again after a reconnect
    if (call || incoming) return; // the server only rings a user who isn't in a call; another tab may be

    incoming = {
        callId,
        chatId: Number(data.chatId),
        type: data.type === 'video' ? 'video' : 'voice',
        caller: data.caller || {},
        silent: !!data.silent || dndActiveHere(),
        timer: null
    };
    const expiresIn = Date.parse(data.expiresAt) - Date.now();
    incoming.timer = setTimeout(() => dismissIncoming(), (Number.isFinite(expiresIn) ? Math.max(expiresIn, 0) : CONFIG.CALL_RING_TIMEOUT_MS) + 3000);

    const modal = el('incomingCallModal');
    el('incomingCallName').textContent = personName(incoming.caller);
    el('incomingCallType').textContent = incoming.type === 'video' ? 'Incoming video call' : 'Incoming voice call';
    fillCallAvatar(el('incomingCallAvatar'), incoming.caller);
    const note = el('incomingCallNote');
    note.hidden = !incoming.silent;
    note.textContent = incoming.silent ? 'Do not disturb is on: ringing silently' : '';
    el('acceptCallBtn').disabled = false;
    el('declineCallBtn').disabled = false;
    modal.hidden = false;
    el('acceptCallBtn').focus();

    if (!incoming.silent) startTone('ring');
}

function dismissIncoming(message = null) {
    if (!incoming) return;
    clearTimeout(incoming.timer);
    incoming = null;
    stopTone();
    el('incomingCallModal').hidden = true;
    if (message) showNotification(message, 'info');
}

function declineIncoming() {
    if (!incoming) return;
    emitCallEvent('call_reject', { callId: incoming.callId });
    dismissIncoming();
}

async function acceptIncoming() {
    const invite = incoming;
    if (!invite || call) return;
    stopTone();
    el('acceptCallBtn').disabled = true;
    const note = el('incomingCallNote');
    note.hidden = false;
    note.textContent = invite.type === 'video' ? 'Starting camera…' : 'Starting microphone…';

    let media;
    let iceServers;
    try {
        [media, iceServers] = await Promise.all([getCallMedia(invite.type), fetchIceServers()]);
    } catch (error) {
        if (incoming === invite) {
            emitCallEvent('call_reject', { callId: invite.callId });
            dismissIncoming();
        }
        showNotification(mediaErrorMessage(error, invite.type), 'error');
        return;
    }
    // Cancelled, timed out or answered elsewhere while the camera started
    if (incoming !== invite) {
        stopStream(media.stream);
        return;
    }
    clearTimeout(invite.timer);
    incoming = null;
    el('incomingCallModal').hidden = true;

    const current = newCall({
        id: invite.callId,
        chatId: invite.chatId,
        type: invite.type,
        role: 'callee',
        peer: invite.caller,
        phase: 'connecting'
    });
    current.iceServers = iceServers;
    call = current;
    showCallScreen(current);
    attachLocalMedia(current, media);
    setCallStatus('Connecting…');
    createPeerConnection(current);

    if (!emitCallEvent('call_accept', { callId: current.id })) {
        endCall({ message: 'You\'re offline. Check your connection and try again.', type: 'error' });
        return;
    }
    current.timers.connect = setTimeout(() => {
        if (call === current && !current.connectedAt) giveUp(current);
    }, CONFIG.CALL_MEDIA_TIMEOUT_MS + CONFIG.CALL_RECONNECT_TIMEOUT_MS);
}

async function onOffer(data) {
    const current = call;
    if (!current || current.id !== Number(data.callId) || !current.pc) return;
    try {
        await current.pc.setRemoteDescription(data.sdp);
        if (!current.tracksAttached) attachTracksToTransceivers(current);
        await flushCandidates(current);
        const answer = await current.pc.createAnswer();
        if (call !== current) return;
        await current.pc.setLocalDescription(answer);
        emitCallEvent('call_answer', { callId: current.id, sdp: { type: 'answer', sdp: current.pc.localDescription.sdp } });
    } catch (error) {
        console.error('Call offer handling error:', error);
        if (call === current && !current.connectedAt) {
            emitCallEvent('call_hangup', { callId: current.id, reason: 'media_error' });
            endCall({ message: 'Couldn\'t connect the call.', type: 'error' });
        }
    }
}

async function onRemoteCandidate(data) {
    const current = call;
    if (!current || current.id !== Number(data.callId) || !data.candidate) return;
    if (!current.pc || !current.pc.remoteDescription) {
        current.pendingCandidates.push(data.candidate);
        return;
    }
    try {
        await current.pc.addIceCandidate(data.candidate);
    } catch (error) {
        console.warn('ICE candidate rejected:', error);
    }
}

// ===== Controls =====

function toggleMute() {
    if (!call || !call.localStream) return;
    call.muted = !call.muted;
    call.localStream.getAudioTracks().forEach(track => { track.enabled = !call.muted; });
    updateControls(call);
}

function toggleCamera() {
    if (!call || !call.cameraTrack || call.screenTrack) return;
    call.cameraOff = !call.cameraOff;
    call.cameraTrack.enabled = !call.cameraOff;
    updateControls(call);
}

function videoSender(pc) {
    const transceiver = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video' && t.direction !== 'stopped' && t.direction !== 'inactive');
    return transceiver ? transceiver.sender : null;
}

async function toggleScreenShare() {
    const current = call;
    if (!current || !current.pc) return;
    if (current.screenTrack) {
        await stopScreenShare(current);
        return;
    }
    const sender = videoSender(current.pc);
    if (!sender) {
        showNotification('Screen sharing isn\'t available in this call.', 'error');
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
        if (error && error.name !== 'NotAllowedError') showNotification('Couldn\'t share your screen.', 'error');
        return;
    }
    const track = stream.getVideoTracks()[0];
    if (call !== current || !track) {
        stopStream(stream);
        return;
    }
    try {
        await sender.replaceTrack(track);
    } catch (error) {
        stopStream(stream);
        showNotification('Couldn\'t share your screen.', 'error');
        return;
    }
    current.screenTrack = track;
    // The browser's own "Stop sharing" button
    track.onended = () => { if (call === current && current.screenTrack === track) stopScreenShare(current); };
    updateControls(current);
}

async function stopScreenShare(current) {
    const track = current.screenTrack;
    if (!track) return;
    current.screenTrack = null;
    const sender = current.pc && videoSender(current.pc);
    try {
        if (sender) await sender.replaceTrack(current.cameraTrack || null);
    } catch (error) {
        console.warn('Restoring camera failed:', error);
    }
    track.stop();
    if (call === current) updateControls(current);
}

// ===== Server events =====

function onSocketConnect() {
    if (call && call.id && (call.phase === 'connecting' || call.phase === 'active')) {
        // This tab's socket changed: tell the server so signaling reaches it again
        emitCallEvent('call_sync', { callId: call.id });
    } else if (call && (call.phase === 'ringing' || call.phase === 'inviting')) {
        // The server cancels a ringing call whose caller disconnected
        endCall({ message: 'Call ended: the connection was lost.', type: 'error' });
    } else if (!call) {
        // A call ringing for this user (e.g. this page was opened from the call notification)
        emitCallEvent('call_sync', {});
    }
}

function handleCallEvent(event, data) {
    const callId = Number(data.callId);
    const isCurrent = !!call && call.id === callId;
    const isIncoming = !!incoming && incoming.callId === callId;

    switch (event) {
        case 'connect':
            onSocketConnect();
            break;
        case 'call_invite':
            onInvite(data);
            break;
        case 'call_ringing':
            onRinging(data);
            break;
        case 'call_accept':
            onAccepted(data);
            break;
        case 'call_offer':
            onOffer(data);
            break;
        case 'call_answer':
            onAnswer(data);
            break;
        case 'call_ice_candidate':
            onRemoteCandidate(data);
            break;
        case 'call_busy':
            if (call && call.role === 'caller' && !call.id && call.chatId === Number(data.chatId)) {
                endCall({ message: `${personName(call.peer)} is on another call.` });
            }
            break;
        case 'call_reject':
            if (isCurrent) endCall({ message: `${personName(call.peer)} declined the call.` });
            break;
        case 'call_cancel':
            if (isIncoming) {
                const caller = personName(incoming.caller);
                dismissIncoming(data.reason === 'cancelled' ? `Missed call from ${caller}` : null);
            } else if (isCurrent) {
                endCall();
            }
            break;
        case 'call_timeout':
            if (isIncoming) dismissIncoming(`Missed call from ${personName(incoming.caller)}`);
            else if (isCurrent) endCall({ message: 'No answer.' });
            break;
        case 'call_hangup':
            if (isCurrent) {
                endCall({ message: data.reason === 'connection_lost' || data.reason === 'connection_failed' ? 'Call ended: the connection was lost.' : 'Call ended.' });
            }
            break;
        case 'call_peer_reconnected':
            if (isCurrent && call.pc && connectionState(call.pc) !== 'connected') tryIceRestart(call);
            break;
        case 'call_sync':
            if (isCurrent && !data.active) {
                endCall({ message: data.otherDevice ? 'This call continues on another device.' : 'The call ended while you were offline.' });
            } else if (isCurrent && call.pc && connectionState(call.pc) !== 'connected') {
                tryIceRestart(call);
            }
            break;
        case 'call_error':
            handleCallError(data);
            break;
        case 'call_log_updated':
            if (el('callsModal') && el('callsModal').style.display !== 'none') loadCalls(true);
            break;
        default:
            break;
    }
}

function handleCallError(data) {
    const message = data.message || 'Something went wrong with the call';
    if (data.event === 'call_invite') {
        if (call && call.role === 'caller' && !call.id) endCall({ message, type: 'error' });
        else showNotification(message, 'error');
        return;
    }
    if (data.event === 'call_accept') {
        if (call && call.id === Number(data.callId)) endCall({ message, type: 'error' });
        return;
    }
    // Signaling for a call the server no longer has
    if (call && call.id === Number(data.callId) && data.code === 'NOT_FOUND') {
        endCall({ message: 'Call ended.' });
    } else {
        console.warn('Call error:', data);
    }
}

// ===== Header buttons =====

/**
 * Called with GET /chats/:id for the open chat: call buttons for direct chats only
 */
function applyCallDetails(chat) {
    headerTarget = null;
    if (chat && chat.chat_type === 'direct' && Array.isArray(chat.participants)) {
        const me = Number(getCurrentUser().userId);
        const other = chat.participants.find(p => Number(p.id) !== me);
        if (other) {
            headerTarget = {
                chatId: Number(chat.id),
                peer: { id: Number(other.id), username: other.username, fullName: other.full_name || null, avatarUrl: other.avatar_url || null }
            };
        }
    }
    el('voiceCallBtn').hidden = !headerTarget;
    el('videoCallBtn').hidden = !headerTarget;
}

function resetCallHeader() {
    applyCallDetails(null);
}

function callFromHeader(type) {
    if (!headerTarget || headerTarget.chatId !== currentChatId) return;
    startCall(headerTarget.chatId, type, headerTarget.peer);
}

// ===== Calls panel =====

function callRowStatus(entry) {
    const outgoing = entry.direction === 'outgoing';
    switch (entry.status) {
        // Duration first: it's what's left when a narrow screen cuts the line
        case 'completed':
            return `${formatCallDuration(entry.durationSeconds)}, ${outgoing ? 'outgoing' : 'incoming'}`;
        case 'failed':
            return entry.durationSeconds > 0 ? `${formatCallDuration(entry.durationSeconds)}, ${outgoing ? 'outgoing' : 'incoming'}` : 'Failed';
        case 'declined':
            return outgoing ? 'Declined' : 'You declined';
        case 'missed':
            return outgoing ? 'No answer' : 'Missed';
        case 'cancelled':
            return outgoing ? 'Cancelled' : 'Missed';
        case 'busy':
            return outgoing ? 'Busy' : 'Missed';
        default:
            return 'In progress';
    }
}

function isMissedEntry(entry) {
    return entry.direction === 'incoming' && ['missed', 'cancelled', 'busy'].includes(entry.status);
}

function renderCallRow(entry) {
    const h = FriChat.h;
    const name = personName(entry.otherUser);
    const avatar = h('div', { className: 'chat-avatar call-row-avatar' });
    fillCallAvatar(avatar, entry.otherUser);

    const when = entry.startedAt ? new Date(entry.startedAt) : null;
    const whenText = when && !isNaN(when)
        ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
    const typeIcon = h('span', { className: 'call-row-type', attrs: { 'aria-hidden': 'true' } });
    typeIcon.innerHTML = svgIcon(entry.type === 'video' ? 'video' : 'phone', 14); // fixed markup, no user text

    const open = h('button', {
        className: 'call-row-open',
        attrs: { type: 'button', 'aria-label': `Open chat with ${name}` },
        on: { click: () => { closeCallsPanel(); openChat(entry.chatId); } }
    },
    avatar,
    h('span', { className: 'call-row-text' },
        h('span', { className: 'call-row-name', text: name }),
        h('span', { className: `call-row-status${isMissedEntry(entry) ? ' missed' : ''}` },
            typeIcon,
            h('span', { text: callRowStatus(entry) }))),
    h('span', { className: 'call-row-time', text: whenText }));

    const callBack = (type) => {
        const button = h('button', {
            className: 'icon-btn call-row-btn',
            attrs: { type: 'button', title: type === 'video' ? 'Video call' : 'Voice call', 'aria-label': `${type === 'video' ? 'Video' : 'Voice'} call ${name}` },
            on: { click: () => { closeCallsPanel(); startCall(entry.chatId, type, entry.otherUser); } }
        });
        button.innerHTML = svgIcon(type === 'video' ? 'video' : 'phone', 18); // fixed markup
        return button;
    };

    return h('div', { className: 'call-row', attrs: { 'data-call-id': entry.id } }, open, callBack('voice'), callBack('video'));
}

async function loadCalls(reset = false) {
    if (callsLoading) return;
    callsLoading = true;
    const list = el('callsList');
    const more = el('callsLoadMore');
    if (reset) {
        callsNextBefore = null;
        if (!list.children.length) list.replaceChildren(FriChat.h('p', { className: 'empty-state', text: 'Loading…' }));
    }
    try {
        const params = new URLSearchParams({ limit: String(CONFIG.CALLS_PAGE_SIZE) });
        if (!reset && callsNextBefore) params.set('before', String(callsNextBefore));
        const response = await apiRequest(`${CONFIG.ENDPOINTS.CALLS}?${params}`);
        if (!response || !response.success) throw new Error(response && response.message);
        const rows = response.data.map(renderCallRow);
        if (reset) list.replaceChildren(...rows);
        else list.append(...rows);
        if (!list.children.length) list.replaceChildren(FriChat.h('p', { className: 'empty-state', text: 'No calls yet. Start one from a chat\'s header.' }));
        callsNextBefore = response.pagination && response.pagination.nextBefore;
        more.hidden = !(response.pagination && response.pagination.hasMore);
    } catch (error) {
        console.error('Load calls error:', error);
        if (reset) list.replaceChildren(FriChat.h('p', { className: 'empty-state', text: 'Couldn\'t load your calls.' }));
    } finally {
        callsLoading = false;
    }
}

function openCallsPanel() {
    el('callsModal').style.display = 'flex';
    el('callsList').replaceChildren();
    loadCalls(true);
    el('closeCallsModal').focus();
}

function closeCallsPanel() {
    el('callsModal').style.display = 'none';
}

// ===== Setup =====

function initializeCalls() {
    el('voiceCallBtn').addEventListener('click', () => callFromHeader('voice'));
    el('videoCallBtn').addEventListener('click', () => callFromHeader('video'));
    el('acceptCallBtn').addEventListener('click', acceptIncoming);
    el('declineCallBtn').addEventListener('click', declineIncoming);
    el('callHangupBtn').addEventListener('click', () => hangUp());
    el('callMuteBtn').addEventListener('click', toggleMute);
    el('callCameraBtn').addEventListener('click', toggleCamera);
    el('callScreenBtn').addEventListener('click', toggleScreenShare);

    el('callsBtn').addEventListener('click', openCallsPanel);
    el('closeCallsModal').addEventListener('click', closeCallsPanel);
    el('callsLoadMore').addEventListener('click', () => loadCalls(false));
    const callsModal = el('callsModal');
    callsModal.addEventListener('click', (e) => { if (e.target === callsModal) closeCallsPanel(); });
    callsModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCallsPanel(); });

    onCallEvent(handleCallEvent);

    // Opened from a call notification (chat.html?chat=ID&call=ID): call_sync on connect brings the
    // ringing call back; the parameter itself isn't needed
    const params = new URLSearchParams(window.location.search);
    if (params.has('call')) {
        params.delete('call');
        const query = params.toString();
        history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    }
}

// Registered before chat.html's own beforeunload (which disconnects the socket), so the hang-up goes out first
window.addEventListener('beforeunload', () => {
    if (call && call.id) emitCallEvent('call_hangup', { callId: call.id, reason: 'hangup' });
});

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    isCallNotice,
    describeCallNotice,
    callNoticeIconHtml,
    isMissedCallNotice,
    formatCallDuration,
    applyCallDetails,
    resetCallHeader,
    startCall,
    initializeCalls
});
})(globalThis.FriChat = globalThis.FriChat || {});
