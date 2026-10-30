/**
 * Voice Notes Module
 * Recording: hold the mic button to record while held (release sends, slide left or Esc cancels), or
 * click it to start a recording you finish with Send or Cancel. MediaRecorder with the first format
 * the browser supports (webm/opus in Chrome, Edge and Firefox, mp4/AAC in Safari), at most
 * CONFIG.VOICE_MAX_SECONDS. Levels are sampled while recording and sent as the waveform.
 * Upload goes through the normal pipeline (POST /messages/upload with the chat id), so a voice note
 * arrives like any other file message.
 *
 * Playback: one shared Audio element, so only one voice note plays at a time and the player state
 * survives the message being re-rendered (reactions, edits). The first play of someone else's note
 * tells the server (voice_played), which tells the sender.
 */

(function (FriChat) {

// Formats to try, best first. `type` is what the file is uploaded as (no codec parameters).
const VOICE_FORMATS = [
    { mime: 'audio/webm;codecs=opus', type: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', type: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/mp4;codecs=mp4a.40.2', type: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/ogg;codecs=opus', type: 'audio/ogg', ext: 'ogg' },
    { mime: 'audio/webm', type: 'audio/webm', ext: 'webm' }
];
const VOICE_SPEEDS = [1, 1.5, 2];
const VOICE_LEVEL_INTERVAL_MS = 100;
const VOICE_MIN_MS = 700; // shorter presses are treated as a slip, not a voice note
const VOICE_CANCEL_SLIDE_PX = 80;
const VOICE_LIVE_BARS = 32;

const MIC_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
const PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
const PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="3" width="5" height="18" rx="1"></rect><rect x="14" y="3" width="5" height="18" rx="1"></rect></svg>';

// ===== Pure helpers (also used by the tests) =====

/**
 * First recorder format the browser supports, or null (then the browser picks its default)
 * @param {(mime: string) => boolean} isTypeSupported
 */
function pickVoiceFormat(isTypeSupported) {
    if (typeof isTypeSupported !== 'function') return null;
    for (const format of VOICE_FORMATS) {
        try {
            if (isTypeSupported(format.mime)) return format;
        } catch (e) {
            // Some browsers throw for unknown types instead of returning false
        }
    }
    return null;
}

/**
 * Upload type and extension for whatever the recorder actually produced ("audio/webm;codecs=opus" -> webm)
 */
function voiceFileFormat(recorderMime, picked) {
    const base = String(recorderMime || '').split(';')[0].trim().toLowerCase();
    const known = VOICE_FORMATS.find(f => f.type === base);
    if (known) return { type: known.type, ext: known.ext };
    if (picked) return { type: picked.type, ext: picked.ext };
    return { type: 'audio/webm', ext: 'webm' };
}

/**
 * Levels sampled while recording (0..1) -> `bars` levels from 0 to 100, scaled so the loudest bar
 * is full height and silence still shows as a short bar
 */
function compressWaveform(levels, bars) {
    const samples = Array.isArray(levels) ? levels.filter(v => Number.isFinite(v) && v >= 0) : [];
    const count = Math.max(1, Math.min(bars || 48, 64));
    if (samples.length === 0) return new Array(count).fill(5);

    const buckets = [];
    for (let i = 0; i < count; i++) {
        const start = Math.floor(i * samples.length / count);
        const end = Math.max(start + 1, Math.floor((i + 1) * samples.length / count));
        let peak = 0;
        for (let j = start; j < end && j < samples.length; j++) peak = Math.max(peak, samples[j]);
        buckets.push(peak);
    }
    const loudest = Math.max(...buckets) || 1;
    return buckets.map(v => Math.max(5, Math.min(100, Math.round(v / loudest * 100))));
}

/**
 * 83 seconds -> "1:23"
 */
function formatVoiceTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * What to tell the user when the microphone can't be opened
 */
function microphoneErrorMessage(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        return 'Microphone access is blocked. Allow it for this site in your browser settings to record voice notes.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        return 'No microphone was found. Connect one and try again.';
    }
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
        return 'Your microphone is in use by another app or could not be started.';
    }
    return 'Could not start the microphone.';
}

// ===== Recording =====

// { mode: 'hold' | 'locked', chatId, stream, recorder, format, chunks, levels, startedAt, ... } while recording
let voiceRecording = null;
let voicePress = null; // { timer, startX, pointerId } between pointerdown and the hold threshold

function voiceSupportProblem() {
    if (!window.isSecureContext) return 'Voice notes need a secure connection (https or localhost).';
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
        return 'This browser can\'t record voice notes.';
    }
    return null;
}

