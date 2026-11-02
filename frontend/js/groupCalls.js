/**
 * Group Calls Module (phase 16)
 * Small group voice and video calls: mesh WebRTC (one peer connection per other person), with
 * Socket.IO for signaling (backend/utils/groupCalls.js). calls.js shares its media, ringtone and
 * avatar helpers through FriChat.callKit and hands group events to handleGroupCallEvent.
 *
 *   - The call screen: a grid of tiles (name, muted icon, speaking highlight from an audio level
 *     meter), mute, camera, screen sharing on desktop, leave, participant count and timer
 *   - The ring modal with Join and Dismiss, and the banner in a group chat while a call runs
 *   - The newcomer offers to everyone already in the room (the server says who in offerTo); the
 *     other side waits for the offer, so two people never offer to each other at once
 *   - A connection that drops gets one ICE restart per pair, by the side that offered. A pair that
 *     stays lost shows it on the tile; the call goes on for everyone else.
 *
 * Every name shown comes from the server and is set with textContent (never innerHTML).
 */

(function (FriChat) {

const SVG_MIC_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line></svg>';

// Wait this long in "disconnected" before restarting ICE (it often recovers by itself)
const DISCONNECTED_GRACE_MS = 2500;

// Waiting for the server to answer call_invite or call_join
const SERVER_TIMEOUT_MS = 10 * 1000;

// The note on the first group call stays this long
const NOTE_MS = 8000;

// Speaking highlight: RMS level above this, kept for a few ticks so it doesn't flicker between words
const SPEAKING_LEVEL = 0.03;
const METER_INTERVAL_MS = 150;
const SPEAKING_HOLD_TICKS = 4;

// The banner refetches at most this often while people come and go (GET /calls/active is rate limited)
const BANNER_REFRESH_MS = 1500;

const FIRST_CALL_NOTE = 'Group calls work best with up to 4 people.';

// The call in progress (this tab), a call ringing here, and the open chat's running call
let room = null;
let ring = null;
let banner = { chatId: null, chatName: '', call: null, timer: null, lastFetch: 0 };

function kit() {
    return FriChat.callKit;
}

function el(id) {
    return document.getElementById(id);
}

function myId() {
    return Number(getCurrentUser().userId);
}

// ===== Room state =====

function newRoom({ id = null, chatId, chatName, type, phase }) {
    return {
        id,
        chatId: Number(chatId),
        chatName: chatName || 'Group call',
        type,
        phase, // starting | joining | active
        iceServers: [],
        localStream: null,
        cameraTrack: null,
        screenTrack: null,
        muted: false,
        cameraOff: false,
        participants: [],
        max: 0,
        peers: new Map(), // userId -> peer
        tiles: new Map(), // userId -> tile elements
        meters: new Map(), // userId -> audio level meter
        meterTimer: null,
        connectedAt: null,
        clockTimer: null,
        noteShown: false,
        stateSent: false,
        timers: {}
    };
}

function isBusy() {
    return !!room;
}

function participantOf(current, userId) {
    return current.participants.find(person => Number(person.id) === userId) || null;
}

function localVideoTrack(current) {
    return current.screenTrack || current.cameraTrack || null;
}

// ===== Tiles =====

function createTile(userId) {
    const h = FriChat.h;
    const video = h('video', { className: 'group-call-video', attrs: { autoplay: '', playsinline: '' } });
    video.muted = true; // the sound plays through the tile's audio element, also when there is no video
    const avatar = h('div', { className: 'call-avatar group-call-avatar' });
    const mutedIcon = h('span', { className: 'group-call-muted', attrs: { title: 'Muted', 'aria-label': 'Muted' } });
    mutedIcon.innerHTML = SVG_MIC_OFF; // fixed markup, no user text
    const name = h('span', { className: 'group-call-name' });
    const status = h('span', { className: 'group-call-tile-status' });
    const audio = h('audio', { attrs: { autoplay: '' } });
    const root = h('div', { className: 'group-call-tile', attrs: { 'data-user-id': String(userId) } },
        video, avatar, status, h('div', { className: 'group-call-label' }, mutedIcon, name), audio);
    return { root, video, avatar, mutedIcon, name, status, audio };
}

function drawTile(current, userId) {
    const tile = current.tiles.get(userId);
    const person = participantOf(current, userId);
    if (!tile || !person) return;

    const isMe = userId === myId();
    const peer = current.peers.get(userId);
    tile.name.textContent = isMe ? 'You' : kit().personName(person);
    tile.mutedIcon.hidden = !(isMe ? current.muted : person.muted);
    kit().fillCallAvatar(tile.avatar, person);

    let track = null;
    if (isMe) {
        track = current.screenTrack || (current.cameraTrack && !current.cameraOff ? current.cameraTrack : null);
        if (track && (!tile.video.srcObject || tile.video.srcObject.getVideoTracks()[0] !== track)) {
            tile.video.srcObject = new MediaStream([track]);
        }
    } else if (peer) {
        track = peer.stream.getVideoTracks().find(t => t.readyState === 'live' && !t.muted) || null;
        if (person.cameraOff) track = null;
        if (track && tile.video.srcObject !== peer.stream) tile.video.srcObject = peer.stream;
        if (tile.audio.srcObject !== peer.stream) {
            tile.audio.srcObject = peer.stream;
            tile.audio.play().catch(() => {});
        }
    }
    if (track) tile.video.play().catch(() => {});
    else if (tile.video.srcObject) tile.video.srcObject = null;

    tile.root.classList.toggle('has-video', !!track);
    tile.root.classList.toggle('is-self', isMe && !current.screenTrack);
    tile.root.classList.toggle('is-screen', isMe ? !!current.screenTrack : !!person.screen);
    tile.status.textContent = isMe ? '' : (peer ? peer.status : 'Connecting…');
}

function drawRoom(current) {
    if (room !== current) return;
    const grid = el('groupCallGrid');
    const ids = current.participants.map(person => Number(person.id));

    for (const [userId, tile] of current.tiles) {
        if (!ids.includes(userId)) {
            tile.audio.srcObject = null;
            tile.video.srcObject = null;
            tile.root.remove();
            current.tiles.delete(userId);
        }
    }
    for (const userId of ids) {
        if (!current.tiles.has(userId)) {
            const tile = createTile(userId);
            current.tiles.set(userId, tile);
            grid.append(tile.root);
        }
        drawTile(current, userId);
    }
    grid.dataset.count = String(ids.length);
    el('groupCallCount').textContent = current.max ? `${ids.length} of ${current.max}` : '';
    updateControls(current);
}

function setStatus(text) {
    el('groupCallStatus').textContent = text;
}

function startClock(current) {
    clearInterval(current.clockTimer);
    const tick = () => {
        if (room === current) setStatus(kit().formatCallDuration((Date.now() - current.connectedAt) / 1000));
    };
    tick();
    current.clockTimer = setInterval(tick, 1000);
}

function updateControls(current) {
    const { setPressed, canShareScreen } = kit();
    const audioTrack = current.localStream && current.localStream.getAudioTracks()[0];
    const muteBtn = el('groupCallMuteBtn');
    setPressed(muteBtn, current.muted, current.muted ? 'Unmute microphone' : 'Mute microphone');
    muteBtn.disabled = !audioTrack;

    const cameraBtn = el('groupCallCameraBtn');
    cameraBtn.hidden = !current.cameraTrack;
    setPressed(cameraBtn, current.cameraOff, current.cameraOff ? 'Turn camera on' : 'Turn camera off');
    cameraBtn.disabled = !!current.screenTrack;

    const screenBtn = el('groupCallScreenBtn');
    screenBtn.hidden = !canShareScreen();
    screenBtn.disabled = current.phase !== 'active';
    setPressed(screenBtn, !!current.screenTrack, current.screenTrack ? 'Stop sharing screen' : 'Share screen');
}

function showScreen(current) {
    const screen = el('groupCallScreen');
    el('groupCallTitle').textContent = current.chatName;
    el('groupCallCount').textContent = '';
    el('groupCallGrid').replaceChildren();
    el('groupCallGrid').dataset.count = '0';
    el('groupCallNote').hidden = true;
    screen.hidden = false;
    document.body.classList.add('in-call');
    updateControls(current);
    el('groupCallLeaveBtn').focus();
}

function hideScreen() {
    el('groupCallScreen').hidden = true;
    document.body.classList.remove('in-call');
    el('groupCallGrid').replaceChildren();
}

/**
 * "Group calls work best with up to 4 people." once per browser, on the first group call
 */
function showFirstCallNote(current) {
    if (current.noteShown) return;
    current.noteShown = true;
    const key = CONFIG.STORAGE_KEYS.GROUP_CALL_NOTE_SEEN;
    try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
    } catch (error) {
        return; // no storage: better no note than one on every call
    }
    const note = el('groupCallNote');
    note.textContent = FIRST_CALL_NOTE;
    note.hidden = false;
    current.timers.note = setTimeout(() => { note.hidden = true; }, NOTE_MS);
}

// ===== Speaking highlight =====

function addMeter(current, userId, stream) {
    if (current.meters.has(userId) || stream.getAudioTracks().length === 0) return;
    try {
        const ctx = kit().audioContext();
        if (!ctx) return;
        const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser); // not on to the speakers: the tile's audio element plays it
        current.meters.set(userId, { source, analyser, samples: new Uint8Array(analyser.fftSize), hold: 0 });
    } catch (error) {
        console.warn('Audio meter error:', error);
    }
    if (!current.meterTimer) current.meterTimer = setInterval(() => readMeters(current), METER_INTERVAL_MS);
}

