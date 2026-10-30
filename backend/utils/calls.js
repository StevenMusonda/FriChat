/**
 * 1:1 voice and video calls: authorization, the call state machine and Socket.IO signaling.
 *
 * Media flows peer to peer (WebRTC); the server only relays signaling between the two sockets in a
 * call and keeps the history (calls table + a system notice in the chat, content "call:<type>:<status>:<seconds>").
 *
 * Rules (all enforced here):
 *   - calls only happen in a direct chat both users belong to, with no block either way and no
 *     unaccepted message request
 *   - one call per user at a time; inviting someone who is in a call answers the caller with call_busy
 *   - only the callee may accept/reject, only the caller may cancel, only the two bound sockets
 *     (the caller's tab and the tab that accepted) may exchange offer/answer/ICE candidates
 *   - unanswered calls time out after RING_TIMEOUT_MS (missed); a participant whose socket drops
 *     mid-call has RECONNECT_GRACE_MS to come back with call_sync before the call ends
 *
 * Live calls are held in memory (one server instance, like the socket rate limits). A restart ends them.
 *
 * Events, client -> server: call_invite, call_accept, call_reject, call_cancel, call_offer, call_answer,
 * call_ice_candidate, call_hangup, call_sync.
 * Server -> client: call_invite (to the callee's tabs), call_ringing (to the caller), call_accept,
 * call_reject, call_busy, call_cancel, call_timeout, call_offer, call_answer, call_ice_candidate,
 * call_hangup, call_peer_reconnected, call_sync, call_error, call_log_updated.
 */

const { executeQuery, queryOne, insertAndGetId } = require('../config/database');
const {
    CALL_TYPES,
    RING_TIMEOUT_MS,
    RECONNECT_GRACE_MS,
    MAX_SDP_LENGTH,
    MAX_CANDIDATE_LENGTH
} = require('../config/calls');
const { checkBlockBetween } = require('./blocks');
const { getRequest } = require('./messageRequests');
const { getVisibleProfile } = require('./privacy');
const { getNotificationSettings, isDndActive } = require('./notificationSettings');
const { recordNewMessage } = require('./chatState');
const { getMessageById } = require('./messageQueries');
const { chatExpiresAtSql } = require('./timeSql');

const SYSTEM_CODE_PREFIX = 'call:';

// Final statuses in the calls table (plus 'ringing' and 'active' while it's live)
const FINAL_STATUSES = ['completed', 'missed', 'declined', 'cancelled', 'busy', 'failed'];

// Why a call ended, as the client may report it on call_hangup
const HANGUP_REASONS = ['hangup', 'connection_failed', 'media_error'];

function toId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function noticeCode(type, status, seconds = 0) {
    return `${SYSTEM_CODE_PREFIX}${type}:${status}:${Math.max(0, Math.round(seconds))}`;
}

// ===== Validation of relayed signaling =====

/**
 * { type: 'offer' | 'answer', sdp } -> a clean copy, or null
 */
function cleanDescription(description, expectedType) {
    if (!description || typeof description !== 'object') return null;
    if (description.type !== expectedType) return null;
    if (typeof description.sdp !== 'string' || description.sdp.length === 0 || description.sdp.length > MAX_SDP_LENGTH) return null;
    return { type: expectedType, sdp: description.sdp };
}

/**
 * RTCIceCandidateInit -> a clean copy; null for "end of candidates"; undefined when invalid
 */
function cleanCandidate(candidate) {
    if (candidate === null) return null;
    if (!candidate || typeof candidate !== 'object') return undefined;
    if (typeof candidate.candidate !== 'string' || candidate.candidate.length > MAX_CANDIDATE_LENGTH) return undefined;
    const clean = { candidate: candidate.candidate };
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null) {
        if (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 64) return undefined;
        clean.sdpMid = candidate.sdpMid;
    } else {
        clean.sdpMid = null;
    }
    if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null) {
        if (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 64) return undefined;
        clean.sdpMLineIndex = candidate.sdpMLineIndex;
    } else {
        clean.sdpMLineIndex = null;
    }
    if (typeof candidate.usernameFragment === 'string' && candidate.usernameFragment.length <= 256) {
        clean.usernameFragment = candidate.usernameFragment;
    }
    return clean;
}