function canStartVoiceNote() {
    if (!currentChatId) return false;
    if (typeof FriChat.canPostInCurrentChat === 'function' && !FriChat.canPostInCurrentChat()) {
        showNotification('You can\'t send messages in this chat', 'error');
        return false;
    }
    if (isEditingMessage()) {
        showNotification('Finish editing the message first', 'error');
        return false;
    }
    const problem = voiceSupportProblem();
    if (problem) {
        showNotification(problem, 'error');
        return false;
    }
    return true;
}

async function startVoiceRecording(mode) {
    if (voiceRecording || !canStartVoiceNote()) return;

    // Claimed before the permission prompt, so a second press can't start another recording
    const state = { mode, chatId: currentChatId, starting: true, cancelled: false, chunks: [], levels: [] };
    voiceRecording = state;
    showVoiceBar(state);

    // Created while the press still counts as a user gesture, so autoplay rules don't leave it suspended
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
        try {
            state.audioContext = new AudioContextClass();
        } catch (error) {
            state.audioContext = null;
        }
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
    } catch (error) {
        console.error('Microphone error:', error);
        if (state.audioContext) state.audioContext.close().catch(() => {});
        if (voiceRecording === state) voiceRecording = null;
        hideVoiceBar();
        showNotification(microphoneErrorMessage(error), 'error');
        return;
    }

    // Cancelled (Esc, chat switched) while the permission prompt was open
    if (state.cancelled || voiceRecording !== state) {
        stream.getTracks().forEach(track => track.stop());
        if (state.audioContext) state.audioContext.close().catch(() => {});
        return;
    }

    const format = pickVoiceFormat(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported.bind(MediaRecorder));
    let recorder;
    try {
        recorder = format
            ? new MediaRecorder(stream, { mimeType: format.mime, audioBitsPerSecond: 32000 })
            : new MediaRecorder(stream);
    } catch (error) {
        console.error('MediaRecorder error:', error);
        stream.getTracks().forEach(track => track.stop());
        if (state.audioContext) state.audioContext.close().catch(() => {});
        voiceRecording = null;
        hideVoiceBar();
        showNotification('This browser can\'t record voice notes.', 'error');
        return;
    }

    Object.assign(state, { stream, recorder, format, starting: false });
    recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size > 0) state.chunks.push(e.data);
    });
    recorder.start(250);
    state.startedAt = performance.now();

    startLevelMeter(state);
    state.tick = setInterval(() => updateVoiceTimer(state), 200);
    updateVoiceBar(state);
}

/**
 * Sample the microphone level for the live bars and the waveform (Web Audio; optional: without it
 * the note is sent with a flat waveform)
 */
function startLevelMeter(state) {
    const context = state.audioContext;
    if (!context) return;
    try {
        if (context.state === 'suspended') context.resume().catch(() => {});
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(state.stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        state.levelTimer = setInterval(() => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const v = (data[i] - 128) / 128;
                sum += v * v;
            }
            const level = Math.min(1, Math.sqrt(sum / data.length) * 3);
            state.levels.push(level);
            drawLiveLevels(state);
        }, VOICE_LEVEL_INTERVAL_MS);
    } catch (error) {
        console.error('Level meter error:', error);
    }
}

function elapsedMs(state) {
    return state.startedAt ? performance.now() - state.startedAt : 0;
}