function removeMeter(current, userId) {
    const meter = current.meters.get(userId);
    if (!meter) return;
    current.meters.delete(userId);
    try { meter.source.disconnect(); } catch (e) { /* already gone */ }
}

function audioLevel(samples) {
    let sum = 0;
    for (const sample of samples) {
        const value = (sample - 128) / 128;
        sum += value * value;
    }
    return Math.sqrt(sum / samples.length);
}

function readMeters(current) {
    if (room !== current) return;
    for (const [userId, meter] of current.meters) {
        meter.analyser.getByteTimeDomainData(meter.samples);
        const silent = userId === myId() ? current.muted : !!(participantOf(current, userId) || {}).muted;
        if (!silent && audioLevel(meter.samples) >= SPEAKING_LEVEL) meter.hold = SPEAKING_HOLD_TICKS;
        else if (meter.hold > 0) meter.hold -= 1;
        const tile = current.tiles.get(userId);
        if (tile) tile.root.classList.toggle('speaking', meter.hold > 0);
    }
}

// ===== Peers =====

function createPeer(current, userId, role) {
    const pc = new RTCPeerConnection({ iceServers: current.iceServers });
    const peer = {
        userId,
        role, // 'offerer' (the newcomer of this pair) or 'answerer'
        pc,
        stream: new MediaStream(),
        pendingCandidates: [],
        tracksAttached: false,
        iceRestarted: false,
        status: 'Connecting…',
        connected: false,
        timers: {}
    };
    current.peers.set(userId, peer);

    pc.onicecandidate = (event) => {
        if (room !== current || !event.candidate) return;
        emitCallEvent('call_ice_candidate', { callId: current.id, to: userId, candidate: event.candidate.toJSON() });
    };

    pc.ontrack = (event) => {
        if (room !== current) return;
        const track = event.track;
        if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
        const redraw = () => { if (room === current) drawTile(current, userId); };
        track.onunmute = redraw;
        track.onmute = redraw;
        track.onended = redraw;
        if (track.kind === 'audio') addMeter(current, userId, peer.stream);
        redraw();
    };

    const onState = () => handlePeerState(current, peer);
    pc.onconnectionstatechange = onState;
    // Browsers without connectionState (older Safari) still report ICE state
    pc.oniceconnectionstatechange = () => { if (!('connectionState' in pc)) onState(); };

    peer.timers.connect = setTimeout(() => {
        if (room === current && !peer.connected) setPeerStatus(current, peer, 'Couldn\'t connect');
    }, CONFIG.CALL_MEDIA_TIMEOUT_MS + CONFIG.CALL_RECONNECT_TIMEOUT_MS);
    return peer;
}