// ===== Database =====

const CALL_ERRORS = {
    NOT_A_MEMBER: { code: 'NOT_A_MEMBER', message: 'Access denied to this chat' },
    NOT_DIRECT: { code: 'NOT_DIRECT', message: 'Calls are only available in one-to-one chats' },
    REQUEST_PENDING: { code: 'REQUEST_PENDING', message: 'Calls are available once the message request is accepted' }
};

/**
 * May callerId call the other member of this chat?
 * @returns {Promise<{ error } | { calleeId }>}
 */
async function checkCallAllowed(chatId, callerId) {
    const rows = await executeQuery(`
        SELECT c.chat_type, other.user_id AS other_id
        FROM chats c
        JOIN group_members me ON me.chat_id = c.id AND me.user_id = ?
        LEFT JOIN group_members other ON other.chat_id = c.id AND other.user_id <> ?
        WHERE c.id = ?
    `, [callerId, callerId, chatId]);

    if (rows.length === 0) return { error: CALL_ERRORS.NOT_A_MEMBER };
    if (rows[0].chat_type !== 'direct') return { error: CALL_ERRORS.NOT_DIRECT };
    const others = rows.map(row => toId(row.other_id)).filter(Boolean);
    if (others.length !== 1) return { error: CALL_ERRORS.NOT_DIRECT };
    const calleeId = others[0];

    const block = await checkBlockBetween(callerId, calleeId);
    if (block) {
        return {
            error: {
                code: 'BLOCKED',
                message: block.message.includes('You blocked') ? 'You blocked this user. Unblock them to call.' : 'You can\'t call this user.'
            }
        };
    }

    const request = await getRequest(chatId);
    if (request && request.status !== 'accepted') return { error: CALL_ERRORS.REQUEST_PENDING };

    return { calleeId };
}

async function insertCall({ chatId, callerId, calleeId, type, status }) {
    if (status === 'ringing') {
        return insertAndGetId(
            'INSERT INTO calls (chat_id, caller_id, callee_id, call_type, status) VALUES (?, ?, ?, ?, ?)',
            [chatId, callerId, calleeId, type, status]
        );
    }
    // Over before it began (busy)
    return insertAndGetId(
        'INSERT INTO calls (chat_id, caller_id, callee_id, call_type, status, end_reason, ended_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [chatId, callerId, calleeId, type, status, status]
    );
}

async function markAnswered(callId) {
    await executeQuery(
        'UPDATE calls SET status = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['active', callId]
    );
}

async function markEnded(callId, status, reason) {
    await executeQuery(
        'UPDATE calls SET status = ?, end_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, reason, callId]
    );
}

/**
 * "Missed video call" / "Voice call, 4:12" in the chat. Sent by the caller, follows the chat's
 * disappearing-messages timer like any other message; clients build the text from the code.
 */