function updateVoiceTimer(state) {
    const elapsed = elapsedMs(state);
    const label = document.getElementById('voiceTimer');
    if (label) label.textContent = `${formatVoiceTime(elapsed / 1000)} / ${formatVoiceTime(CONFIG.VOICE_MAX_SECONDS)}`;

    if (elapsed >= CONFIG.VOICE_MAX_SECONDS * 1000) {
        showNotification(`Voice notes can be up to ${CONFIG.VOICE_MAX_SECONDS / 60} minutes. Sending what you recorded.`, 'info');
        finishVoiceRecording(true);
    }
}

/**
 * Stop recording; send it (send = true) or throw it away
 */
function finishVoiceRecording(send) {
    const state = voiceRecording;
    if (!state) return;
    voiceRecording = null;
    state.cancelled = !send;
    clearInterval(state.tick);
    clearInterval(state.levelTimer);
    hideVoiceBar();

    const durationMs = Math.round(elapsedMs(state));
    const cleanup = () => {
        if (state.stream) state.stream.getTracks().forEach(track => track.stop());
        if (state.audioContext) state.audioContext.close().catch(() => {});
    };

    // Still waiting for microphone permission: startVoiceRecording sees `cancelled` and stops
    if (!state.recorder) {
        state.cancelled = true;
        return;
    }

    state.recorder.addEventListener('stop', () => {
        cleanup();
        if (!send) return;
        if (durationMs < VOICE_MIN_MS) {
            showNotification('Hold the mic button a little longer to record', 'info');
            return;
        }
        const fileFormat = voiceFileFormat(state.recorder.mimeType, state.format);
        const blob = new Blob(state.chunks, { type: fileFormat.type });
        const name = `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${fileFormat.ext}`;
        const file = new File([blob], name, { type: fileFormat.type });
        sendVoiceNote(state.chatId, file, {
            voiceDurationMs: Math.min(durationMs, CONFIG.VOICE_MAX_SECONDS * 1000),
            voiceWaveform: compressWaveform(state.levels, CONFIG.VOICE_WAVEFORM_BARS).join(',')
        });
    }, { once: true });

    if (state.recorder.state !== 'inactive') {
        state.recorder.stop();
    } else {
        state.recorder.dispatchEvent(new Event('stop'));
    }
}

function cancelVoiceRecording() {
    if (voicePress) {
        clearTimeout(voicePress.timer);
        voicePress = null;
    }
    finishVoiceRecording(false);
}

/**
 * Upload into the chat (the server creates the message and broadcasts it). If it fails, the note
 * goes into the upload tray so Send retries it without re-recording.
 */
async function sendVoiceNote(chatId, file, fields) {
    const limits = await FriChat.loadUploadLimits();
    if (limits && limits.maxAudioFileSize && file.size > limits.maxAudioFileSize) {
        showNotification(`This voice note is larger than ${formatFileSize(limits.maxAudioFileSize)}`, 'error');
        return;
    }

    const replyToMessageId = chatId === currentChatId ? getReplyTargetId() : null;
    if (replyToMessageId) clearComposerContext();

    const item = { file, fields, xhr: null };
    setVoiceSending(chatId, 0);
    const result = await FriChat.uploadWithProgress(chatId, item, replyToMessageId, (progress) => setVoiceSending(chatId, progress));
    setVoiceSending(chatId, null);

    if (!result.success && !result.cancelled) {
        if (chatId === currentChatId) {
            showNotification(`Voice note not sent: ${result.message} It's in the tray - press Send to try again.`, 'error');
            FriChat.addVoiceNoteToTray(file, fields, result.message);
        } else {
            showNotification(`Voice note not sent: ${result.message}`, 'error');
        }
    }
}

function setVoiceSending(chatId, progress) {
    const status = document.getElementById('voiceSendingStatus');
    if (!status) return;
    const show = progress !== null && chatId === currentChatId;
    status.hidden = !show;
    if (show) status.textContent = `Sending voice note… ${Math.round(progress * 100)}%`;
}