function closePeer(current, userId) {
    const peer = current.peers.get(userId);
    if (!peer) return;
    current.peers.delete(userId);
    Object.values(peer.timers).forEach(timer => clearTimeout(timer));
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = null;
    try { peer.pc.close(); } catch (e) { /* already closed */ }
    removeMeter(current, userId);
}

function setPeerStatus(current, peer, text) {
    peer.status = text;
    drawTile(current, peer.userId);
}

function handlePeerState(current, peer) {
    if (room !== current || current.peers.get(peer.userId) !== peer) return;
    const state = kit().connectionState(peer.pc);

    if (state === 'connected') {
        clearTimeout(peer.timers.connect);
        clearTimeout(peer.timers.disconnected);
        clearTimeout(peer.timers.reconnect);
        peer.connected = true;
        peer.iceRestarted = false; // a later drop gets its own restart
        setPeerStatus(current, peer, '');
        return;
    }
    if (state === 'disconnected') {
        setPeerStatus(current, peer, 'Reconnecting…');
        clearTimeout(peer.timers.disconnected);
        peer.timers.disconnected = setTimeout(() => {
            if (room === current && kit().connectionState(peer.pc) !== 'connected') tryIceRestart(current, peer);
        }, DISCONNECTED_GRACE_MS);
        return;
    }
    if (state === 'failed') tryIceRestart(current, peer);
}