async function postCallNotice(io, call, status, seconds) {
    const messageId = await insertAndGetId(
        `INSERT INTO messages (chat_id, sender_id, message_type, content, status, expires_at) VALUES (?, ?, ?, ?, ?, ${chatExpiresAtSql()})`,
        [call.chatId, call.callerId, 'system', noticeCode(call.type, status, seconds), 'sent', call.chatId]
    );
    await executeQuery('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [call.chatId]);
    // The caller has read it; a missed call stays unread for the callee (and un-archives the chat)
    await recordNewMessage(io, call.chatId, call.callerId, messageId);
    const message = await getMessageById(messageId);
    if (message && io) io.to(`chat_${call.chatId}`).emit('new_message', message);
    return message;
}

async function callerCard(viewerId, callerId) {
    const profile = await getVisibleProfile(viewerId, callerId);
    if (!profile) return { id: Number(callerId), username: 'Unknown', fullName: null, avatarUrl: null };
    return { id: profile.id, username: profile.username, fullName: profile.fullName, avatarUrl: profile.avatarUrl };
}

async function isDnd(userId) {
    return isDndActive(await getNotificationSettings(userId), new Date());
}

const defaultStore = { checkCallAllowed, insertCall, markAnswered, markEnded, postCallNotice, callerCard, isDnd };

// ===== Call manager =====

/**
 * @param {Object} options
 * @param {Object} options.io - Socket.IO server
 * @param {Object} [options.store] - database functions (tests pass fakes)
 * @param {Object} [options.push] - { notifyIncomingCall(io, call, caller), notifyMissedCall(io, call, caller) }
 * @param {Function} [options.now]
 * @param {Object} [options.timers] - { setTimeout, clearTimeout }
 * @param {Object} [options.limits] - { ringTimeoutMs, reconnectGraceMs }
 */
function createCallManager({ io, store = defaultStore, push = null, now = () => Date.now(), timers = { setTimeout, clearTimeout }, limits = {} } = {}) {
    const ringTimeoutMs = limits.ringTimeoutMs || RING_TIMEOUT_MS;
    const reconnectGraceMs = limits.reconnectGraceMs || RECONNECT_GRACE_MS;

    const calls = new Map(); // callId -> call
    const userCalls = new Map(); // userId -> callId (or 'pending' while an invite is being stored)

    const toUser = (userId) => io.to(`user_${userId}`);
    const toSocket = (socketId) => io.to(socketId);

    function emitError(socket, event, error, extra = {}) {
        socket.emit('call_error', { event, code: error.code || 'CALL_ERROR', message: error.message, ...extra });
    }

    function getCall(callId) {
        const id = toId(callId);
        return id ? calls.get(id) || null : null;
    }

    function isParticipant(call, userId) {
        return call.callerId === userId || call.calleeId === userId;
    }

    function otherSide(call, userId) {
        return call.callerId === userId ? call.calleeId : call.callerId;
    }

    function boundSocket(call, userId) {
        return call.callerId === userId ? call.callerSocket : call.calleeSocket;
    }

    function setBoundSocket(call, userId, socketId) {
        if (call.callerId === userId) call.callerSocket = socketId;
        else call.calleeSocket = socketId;
    }

    function clearTimers(call) {
        if (call.ringTimer) timers.clearTimeout(call.ringTimer);
        call.ringTimer = null;
        for (const timer of Object.values(call.graceTimers)) timers.clearTimeout(timer);
        call.graceTimers = {};
    }

    function publicCall(call) {
        return {
            callId: call.id,
            chatId: call.chatId,
            type: call.type,
            callerId: call.callerId,
            calleeId: call.calleeId,
            status: call.status
        };
    }

    /**
     * End a live call: forget it, store the outcome, post the notice. The caller of finish() sends the
     * event that tells each side why.
     */
    async function finish(call, status, reason) {
        if (!calls.has(call.id)) return;
        calls.delete(call.id);
        clearTimers(call);
        if (userCalls.get(call.callerId) === call.id) userCalls.delete(call.callerId);
        if (userCalls.get(call.calleeId) === call.id) userCalls.delete(call.calleeId);

        const seconds = call.answeredAt ? (now() - call.answeredAt) / 1000 : 0;
        try {
            await store.markEnded(call.id, status, reason);
            await store.postCallNotice(io, call, status, seconds);
        } catch (error) {
            console.error('Call end bookkeeping error:', error);
        }
        toUser(call.callerId).emit('call_log_updated', { callId: call.id });
        toUser(call.calleeId).emit('call_log_updated', { callId: call.id });

        if ((status === 'missed' || status === 'cancelled') && push && push.notifyMissedCall) {
            push.notifyMissedCall(io, call, call.callerCard);
        }
    }

    // ----- Ringing -----

    async function invite(socket, data) {
        data = data || {};
        const callerId = socket.userId;
        const chatId = toId(data.chatId);
        const type = data.type;
        if (!chatId || !CALL_TYPES.includes(type)) {
            return emitError(socket, 'call_invite', { code: 'INVALID', message: 'Invalid call request' });
        }
        if (userCalls.has(callerId)) {
            return emitError(socket, 'call_invite', { code: 'ALREADY_IN_CALL', message: 'You\'re already in a call' });
        }

        // Held while the checks run, so a double click can't start two calls
        userCalls.set(callerId, 'pending');
        let calleeId = null;
        let reservedCallee = false;
        try {
            const allowed = await store.checkCallAllowed(chatId, callerId);
            if (allowed.error) {
                userCalls.delete(callerId);
                return emitError(socket, 'call_invite', allowed.error, { chatId });
            }
            calleeId = allowed.calleeId;

            const call = {
                id: null,
                chatId,
                type,
                callerId,
                calleeId,
                callerSocket: socket.id,
                calleeSocket: null,
                status: 'ringing',
                startedAt: now(),
                answeredAt: null,
                ringTimer: null,
                graceTimers: {},
                callerCard: null
            };

            // Busy: the callee is in (or setting up) another call
            if (userCalls.has(calleeId)) {
                userCalls.delete(callerId);
                call.id = await store.insertCall({ chatId, callerId, calleeId, type, status: 'busy' });
                socket.emit('call_busy', { chatId, type, calleeId, callId: call.id });
                try {
                    await store.postCallNotice(io, call, 'busy', 0);
                } catch (error) {
                    console.error('Busy call notice error:', error);
                }
                toUser(callerId).emit('call_log_updated', { callId: call.id });
                toUser(calleeId).emit('call_log_updated', { callId: call.id });
                return undefined;
            }
            userCalls.set(calleeId, 'pending');
            reservedCallee = true;

            call.id = await store.insertCall({ chatId, callerId, calleeId, type, status: 'ringing' });
            call.callerCard = await store.callerCard(calleeId, callerId);
            const silent = await store.isDnd(calleeId);

            // The caller hung up (or disconnected) while this was being stored
            if (userCalls.get(callerId) !== 'pending') {
                if (userCalls.get(calleeId) === 'pending') userCalls.delete(calleeId);
                await store.markEnded(call.id, 'cancelled', 'cancelled');
                return undefined;
            }

            calls.set(call.id, call);
            userCalls.set(callerId, call.id);
            userCalls.set(calleeId, call.id);
            call.silent = silent;
            call.ringTimer = timers.setTimeout(() => { timeout(call.id); }, ringTimeoutMs);

            toUser(calleeId).emit('call_invite', invitePayload(call));
            socket.emit('call_ringing', {
                callId: call.id,
                chatId,
                type,
                calleeId,
                ringTimeoutMs
            });

            if (push && push.notifyIncomingCall) push.notifyIncomingCall(io, call, call.callerCard);
            return call.id;
        } catch (error) {
            if (userCalls.get(callerId) === 'pending') userCalls.delete(callerId);
            if (reservedCallee && userCalls.get(calleeId) === 'pending') userCalls.delete(calleeId);
            throw error;
        }
    }

    function invitePayload(call) {
        return {
            callId: call.id,
            chatId: call.chatId,
            type: call.type,
            caller: call.callerCard,
            silent: !!call.silent,
            expiresAt: new Date(call.startedAt + ringTimeoutMs).toISOString()
        };
    }

    async function timeout(callId) {
        const call = calls.get(callId);
        if (!call || call.status !== 'ringing') return;
        toUser(call.callerId).emit('call_timeout', { callId });
        toUser(call.calleeId).emit('call_timeout', { callId });
        await finish(call, 'missed', 'timeout');
    }

    async function accept(socket, data) {
        const call = getCall(data && data.callId);
        if (!call || call.calleeId !== socket.userId) {
            return emitError(socket, 'call_accept', { code: 'NOT_FOUND', message: 'This call is no longer available' }, { callId: data && data.callId });
        }
        if (call.status !== 'ringing') {
            return emitError(socket, 'call_accept', { code: 'ALREADY_ANSWERED', message: 'This call was answered on another device' }, { callId: call.id });
        }

        call.status = 'active';
        call.calleeSocket = socket.id;
        call.answeredAt = now();
        if (call.ringTimer) timers.clearTimeout(call.ringTimer);
        call.ringTimer = null;

        toSocket(call.callerSocket).emit('call_accept', { callId: call.id });
        // The callee's other tabs stop ringing
        toUser(call.calleeId).except(socket.id).emit('call_cancel', { callId: call.id, reason: 'answered_elsewhere' });

        try {
            await store.markAnswered(call.id);
        } catch (error) {
            console.error('Call answered bookkeeping error:', error);
        }
        return undefined;
    }

    async function reject(socket, data) {
        const call = getCall(data && data.callId);
        if (!call || call.calleeId !== socket.userId || call.status !== 'ringing') return;
        toSocket(call.callerSocket).emit('call_reject', { callId: call.id });
        toUser(call.calleeId).emit('call_cancel', { callId: call.id, reason: 'declined' });
        await finish(call, 'declined', 'declined');
    }

    async function cancel(socket, data) {
        const call = getCall(data && data.callId);
        if (!call || call.callerId !== socket.userId || call.status !== 'ringing') return;
        toUser(call.calleeId).emit('call_cancel', { callId: call.id, reason: 'cancelled' });
        toUser(call.callerId).except(socket.id).emit('call_cancel', { callId: call.id, reason: 'cancelled' });
        await finish(call, 'cancelled', 'cancelled');
    }

    // ----- In the call -----

    /**
     * The call this socket may send media signaling for, or null
     */
    function signalingCall(socket, data, event) {
        const call = getCall(data && data.callId);
        if (!call || call.status !== 'active' || !isParticipant(call, socket.userId)) {
            emitError(socket, event, { code: 'NOT_FOUND', message: 'This call is no longer available' }, { callId: data && data.callId });
            return null;
        }
        if (boundSocket(call, socket.userId) !== socket.id) {
            emitError(socket, event, { code: 'OTHER_DEVICE', message: 'This call is on another device' }, { callId: call.id });
            return null;
        }
        return call;
    }

    function relay(socket, data, event, expectedType) {
        const call = signalingCall(socket, data, event);
        if (!call) return;
        const description = cleanDescription(data.sdp, expectedType);
        if (!description) {
            return emitError(socket, event, { code: 'INVALID', message: 'Invalid session description' }, { callId: call.id });
        }
        const target = boundSocket(call, otherSide(call, socket.userId));
        if (!target) return; // the other side is reconnecting; it restarts ICE once back
        toSocket(target).emit(event, { callId: call.id, sdp: description, iceRestart: !!data.iceRestart });
    }

    function offer(socket, data) {
        relay(socket, data, 'call_offer', 'offer');
    }

    function answer(socket, data) {
        relay(socket, data, 'call_answer', 'answer');
    }

    function iceCandidate(socket, data) {
        const call = signalingCall(socket, data, 'call_ice_candidate');
        if (!call) return;
        const candidate = cleanCandidate(data.candidate);
        if (candidate === undefined) return; // malformed: dropped
        const target = boundSocket(call, otherSide(call, socket.userId));
        if (!target) return;
        toSocket(target).emit('call_ice_candidate', { callId: call.id, candidate });
    }

    async function hangup(socket, data) {
        const call = getCall(data && data.callId);
        if (!call || !isParticipant(call, socket.userId)) return;

        if (call.status === 'ringing') {
            if (call.callerId === socket.userId) return cancel(socket, data);
            return reject(socket, data);
        }

        // Only the tab that is in the call can end it (another tab of the same user can't)
        if (boundSocket(call, socket.userId) !== socket.id) return;

        const reason = HANGUP_REASONS.includes(data && data.reason) ? data.reason : 'hangup';
        const other = otherSide(call, socket.userId);
        toUser(other).emit('call_hangup', { callId: call.id, reason, by: socket.userId });
        await finish(call, reason === 'hangup' ? 'completed' : 'failed', reason);
    }

    // ----- Reconnecting -----

    /**
     * A tab (re)connected. With { callId }: it was in that call, rebind its socket. Without: if this
     * user is being called, show the invite again (e.g. the page was opened from a call notification).
     */
    function sync(socket, data) {
        const userId = socket.userId;
        const wanted = data && data.callId !== undefined && data.callId !== null ? toId(data.callId) : null;
        const current = userCalls.get(userId);
        const call = typeof current === 'number' ? calls.get(current) : null;

        if (wanted) {
            if (!call || call.id !== wanted || call.status !== 'active') {
                socket.emit('call_sync', { callId: wanted, active: false });
                return;
            }
            const previous = boundSocket(call, userId);
            if (previous && previous !== socket.id) {
                // Still connected elsewhere: this is another tab, not the one in the call
                socket.emit('call_sync', { callId: wanted, active: false, otherDevice: true });
                return;
            }
            setBoundSocket(call, userId, socket.id);
            if (call.graceTimers[userId]) {
                timers.clearTimeout(call.graceTimers[userId]);
                delete call.graceTimers[userId];
            }
            socket.emit('call_sync', { callId: call.id, active: true });
            const peerSocket = boundSocket(call, otherSide(call, userId));
            if (peerSocket) toSocket(peerSocket).emit('call_peer_reconnected', { callId: call.id });
            return;
        }

        if (call && call.status === 'ringing' && call.calleeId === userId) {
            socket.emit('call_invite', invitePayload(call));
        }
    }

    /**
     * A socket went away: a ringing caller cancels; a participant in a call gets a grace period
     */
    async function disconnect(socket) {
        const userId = socket.userId;
        const current = userCalls.get(userId);
        if (current === 'pending') {
            // An invite from this socket is still being stored: invite() sees this and cancels
            userCalls.delete(userId);
            return;
        }
        const call = typeof current === 'number' ? calls.get(current) : null;
        if (!call) return;

        if (call.status === 'ringing') {
            if (call.callerId === userId && call.callerSocket === socket.id) {
                toUser(call.calleeId).emit('call_cancel', { callId: call.id, reason: 'cancelled' });
                await finish(call, 'cancelled', 'caller_left');
            }
            return; // a callee tab closing doesn't stop the others ringing
        }

        if (boundSocket(call, userId) !== socket.id) return;
        setBoundSocket(call, userId, null);
        call.graceTimers[userId] = timers.setTimeout(async () => {
            if (!calls.has(call.id) || boundSocket(call, userId)) return;
            const other = otherSide(call, userId);
            toUser(other).emit('call_hangup', { callId: call.id, reason: 'connection_lost', by: userId });
            toUser(userId).emit('call_hangup', { callId: call.id, reason: 'connection_lost', by: userId });
            await finish(call, 'completed', 'connection_lost');
        }, reconnectGraceMs);
    }

    function getActiveCallFor(userId) {
        const current = userCalls.get(Number(userId));
        const call = typeof current === 'number' ? calls.get(current) : null;
        return call ? publicCall(call) : null;
    }

    /**
     * Wire the events onto one socket. `on` is the rate-limited socket.on (limitSocketEvents).
     */
    function register(socket, on = socket.on.bind(socket)) {
        const handle = (event, fn) => on(event, async (data) => {
            try {
                await fn(socket, data);
            } catch (error) {
                console.error(`${event} error:`, error);
                emitError(socket, event, { code: 'CALL_ERROR', message: 'Something went wrong with the call' });
            }
        });
        handle('call_invite', invite);
        handle('call_accept', accept);
        handle('call_reject', reject);
        handle('call_cancel', cancel);
        handle('call_offer', offer);
        handle('call_answer', answer);
        handle('call_ice_candidate', iceCandidate);
        handle('call_hangup', hangup);
        handle('call_sync', sync);
        socket.on('disconnect', () => {
            disconnect(socket).catch(error => console.error('Call disconnect error:', error));
        });
    }

    return {
        register,
        invite,
        accept,
        reject,
        cancel,
        offer,
        answer,
        iceCandidate,
        hangup,
        sync,
        disconnect,
        timeout,
        getActiveCallFor,
        _calls: calls,
        _userCalls: userCalls
    };
}

module.exports = {
    SYSTEM_CODE_PREFIX,
    FINAL_STATUSES,
    HANGUP_REASONS,
    noticeCode,
    cleanDescription,
    cleanCandidate,
    checkCallAllowed,
    insertCall,
    markAnswered,
    markEnded,
    postCallNotice,
    createCallManager
};