// ===== Recording bar =====

function showVoiceBar(state) {
    const bar = document.getElementById('voiceRecorderBar');
    if (!bar) return;
    bar.hidden = false;
    bar.classList.toggle('locked', state.mode === 'locked');
    bar.classList.remove('will-cancel');
    const container = document.querySelector('.message-input-container');
    container.classList.add('recording-voice');
    // Holding: the mic button stays visible and pressed; locked: the bar's Send replaces it
    container.classList.toggle('voice-locked', state.mode === 'locked');
    const levels = document.getElementById('voiceLiveLevels');
    if (levels) levels.replaceChildren(...Array.from({ length: VOICE_LIVE_BARS }, () => document.createElement('span')));
    updateVoiceBar(state);
}

function updateVoiceBar(state) {
    const hint = document.getElementById('voiceHint');
    if (hint) {
        hint.textContent = state.starting
            ? 'Waiting for the microphone…'
            : (state.mode === 'hold' ? 'Release to send · slide left to cancel' : 'Recording');
    }
    const send = document.getElementById('voiceSendBtn');
    if (send) send.disabled = !!state.starting;
    updateVoiceTimer(state);
}

function drawLiveLevels(state) {
    const container = document.getElementById('voiceLiveLevels');
    if (!container) return;
    const bars = container.children;
    const recent = state.levels.slice(-bars.length);
    for (let i = 0; i < bars.length; i++) {
        const level = recent[i - (bars.length - recent.length)] || 0;
        bars[i].style.height = `${Math.max(8, Math.round(level * 100))}%`;
    }
}

function hideVoiceBar() {
    const bar = document.getElementById('voiceRecorderBar');
    if (bar) bar.hidden = true;
    const container = document.querySelector('.message-input-container');
    if (container) container.classList.remove('recording-voice', 'voice-locked');
}

// ===== Mic button: hold or click =====

function initializeVoiceRecorder() {
    const button = document.getElementById('voiceBtn');
    if (!button) return;

    button.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || voiceRecording) return;
        e.preventDefault(); // no text selection or focus jump while holding
        try { button.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
        voicePress = {
            startX: e.clientX,
            pointerId: e.pointerId,
            timer: setTimeout(() => {
                if (voicePress) voicePress.held = true;
                startVoiceRecording('hold');
            }, CONFIG.VOICE_HOLD_MS)
        };
    });

    button.addEventListener('pointermove', (e) => {
        if (!voicePress || !voicePress.held || !voiceRecording) return;
        const bar = document.getElementById('voiceRecorderBar');
        if (bar) bar.classList.toggle('will-cancel', voicePress.startX - e.clientX > VOICE_CANCEL_SLIDE_PX);
    });

    button.addEventListener('pointerup', (e) => {
        if (!voicePress) return;
        const press = voicePress;
        voicePress = null;
        clearTimeout(press.timer);

        if (!press.held) {
            // A short click: a recording you finish with the buttons
            startVoiceRecording('locked');
            return;
        }
        if (!voiceRecording) return;
        if (voiceRecording.starting) {
            // Released while the permission prompt was up: keep recording, finish with the buttons
            voiceRecording.mode = 'locked';
            showVoiceBar(voiceRecording);
            return;
        }
        finishVoiceRecording(press.startX - e.clientX <= VOICE_CANCEL_SLIDE_PX);
    });

    button.addEventListener('pointercancel', () => {
        if (!voicePress) return;
        const held = voicePress.held;
        clearTimeout(voicePress.timer);
        voicePress = null;
        if (held && voiceRecording && voiceRecording.mode === 'hold') cancelVoiceRecording();
    });

    // Keyboard (Enter / Space) arrives as a click with no pointer: start a recording to finish with the buttons
    button.addEventListener('click', (e) => {
        if (e.detail === 0 && !voiceRecording) startVoiceRecording('locked');
    });

    // Long-press on touch screens opens the context menu otherwise
    button.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('voiceCancelBtn').addEventListener('click', cancelVoiceRecording);
    document.getElementById('voiceSendBtn').addEventListener('click', () => finishVoiceRecording(true));

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && voiceRecording) {
            e.preventDefault();
            cancelVoiceRecording();
        }
    });
}