/**
 * One ICE restart per drop, by the side that made the first offer (the other side waits for it).
 * If that doesn't help the tile says so and the rest of the call carries on.
 */
function tryIceRestart(current, peer) {
    if (room !== current || current.peers.get(peer.userId) !== peer) return;
    if (peer.iceRestarted) {
        if (kit().connectionState(peer.pc) === 'failed') giveUpOnPeer(current, peer);
        return;
    }
    peer.iceRestarted = true;
    setPeerStatus(current, peer, 'Reconnecting…');
    clearTimeout(peer.timers.reconnect);
    peer.timers.reconnect = setTimeout(() => giveUpOnPeer(current, peer), CONFIG.CALL_RECONNECT_TIMEOUT_MS);

    if (peer.role === 'offerer') {
        restartIce(current, peer).catch((error) => {
            console.error('ICE restart error:', error);
            giveUpOnPeer(current, peer);
        });
    }
}

async function restartIce(current, peer) {
    const iceServers = await kit().fetchIceServers();
    if (room !== current || current.peers.get(peer.userId) !== peer) return;
    current.iceServers = iceServers;
    try {
        peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers });
    } catch (e) {
        // Some browsers refuse a changed configuration mid-call; the restart still uses the old servers
    }
    const offer = await peer.pc.createOffer({ iceRestart: true });
    if (room !== current) return;
    await peer.pc.setLocalDescription(offer);
    emitCallEvent('call_offer', { callId: current.id, to: peer.userId, sdp: { type: 'offer', sdp: peer.pc.localDescription.sdp }, iceRestart: true });
}

function giveUpOnPeer(current, peer) {
    if (room !== current || current.peers.get(peer.userId) !== peer) return;
    if (kit().connectionState(peer.pc) === 'connected') return;
    setPeerStatus(current, peer, 'Connection lost');
}

/**
 * Someone came back, or this tab did: give that pair another try
 */
function retryPeer(current, peer) {
    if (!peer || kit().connectionState(peer.pc) === 'connected') return;
    peer.iceRestarted = false;
    tryIceRestart(current, peer);
}

/**
 * The newcomer of a pair offers. Every connection carries a video slot, also in a voice call or
 * without a camera, so screen sharing can use it later without renegotiating.
 */
async function offerToPeer(current, userId) {
    const peer = createPeer(current, userId, 'offerer');
    const { pc } = peer;
    try {
        current.localStream.getAudioTracks().forEach(track => pc.addTrack(track, current.localStream));
        const video = localVideoTrack(current);
        if (video) pc.addTrack(video, current.localStream);
        else pc.addTransceiver('video', { direction: 'sendrecv' });
        peer.tracksAttached = true;
        const offer = await pc.createOffer();
        if (room !== current) return;
        await pc.setLocalDescription(offer);
        emitCallEvent('call_offer', { callId: current.id, to: userId, sdp: { type: 'offer', sdp: pc.localDescription.sdp } });
    } catch (error) {
        console.error('Group call offer error:', error);
        if (room === current) setPeerStatus(current, peer, 'Couldn\'t connect');
    }
}

/**
 * Answering side: put the microphone/camera on the transceivers the offer created
 */
function attachTracksToTransceivers(current, peer) {
    const { pc } = peer;
    const used = new Set();
    const tracks = { audio: current.localStream.getAudioTracks()[0] || null, video: localVideoTrack(current) };
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
    peer.tracksAttached = true;
}

async function flushCandidates(peer) {
    const pending = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of pending) {
        try {
            await peer.pc.addIceCandidate(candidate);
        } catch (error) {
            console.warn('ICE candidate rejected:', error);
        }
    }
}

async function onOffer(data) {
    const current = room;
    const from = Number(data.from);
    if (!current || current.id !== Number(data.callId) || !current.localStream) return;
    const peer = current.peers.get(from) || createPeer(current, from, 'answerer');
    try {
        await peer.pc.setRemoteDescription(data.sdp);
        if (!peer.tracksAttached) attachTracksToTransceivers(current, peer);
        await flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        if (room !== current) return;
        await peer.pc.setLocalDescription(answer);
        emitCallEvent('call_answer', { callId: current.id, to: from, sdp: { type: 'answer', sdp: peer.pc.localDescription.sdp } });
        drawTile(current, from);
    } catch (error) {
        console.error('Group call offer handling error:', error);
        if (room === current) setPeerStatus(current, peer, 'Couldn\'t connect');
    }
}

async function onAnswer(data) {
    const current = room;
    if (!current || current.id !== Number(data.callId)) return;
    const peer = current.peers.get(Number(data.from));
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
    try {
        await peer.pc.setRemoteDescription(data.sdp);
        await flushCandidates(peer);
    } catch (error) {
        console.error('Group call answer error:', error);
    }
}

async function onRemoteCandidate(data) {
    const current = room;
    if (!current || current.id !== Number(data.callId) || !data.candidate) return;
    const from = Number(data.from);
    const peer = current.peers.get(from);
    if (!peer || !peer.pc.remoteDescription) {
        // Before the offer: keep it on a peer waiting for that offer
        (peer || createPeer(current, from, 'answerer')).pendingCandidates.push(data.candidate);
        return;
    }
    try {
        await peer.pc.addIceCandidate(data.candidate);
    } catch (error) {
        console.warn('ICE candidate rejected:', error);
    }
}

// ===== Starting, joining, leaving =====

/**
 * Why a call can't start from this tab right now (shown to the user), or null
 */
function cannotStart() {
    if (room || kit().isInOneToOneCall()) return 'You\'re already in a call.';
    const supportError = kit().mediaSupportError();
    if (supportError) return supportError;
    if (typeof socket === 'undefined' || !socket || !socket.connected) return 'You\'re offline. Check your connection and try again.';
    return null;
}

async function prepareMedia(current) {
    const { getCallMedia, fetchIceServers, mediaErrorMessage, stopStream } = kit();
    setStatus(current.type === 'video' ? 'Starting camera…' : 'Starting microphone…');
    let media;
    try {
        [media, current.iceServers] = await Promise.all([getCallMedia(current.type), fetchIceServers()]);
    } catch (error) {
        if (room === current) teardown({ message: mediaErrorMessage(error, current.type), type: 'error' });
        return false;
    }
    if (room !== current) {
        stopStream(media.stream);
        return false;
    }
    current.localStream = media.stream;
    current.cameraTrack = media.stream.getVideoTracks()[0] || null;
    if (media.cameraMissing) showNotification('No camera available: you\'re joining with audio only.', 'info');
    addMeter(current, myId(), media.stream);
    updateControls(current);
    return true;
}

function waitForServer(current) {
    current.timers.server = setTimeout(() => {
        if (room === current && current.phase !== 'active') teardown({ message: 'Couldn\'t reach the server. Try again.', type: 'error' });
    }, SERVER_TIMEOUT_MS);
}

/**
 * Header buttons and the Calls panel's call-back: starts a call, or joins the one already running
 */
async function startGroupCall(chatId, type, chatName) {
    if (banner.call && banner.chatId === Number(chatId)) {
        joinGroupCall({ callId: banner.call.callId, chatId, type: banner.call.type, chatName });
        return;
    }
    const problem = cannotStart();
    if (problem) {
        showNotification(problem, room ? 'info' : 'error');
        return;
    }
    dismissRing();
    const current = newRoom({ chatId, chatName, type, phase: 'starting' });
    room = current;
    showScreen(current);
    if (!await prepareMedia(current)) return;
    setStatus('Calling…');
    if (!emitCallEvent('call_invite', { chatId: current.chatId, type })) {
        teardown({ message: 'You\'re offline. Check your connection and try again.', type: 'error' });
        return;
    }
    waitForServer(current);
}

/**
 * Join, Rejoin, and the banner
 */
async function joinGroupCall({ callId, chatId, type, chatName }) {
    const problem = cannotStart();
    if (problem) {
        showNotification(problem, room ? 'info' : 'error');
        return;
    }
    dismissRing();
    const current = newRoom({ id: Number(callId), chatId, chatName, type: type === 'video' ? 'video' : 'voice', phase: 'joining' });
    room = current;
    showScreen(current);
    renderBanner();
    if (!await prepareMedia(current)) return;
    setStatus('Joining…');
    if (!emitCallEvent('call_join', { callId: current.id })) {
        teardown({ message: 'You\'re offline. Check your connection and try again.', type: 'error' });
        return;
    }
    waitForServer(current);
}

/**
 * Tear down this tab's call (no signaling: callers send what the server must know first)
 */