// ===== Playback =====

const voicePlayer = {
    audio: null,
    messageId: null,
    speed: 1
};

try {
    const saved = parseFloat(localStorage.getItem('voiceSpeed'));
    if (VOICE_SPEEDS.includes(saved)) voicePlayer.speed = saved;
} catch (e) {
    // Not remembered in private mode
}

function voiceAudio() {
    if (!voicePlayer.audio) {
        const audio = new Audio();
        audio.preload = 'metadata';
        audio.addEventListener('timeupdate', updateActiveVoiceNote);
        audio.addEventListener('play', updateActiveVoiceNote);
        audio.addEventListener('pause', updateActiveVoiceNote);
        audio.addEventListener('playing', onVoicePlaying);
        audio.addEventListener('ended', () => {
            audio.currentTime = 0;
            updateActiveVoiceNote();
        });
        audio.addEventListener('loadedmetadata', fixInfiniteDuration);
        audio.addEventListener('error', () => {
            if (voicePlayer.messageId) showNotification('This voice note can\'t be played in this browser', 'error');
        });
        voicePlayer.audio = audio;
    }
    return voicePlayer.audio;
}

/**
 * Chrome's MediaRecorder writes webm without a duration; seeking far ahead makes the browser work it out
 */
function fixInfiniteDuration() {
    const audio = voicePlayer.audio;
    if (!audio || Number.isFinite(audio.duration)) return;
    // The recorder's own measurement is enough for the time and the seek bar
    const message = voiceMessage(voicePlayer.messageId);
    if (message && message.duration_ms) return;
    const resume = !audio.paused;
    const restore = () => {
        audio.removeEventListener('durationchange', restore);
        audio.currentTime = 0;
        if (resume) audio.play().catch(() => {});
    };
    audio.addEventListener('durationchange', restore);
    audio.currentTime = 1e101;
}

function voiceMessage(messageId) {
    return typeof currentMessages !== 'undefined' ? currentMessages.find(m => m.id === messageId) : null;
}

/**
 * Length in seconds: what the recorder measured, else what the browser found
 */
function voiceDurationSeconds(message) {
    if (message && message.duration_ms) return message.duration_ms / 1000;
    const audio = voicePlayer.audio;
    if (audio && voicePlayer.messageId === (message && message.id) && Number.isFinite(audio.duration)) return audio.duration;
    return 0;
}

function toggleVoicePlayback(messageId) {
    const message = voiceMessage(messageId);
    if (!message) return;
    const audio = voiceAudio();

    if (voicePlayer.messageId === messageId) {
        if (audio.paused) audio.play().catch(handlePlayError);
        else audio.pause();
        return;
    }

    // Another note was playing: it stops (only one at a time)
    const previous = voicePlayer.messageId;
    audio.pause();
    voicePlayer.messageId = messageId;
    audio.src = getFileUrl(message.upload_path);
    audio.playbackRate = voicePlayer.speed;
    audio.play().catch(handlePlayError);
    if (previous) refreshVoiceNote(previous);
    refreshVoiceNote(messageId);
}

function handlePlayError(error) {
    if (error && error.name === 'AbortError') return; // a newer play() replaced it
    console.error('Voice playback error:', error);
    showNotification(error && error.name === 'NotSupportedError'
        ? 'This voice note can\'t be played in this browser'
        : 'Could not play the voice note', 'error');
}

/**
 * First play of someone else's note: tell the server once
 */
function onVoicePlaying() {
    const message = voiceMessage(voicePlayer.messageId);
    updateActiveVoiceNote();
    if (!message || message.sender_id === getCurrentUser().userId || message.played_by_me) return;
    message.played_by_me = true;
    markVoicePlayedViaSocket(message.id);
    refreshVoiceNote(message.id);
}