function teardown({ message = null, type = 'info' } = {}) {
    const ending = room;
    if (!ending) return;
    room = null;

    Object.values(ending.timers).forEach(timer => clearTimeout(timer));
    clearInterval(ending.clockTimer);
    clearInterval(ending.meterTimer);
    for (const userId of [...ending.peers.keys()]) closePeer(ending, userId);
    for (const userId of [...ending.meters.keys()]) removeMeter(ending, userId);
    kit().stopStream(ending.localStream);
    if (ending.screenTrack) ending.screenTrack.stop();
    hideScreen();
    refreshBanner(true);
    if (message) showNotification(message, type);
}

function leaveCall() {
    if (!room) return;
    if (room.id) emitCallEvent('call_leave', { callId: room.id });
    // Still starting (no id yet): call_ringing will find no room here and leave the call
    teardown();
}

function sendMediaState(current) {
    emitCallEvent('call_media_state', {
        callId: current.id,
        muted: current.muted,
        cameraOff: !current.screenTrack && (!current.cameraTrack || current.cameraOff),
        screen: !!current.screenTrack
    });
}

// ===== Controls =====

function toggleMute() {
    if (!room || !room.localStream) return;
    room.muted = !room.muted;
    room.localStream.getAudioTracks().forEach(track => { track.enabled = !room.muted; });
    drawTile(room, myId());
    updateControls(room);
    if (room.id) sendMediaState(room);
}

function toggleCamera() {
    if (!room || !room.cameraTrack || room.screenTrack) return;
    room.cameraOff = !room.cameraOff;
    room.cameraTrack.enabled = !room.cameraOff;
    drawTile(room, myId());
    updateControls(room);
    if (room.id) sendMediaState(room);
}

/**
 * Put a track on the video slot of every connection
 */
async function replaceVideoEverywhere(current, track) {
    await Promise.all([...current.peers.values()].map((peer) => {
        const sender = kit().videoSender(peer.pc);
        return sender ? sender.replaceTrack(track) : undefined;
    }));
}

async function toggleScreenShare() {
    const current = room;
    if (!current) return;
    if (current.screenTrack) {
        await stopScreenShare(current);
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
    if (room !== current || !track) {
        kit().stopStream(stream);
        return;
    }
    try {
        await replaceVideoEverywhere(current, track);
    } catch (error) {
        kit().stopStream(stream);
        showNotification('Couldn\'t share your screen.', 'error');
        return;
    }
    current.screenTrack = track;
    // The browser's own "Stop sharing" button
    track.onended = () => { if (room === current && current.screenTrack === track) stopScreenShare(current); };
    drawTile(current, myId());
    updateControls(current);
    sendMediaState(current);
}

async function stopScreenShare(current) {
    const track = current.screenTrack;
    if (!track) return;
    current.screenTrack = null;
    try {
        await replaceVideoEverywhere(current, current.cameraTrack || null);
    } catch (error) {
        console.warn('Restoring camera failed:', error);
    }
    track.stop();
    if (room !== current) return;
    drawTile(current, myId());
    updateControls(current);
    sendMediaState(current);
}

// ===== Ringing =====

function onRing(data) {
    const callId = Number(data.callId);
    if (ring && ring.callId === callId) return; // shown again after a reconnect
    if (room || ring || kit().isInOneToOneCall()) return; // the banner still offers the call

    ring = {
        callId,
        chatId: Number(data.chatId),
        type: data.type === 'video' ? 'video' : 'voice',
        chatName: data.chatName || 'Group call',
        caller: data.caller || {},
        timer: null
    };
    const expiresIn = Date.parse(data.expiresAt) - Date.now();
    ring.timer = setTimeout(() => dismissRing(), (Number.isFinite(expiresIn) ? Math.max(expiresIn, 0) : CONFIG.CALL_RING_TIMEOUT_MS) + 3000);

    el('groupRingName').textContent = ring.chatName;
    el('groupRingType').textContent = `${kit().personName(ring.caller)} started a ${ring.type} call`;
    kit().fillCallAvatar(el('groupRingAvatar'), ring.caller);
    el('groupRingModal').hidden = false;
    el('groupRingJoinBtn').focus();
    if (!kit().dndActiveHere()) kit().startTone('ring');
}

function dismissRing() {
    if (!ring) return;
    clearTimeout(ring.timer);
    ring = null;
    kit().stopTone();
    el('groupRingModal').hidden = true;
}

function declineRing() {
    if (!ring) return;
    emitCallEvent('call_reject', { callId: ring.callId });
    dismissRing();
}

function joinFromRing() {
    if (!ring) return;
    const { callId, chatId, type, chatName } = ring;
    dismissRing();
    joinGroupCall({ callId, chatId, type, chatName });
}

// ===== Banner =====

function renderBanner() {
    const bar = el('groupCallBanner');
    if (!bar) return;
    const call = banner.call;
    if (!call || call.chatId !== banner.chatId || (room && room.id === call.callId)) {
        bar.hidden = true;
        return;
    }
    const count = call.participants.length;
    const full = count >= call.max;
    el('groupCallBannerText').textContent = `${call.type === 'video' ? 'Video' : 'Voice'} call in progress`;
    el('groupCallBannerCount').textContent = `${count} of ${call.max}`;
    el('groupCallBannerAvatars').replaceChildren(...call.participants.map((person) => {
        const avatar = FriChat.h('span', { className: 'group-call-banner-avatar', attrs: { title: kit().personName(person) } });
        kit().fillCallAvatar(avatar, person);
        return avatar;
    }));
    const join = el('groupCallBannerJoin');
    join.textContent = full ? 'Full' : 'Join';
    join.disabled = full;
    bar.hidden = false;
}

async function loadBanner() {
    const chatId = banner.chatId;
    if (!chatId) return;
    banner.lastFetch = Date.now();
    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.CALL_ACTIVE}?chatId=${chatId}`);
        if (banner.chatId !== chatId || !response || !response.success) return;
        banner.call = response.data || null;
        renderBanner();
    } catch (error) {
        console.error('Active call error:', error);
    }
}

function refreshBanner(now = false) {
    if (!banner.chatId) return;
    clearTimeout(banner.timer);
    const wait = now ? 0 : Math.max(0, BANNER_REFRESH_MS - (Date.now() - banner.lastFetch));
    if (wait === 0) loadBanner();
    else banner.timer = setTimeout(loadBanner, wait);
}

/**
 * Called with GET /chats/:id for the open chat
 */
function applyGroupCallChat(chat) {
    clearTimeout(banner.timer);
    banner = { chatId: Number(chat.id), chatName: chat.chat_name || '', call: null, timer: null, lastFetch: 0 };
    renderBanner();
    refreshBanner(true);
}

function resetGroupCallBanner() {
    clearTimeout(banner.timer);
    banner = { chatId: null, chatName: '', call: null, timer: null, lastFetch: 0 };
    renderBanner();
}

function onRoomUpdate(data) {
    if (Number(data.chatId) !== banner.chatId) return;
    if (data.active === false) {
        clearTimeout(banner.timer);
        banner.call = null;
        renderBanner();
    } else {
        refreshBanner();
    }
}

function joinFromBanner() {
    if (!banner.call) return;
    const { callId, chatId, type } = banner.call;
    joinGroupCall({ callId, chatId, type, chatName: banner.chatName });
}

// ===== Server events =====

function onParticipants(data) {
    const callId = Number(data.callId);
    const current = room;
    if (!current || (current.id && current.id !== callId) || (!current.id && current.chatId !== Number(data.chatId))) {
        // A call this tab no longer wants (left while the join was on its way)
        emitCallEvent('call_leave', { callId });
        return;
    }
    clearTimeout(current.timers.server);
    current.id = callId;
    current.phase = 'active';
    current.type = data.type === 'video' ? 'video' : 'voice';
    if (data.chatName) {
        current.chatName = data.chatName;
        el('groupCallTitle').textContent = data.chatName;
    }
    current.participants = Array.isArray(data.participants) ? data.participants : [];
    current.max = Number(data.max) || current.max;
    showFirstCallNote(current);

    const ids = current.participants.map(person => Number(person.id));
    for (const userId of [...current.peers.keys()]) {
        if (!ids.includes(userId)) closePeer(current, userId);
    }
    for (const value of data.offerTo || []) {
        const userId = Number(value);
        if (ids.includes(userId) && userId !== myId() && !current.peers.has(userId)) offerToPeer(current, userId);
    }

    if (Number.isFinite(data.elapsedMs) && !current.connectedAt) {
        current.connectedAt = Date.now() - data.elapsedMs;
        startClock(current);
    } else if (!current.connectedAt) {
        setStatus('Waiting for others to join…');
    }
    drawRoom(current);
    renderBanner();

    if (!current.stateSent) {
        current.stateSent = true;
        sendMediaState(current);
    }
}

function onCallError(data) {
    const message = data.message || 'Something went wrong with the call';
    const about = Number(data.callId);
    if (data.event === 'call_join' || (data.event === 'call_invite' && room && !room.id)) {
        if (room) teardown({ message, type: 'error' });
        else showNotification(message, 'error');
        return true;
    }
    if (!room || room.id !== about) return false;
    if (data.code === 'NOT_FOUND') teardown({ message: 'Call ended.' });
    else if (data.code === 'NOT_A_MEMBER') teardown({ message, type: 'error' });
    else console.warn('Call error:', data);
    return true;
}

/**
 * calls.js passes every call event here first.
 * @returns {boolean} true when it belonged to a group call
 */
function handleGroupCallEvent(event, data) {
    const callId = Number(data.callId);
    const isRoom = !!room && room.id === callId;
    const isRing = !!ring && ring.callId === callId;

    switch (event) {
        case 'connect':
            refreshBanner(true);
            if (!room) return false; // calls.js asks for anything ringing
            if (room.id) emitCallEvent('call_sync', { callId: room.id });
            else teardown({ message: 'Call ended: the connection was lost.', type: 'error' });
            return true;
        case 'call_invite':
            if (!data.group) return false;
            onRing(data);
            return true;
        case 'call_ringing':
            if (!data.group) return false;
            // A call this tab no longer wants (left while the invite was on its way)
            if (!room || room.id || room.chatId !== Number(data.chatId)) emitCallEvent('call_leave', { callId });
            return true;
        case 'call_participants':
            onParticipants(data);
            return true;
        case 'call_room_update':
            onRoomUpdate(data);
            return true;
        case 'call_offer':
        case 'call_answer':
        case 'call_ice_candidate':
            if (data.from === undefined) return false;
            if (event === 'call_offer') onOffer(data);
            else if (event === 'call_answer') onAnswer(data);
            else onRemoteCandidate(data);
            return true;
        case 'call_peer_reconnected':
            if (data.from === undefined) return false;
            if (isRoom) retryPeer(room, room.peers.get(Number(data.from)));
            return true;
        case 'call_sync':
            if (!isRoom) return !!data.group;
            if (!data.active) {
                teardown({ message: data.otherDevice ? 'This call continues on another device.' : 'The call ended while you were offline.' });
            } else {
                for (const peer of room.peers.values()) retryPeer(room, peer);
            }
            return true;
        case 'call_cancel':
        case 'call_timeout':
            if (isRing) dismissRing();
            return isRing || !!data.group;
        case 'call_hangup':
            if (!data.group) return false;
            if (isRoom) {
                teardown({ message: data.reason === 'connection_lost' ? 'Call ended: the connection was lost.' : 'You\'ve been disconnected from this call.' });
            }
            return true;
        case 'call_error':
            return onCallError(data);
        default:
            return false;
    }
}

// ===== Setup =====

function initializeGroupCalls() {
    // The same fixed icons as the 1:1 controls
    const icons = { groupCallMuteBtn: 'callMuteBtn', groupCallCameraBtn: 'callCameraBtn', groupCallScreenBtn: 'callScreenBtn', groupCallLeaveBtn: 'callHangupBtn', groupRingDismissBtn: 'declineCallBtn', groupRingJoinBtn: 'acceptCallBtn' };
    for (const [target, source] of Object.entries(icons)) el(target).innerHTML = el(source).innerHTML;

    el('groupCallMuteBtn').addEventListener('click', toggleMute);
    el('groupCallCameraBtn').addEventListener('click', toggleCamera);
    el('groupCallScreenBtn').addEventListener('click', toggleScreenShare);
    el('groupCallLeaveBtn').addEventListener('click', leaveCall);
    el('groupRingJoinBtn').addEventListener('click', joinFromRing);
    el('groupRingDismissBtn').addEventListener('click', declineRing);
    el('groupCallBannerJoin').addEventListener('click', joinFromBanner);
}

// Registered before chat.html's own beforeunload (which disconnects the socket), so the leave goes out first
window.addEventListener('beforeunload', () => {
    if (room && room.id) emitCallEvent('call_leave', { callId: room.id });
});

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    initializeGroupCalls,
    handleGroupCallEvent,
    startGroupCall,
    joinGroupCall,
    applyGroupCallChat,
    resetGroupCallBanner,
    dismissGroupRing: dismissRing,
    isInGroupCall: isBusy
});
})(globalThis.FriChat = globalThis.FriChat || {});