function stopVoicePlayback() {
    if (!voicePlayer.audio) return;
    const previous = voicePlayer.messageId;
    voicePlayer.audio.pause();
    voicePlayer.audio.removeAttribute('src');
    voicePlayer.audio.load();
    voicePlayer.messageId = null;
    if (previous) refreshVoiceNote(previous);
}

function seekVoiceNote(messageId, fraction) {
    const message = voiceMessage(messageId);
    if (!message) return;
    if (voicePlayer.messageId !== messageId) {
        toggleVoicePlayback(messageId);
    }
    const audio = voiceAudio();
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : voiceDurationSeconds(message);
    if (duration > 0) audio.currentTime = Math.max(0, Math.min(duration, fraction * duration));
    updateActiveVoiceNote();
}

function cycleVoiceSpeed() {
    const index = VOICE_SPEEDS.indexOf(voicePlayer.speed);
    voicePlayer.speed = VOICE_SPEEDS[(index + 1) % VOICE_SPEEDS.length];
    if (voicePlayer.audio) voicePlayer.audio.playbackRate = voicePlayer.speed;
    try {
        localStorage.setItem('voiceSpeed', String(voicePlayer.speed));
    } catch (e) {
        // Not remembered in private mode
    }
    document.querySelectorAll('#messagesContainer [data-voice-speed]').forEach(button => {
        button.textContent = `${voicePlayer.speed}×`;
        button.setAttribute('aria-label', `Playback speed ${voicePlayer.speed} times`);
    });
}

/**
 * HTML for a voice note bubble. Every value is a number or fixed text (no user content).
 */
function renderVoiceNoteHtml(message) {
    const id = parseInt(message.id);
    const isOwn = message.sender_id === getCurrentUser().userId;
    const active = voicePlayer.messageId === id && voicePlayer.audio;
    const playing = active && !voicePlayer.audio.paused;
    const duration = voiceDurationSeconds(message);
    const current = active ? voicePlayer.audio.currentTime : 0;
    const progress = duration > 0 ? Math.min(1, current / duration) : 0;

    const levels = Array.isArray(message.waveform) && message.waveform.length > 0
        ? message.waveform
        : new Array(CONFIG.VOICE_WAVEFORM_BARS).fill(30);
    const bars = levels.map((level, i) => {
        const height = Math.max(5, Math.min(100, parseInt(level) || 0));
        const played = (i + 0.5) / levels.length <= progress;
        return `<span class="${played ? 'played' : ''}" style="height:${height}%"></span>`;
    }).join('');

    // Own notes: mic turns blue once someone played it. Others' notes: dot until you play it.
    const state = isOwn
        ? `<span class="voice-note-state ${message.voice_played ? 'played' : ''}" title="${message.voice_played ? 'Played' : 'Not played yet'}" aria-label="${message.voice_played ? 'Played' : 'Not played yet'}">${MIC_ICON_SVG}</span>`
        : (message.played_by_me ? '' : '<span class="voice-note-unplayed" title="Not played yet" aria-label="Not played yet"></span>');

    return `
        <div class="voice-note ${playing ? 'playing' : ''}" data-voice-note="${id}">
            <button type="button" class="voice-play-btn" data-voice-play="${id}" aria-label="${playing ? 'Pause voice message' : 'Play voice message'}">
                ${playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG}
            </button>
            <div class="voice-note-body">
                <div class="voice-wave">
                    <div class="voice-wave-bars" aria-hidden="true">${bars}</div>
                    <input type="range" class="voice-seek" data-voice-seek="${id}" min="0" max="1000" step="1"
                        value="${Math.round(progress * 1000)}" aria-label="Seek voice message"
                        aria-valuetext="${formatVoiceTime(current)} of ${formatVoiceTime(duration)}">
                </div>
                <div class="voice-note-meta">
                    <span class="voice-note-time">${active && current > 0 ? formatVoiceTime(current) : formatVoiceTime(duration)}</span>
                    ${state}
                    <button type="button" class="voice-speed-btn" data-voice-speed="${id}" aria-label="Playback speed ${voicePlayer.speed} times">${voicePlayer.speed}×</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Redraw one voice note in place (keeps the rest of the message, e.g. reactions, untouched)
 */
function refreshVoiceNote(messageId) {
    const element = document.querySelector(`#messagesContainer [data-voice-note="${parseInt(messageId)}"]`);
    const message = voiceMessage(messageId);
    if (!element || !message) return;
    element.outerHTML = renderVoiceNoteHtml(message);
}

/**
 * Progress, time and play/pause of the note that's playing (cheap: no re-render)
 */
function updateActiveVoiceNote() {
    const id = voicePlayer.messageId;
    if (!id) return;
    const element = document.querySelector(`#messagesContainer [data-voice-note="${id}"]`);
    const message = voiceMessage(id);
    if (!element || !message) return;

    const audio = voicePlayer.audio;
    const duration = voiceDurationSeconds(message);
    const progress = duration > 0 ? Math.min(1, audio.currentTime / duration) : 0;
    const playing = !audio.paused;

    element.classList.toggle('playing', playing);
    const button = element.querySelector('.voice-play-btn');
    if (button.dataset.playing !== String(playing)) {
        button.dataset.playing = String(playing);
        button.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
        button.setAttribute('aria-label', playing ? 'Pause voice message' : 'Play voice message');
    }
    const bars = element.querySelectorAll('.voice-wave-bars span');
    bars.forEach((bar, i) => bar.classList.toggle('played', (i + 0.5) / bars.length <= progress));
    const seek = element.querySelector('.voice-seek');
    if (document.activeElement !== seek) seek.value = String(Math.round(progress * 1000));
    seek.setAttribute('aria-valuetext', `${formatVoiceTime(audio.currentTime)} of ${formatVoiceTime(duration)}`);
    element.querySelector('.voice-note-time').textContent = formatVoiceTime(audio.currentTime > 0 || playing ? audio.currentTime : duration);
}

/**
 * Someone played one of this user's voice notes (voice_note_played)
 */
function applyVoiceNotePlayed(data) {
    if (!data || data.chatId !== currentChatId) return;
    const message = voiceMessage(data.messageId);
    if (!message || message.voice_played) return;
    message.voice_played = true;
    refreshVoiceNote(message.id);
}

function initializeVoiceNotes() {
    initializeVoiceRecorder();

    const container = document.getElementById('messagesContainer');
    container.addEventListener('click', (e) => {
        const play = e.target.closest('[data-voice-play]');
        if (play) {
            e.stopPropagation();
            toggleVoicePlayback(parseInt(play.dataset.voicePlay));
            return;
        }
        const speed = e.target.closest('[data-voice-speed]');
        if (speed) {
            e.stopPropagation();
            cycleVoiceSpeed();
            return;
        }
        // Seeking is not a message click (selection mode, actions)
        if (e.target.closest('[data-voice-seek]')) e.stopPropagation();
    });
    container.addEventListener('input', (e) => {
        const seek = e.target.closest('[data-voice-seek]');
        if (seek) seekVoiceNote(parseInt(seek.dataset.voiceSeek), Number(seek.value) / 1000);
    });

    onLifecycleEvent((event, data) => {
        if (event === 'voice_note_played') applyVoiceNotePlayed(data);
    });
}

/**
 * Leaving a chat: stop what's playing and throw away a recording in progress
 */
function resetVoiceState() {
    stopVoicePlayback();
    if (voiceRecording) cancelVoiceRecording();
    setVoiceSending(null, null);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    resetVoiceState,
    renderVoiceNoteHtml,
    voicePlayer,
    stopVoicePlayback,
    initializeVoiceNotes
});
})(globalThis.FriChat = globalThis.FriChat || {});
