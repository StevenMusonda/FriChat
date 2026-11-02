/**
 * Small group voice and video calls: the room, its rules and per-pair Socket.IO signaling.
 * utils/calls.js owns the sockets and passes group events here; both share the same `calls` and
 * `userCalls` maps, so a user is in one call at a time across 1:1 and group calls.
 *
 * Media is mesh WebRTC: one peer connection per pair. The server keeps the room and relays
 * offers/answers/ICE, addressed by user id, only between two participants of the same room.
 *
 * Rules (all enforced here):
 *   - any member of a group chat can start a call (call_invite); there is one call per chat at a
 *     time, so a second call_invite joins the running call
 *   - at most `max` people (GROUP_CALL_MAX, config/calls.js); the next joiner gets CALL_FULL
 *   - every event checks chat membership against the database; someone who lost it is taken out
 *   - nobody is in a call with someone they blocked or who blocked them: the joiner is refused, and a
 *     block made during a call removes the blocked person
 *   - the newcomer offers to everyone already there (call_participants.offerTo), so one side of each
 *     pair always offers and offers can't collide; that side also does the ICE restarts
 *   - a participant whose socket drops has RECONNECT_GRACE_MS to come back with call_sync
 *   - the call ends when the last person leaves, however long they have been alone
 *
 * Events, client -> server: call_invite, call_join, call_leave, call_reject (Dismiss), call_offer,
 * call_answer, call_ice_candidate (these three with `to`), call_media_state, call_sync.
 * Server -> client: call_invite (group: true), call_ringing (group: true), call_participants,
 * call_room_update (to the whole chat, for the banner), call_offer, call_answer, call_ice_candidate
 * (these three with `from`), call_peer_reconnected, call_sync, call_cancel, call_timeout, call_hangup
 * (reason 'removed' or 'connection_lost'), call_error, call_log_updated.
 */

const { executeQuery, queryOne, insertAndGetId } = require('../config/database');
const { getBlockRelations } = require('./blocks');
const { groupCallMax } = require('../config/calls');

// ===== Notices =====

/**
 * "call:group:video:started": "Alice started a video call"
 */
function groupStartedCode(type) {
    return `call:group:${type}:started`;
}

/**
 * "call:group:video:completed:750:3:1,2,3" (seconds, people who joined, their ids). One message for the
 * whole chat: each client words it for its viewer ("Missed group call" unless the ids include them).
 */
function groupEndedCode(type, status, seconds, userIds) {
    const ids = [...userIds].map(Number);
    return `call:group:${type}:${status}:${Math.max(0, Math.round(seconds))}:${ids.length}:${ids.join(',')}`;
}

// ===== Database =====

/**
 * @returns {Promise<{ name, memberIds } | null>} null unless this is a group chat userId belongs to
 */
async function getGroupForCall(chatId, userId) {
    const rows = await executeQuery(`
        SELECT c.chat_type, c.chat_name, gm.user_id
        FROM chats c
        JOIN group_members gm ON gm.chat_id = c.id
        WHERE c.id = ?
    `, [chatId]);
    if (rows.length === 0 || rows[0].chat_type !== 'group') return null;
    const memberIds = rows.map(row => Number(row.user_id));
    if (!memberIds.includes(Number(userId))) return null;
    return { name: rows[0].chat_name, memberIds };
}

async function isChatMember(chatId, userId) {
    return !!(await queryOne('SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]));
}

/**
 * Who this user blocked and who blocked them, as two sets
 */
async function blockSets(userId) {
    const { blocked, blockedBy } = await getBlockRelations(userId);
    return { blocked: new Set(blocked), blockedBy: new Set(blockedBy) };
}

async function recordJoin(callId, userId) {
    const row = await queryOne('SELECT id FROM call_participants WHERE call_id = ? AND user_id = ?', [callId, userId]);
    if (row) {
        await executeQuery('UPDATE call_participants SET left_at = NULL WHERE id = ?', [row.id]);
    } else {
        await insertAndGetId('INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)', [callId, userId]);
    }
}

async function recordLeave(callId, userId) {
    await executeQuery('UPDATE call_participants SET left_at = CURRENT_TIMESTAMP WHERE call_id = ? AND user_id = ?', [callId, userId]);
}

const groupStore = { getGroupForCall, isChatMember, blockSets, recordJoin, recordLeave };

// ===== Rooms =====

/**
 * @param {Object} shared - what utils/calls.js owns: { io, store, push, now, timers, ringTimeoutMs,
 *   reconnectGraceMs, maxParticipants, calls, userCalls, emitError, getCall, toId, cleanDescription, cleanCandidate }
 */
function createGroupCalls(shared) {
    const {
        io, store, push, now, timers, ringTimeoutMs, reconnectGraceMs, maxParticipants,
        calls, userCalls, emitError, getCall, toId, cleanDescription, cleanCandidate
    } = shared;

    const chatCalls = new Map(); // chatId -> callId of the running call
    const chatStarts = new Map(); // chatId -> promise of a call being stored, so two starters end up in one call

    const toUser = (userId) => io.to(`user_${userId}`);
    const toSocket = (socketId) => io.to(socketId);
    const notFound = { code: 'NOT_FOUND', message: 'This call has ended' };

    async function logged(what, fn) {
        try {
            return await fn();
        } catch (error) {
            console.error(`Group call ${what} error:`, error);
            return undefined;
        }
    }

    function roomUpdate(call, active) {
        // No names or photos here: those depend on the viewer, so clients fetch GET /api/calls/active
        io.to(`chat_${call.chatId}`).emit('call_room_update', {
            callId: call.id,
            chatId: call.chatId,
            type: call.type,
            active,
            count: call.participants.size
        });
    }

    async function cardFor(call, viewerId, userId) {
        const key = `${viewerId}:${userId}`;
        if (!call.cards.has(key)) call.cards.set(key, await store.callerCard(viewerId, userId));
        return call.cards.get(key);
    }

    /**
     * Each participant's view of the room (photos follow the privacy settings of the person looked at)
     */
    async function participantList(call, viewerId) {
        const list = [];
        for (const participant of [...call.participants.values()]) {
            const card = await cardFor(call, viewerId, participant.userId);
            list.push({
                ...card,
                muted: participant.muted,
                cameraOff: participant.cameraOff,
                screen: participant.screen
            });
        }
        return list;
    }

    /**
     * call_participants to everyone in the room. Sends run one after another, each from the room as it
     * is then, so a slow profile lookup can't deliver an old list after a newer one.
     */
    function sendParticipants(call, offers = {}) {
        call.sends = call.sends.then(async () => {
            for (const participant of [...call.participants.values()]) {
                if (!participant.socket) continue;
                const list = await participantList(call, participant.userId);
                toSocket(participant.socket).emit('call_participants', {
                    callId: call.id,
                    chatId: call.chatId,
                    type: call.type,
                    chatName: call.chatName,
                    max: call.max,
                    elapsedMs: call.answeredAt ? now() - call.answeredAt : null,
                    participants: list,
                    ...(offers[participant.userId] ? { offerTo: offers[participant.userId] } : {})
                });
            }
        }).catch(error => console.error('Group call participants error:', error));
        return call.sends;
    }

    function invitePayload(call, card) {
        return {
            callId: call.id,
            chatId: call.chatId,
            type: call.type,
            group: true,
            chatName: call.chatName,
            caller: card,
            count: call.participants.size,
            expiresAt: new Date(call.startedAt + ringTimeoutMs).toISOString()
        };
    }

    function addParticipant(call, userId, socketId) {
        call.participants.set(userId, {
            userId,
            socket: socketId,
            muted: false,
            cameraOff: false,
            screen: false,
            relays: Promise.resolve()
        });
        call.joined.add(userId);
        userCalls.set(userId, call.id);
    }

    // ----- Starting -----

    /**
     * call_invite in a chat that isn't a 1:1 call. utils/calls.js holds userCalls[caller] = 'pending'
     * on entry; notGroupError is what to answer if this isn't a group chat either.
     */
    async function start(socket, chatId, type, notGroupError) {
        const callerId = socket.userId;
        const release = () => { if (userCalls.get(callerId) === 'pending') userCalls.delete(callerId); };

        let group;
        try {
            group = await store.getGroupForCall(chatId, callerId);
        } catch (error) {
            release();
            throw error;
        }
        if (!group) {
            release();
            return emitError(socket, 'call_invite', notGroupError, { chatId });
        }

        const running = chatCalls.get(chatId);
        const starting = chatStarts.get(chatId);
        if (running || starting) {
            // Someone got there first: this is a join
            release();
            const callId = running || await starting;
            if (!callId) return emitError(socket, 'call_invite', { code: 'CALL_ERROR', message: 'Couldn\'t start the call. Try again.' }, { chatId });
            return join(socket, { callId });
        }

        const creating = create(socket, chatId, type, group);
        chatStarts.set(chatId, creating.catch(() => null));
        try {
            return await creating;
        } finally {
            chatStarts.delete(chatId);
            release();
        }
    }

    async function create(socket, chatId, type, group) {
        const callerId = socket.userId;
        const call = {
            id: null,
            isGroup: true,
            chatId,
            chatName: group.name,
            type,
            callerId,
            calleeId: null,
            status: 'ringing',
            startedAt: now(),
            answeredAt: null,
            max: maxParticipants || groupCallMax(),
            participants: new Map(), // userId -> participant
            joined: new Set(), // everyone who was ever in the call
            reserved: new Set(), // joiners whose checks are still running: they hold a place
            ringing: new Set(), // being rung right now
            rung: new Set(), // rung and didn't dismiss: missed-call push if they never join
            notified: new Set(), // everyone rung: the Calls panel updates when the call ends
            ringTimer: null,
            graceTimers: {},
            cards: new Map(),
            sends: Promise.resolve()
        };

        call.id = await store.insertCall({ chatId, callerId, calleeId: null, type, status: 'ringing' });

        // Not ringing: anyone with a block with the caller, anyone in do-not-disturb, anyone in a call
        const { blocked, blockedBy } = await store.blockSets(callerId);
        const others = group.memberIds.filter(id => id !== callerId && !blocked.has(id) && !blockedBy.has(id) && !userCalls.has(id));
        const quiet = await Promise.all(others.map(id => store.isDnd(id)));
        const targets = others.filter((_, index) => !quiet[index]);
        const cards = new Map();
        for (const id of targets) cards.set(id, await store.callerCard(id, callerId));

        // The caller hung up (or disconnected) while this was being stored
        if (userCalls.get(callerId) !== 'pending') {
            await store.markEnded(call.id, 'cancelled', 'cancelled');
            return null;
        }

        addParticipant(call, callerId, socket.id);
        calls.set(call.id, call);
        chatCalls.set(chatId, call.id);
        for (const id of targets) {
            call.ringing.add(id);
            call.rung.add(id);
            call.notified.add(id);
        }
        call.ringTimer = timers.setTimeout(() => { stopRinging(call.id); }, ringTimeoutMs);

        socket.emit('call_ringing', { callId: call.id, chatId, type, group: true, ringing: targets.length, ringTimeoutMs });
        const sent = sendParticipants(call);
        roomUpdate(call, true);

        await logged('join bookkeeping', () => store.recordJoin(call.id, callerId));
        await logged('notice', () => store.postGroupNotice(io, call, groupStartedCode(type)));

        for (const id of targets) {
            // Someone who joined from the banner while the notice was being stored isn't rung
            if (!call.ringing.has(id)) continue;
            toUser(id).emit('call_invite', invitePayload(call, cards.get(id)));
            if (push && push.notifyIncomingGroupCall) push.notifyIncomingGroupCall(io, call, cards.get(id), id);
        }
        await sent;
        return call.id;
    }

    /**
     * Nobody rings for ever; the call itself goes on, and the banner stays
     */
    function stopRinging(callId) {
        const call = calls.get(callId);
        if (!call) return;
        call.ringTimer = null;
        for (const userId of call.ringing) toUser(userId).emit('call_timeout', { callId: call.id, group: true });
        call.ringing.clear();
    }

    // ----- Joining -----

    function refuse(socket, callId, error) {
        emitError(socket, 'call_join', error, { callId });
    }

    /**
     * Why someone with these block relations may not be in a room with these users, or null
     */
    function blockConflict({ blocked, blockedBy }, userIds) {
        if (userIds.some(id => blocked.has(id))) {
            return { code: 'BLOCKED', message: 'You blocked someone in this call. Unblock them to join.' };
        }
        if (userIds.some(id => blockedBy.has(id))) {
            return { code: 'BLOCKED', message: 'You can\'t join this call because of a block between you and someone in it.' };
        }
        return null;
    }

    async function join(socket, data) {
        const userId = socket.userId;
        const call = getCall(data && data.callId);
        if (!call || !call.isGroup) return refuse(socket, data && data.callId, notFound);

        const existing = call.participants.get(userId);
        if (existing) {
            if (existing.socket === socket.id) return sendParticipants(call);
            if (existing.socket) {
                return refuse(socket, call.id, { code: 'OTHER_DEVICE', message: 'You\'re already in this call on another device' });
            }
            return rebind(socket, call);
        }
        if (userCalls.has(userId)) {
            return refuse(socket, call.id, { code: 'ALREADY_IN_CALL', message: 'You\'re already in a call' });
        }
        if (call.participants.size + call.reserved.size >= call.max) {
            return refuse(socket, call.id, { code: 'CALL_FULL', message: `This call is full (${call.max} people at most)` });
        }

        // Held while the checks run: a place in the room, and the "one call at a time" rule
        const before = [...call.participants.keys(), ...call.reserved];
        call.reserved.add(userId);
        userCalls.set(userId, 'pending');
        let added = false;
        try {
            if (!await store.isChatMember(call.chatId, userId)) {
                return refuse(socket, call.id, { code: 'NOT_A_MEMBER', message: 'Access denied to this chat' });
            }
            const relations = await store.blockSets(userId);
            if (!calls.has(call.id)) return refuse(socket, call.id, notFound);
            if (userCalls.get(userId) !== 'pending') return undefined; // the socket went away meanwhile

            const conflict = blockConflict(relations, [...new Set([...before, ...call.participants.keys()])]);
            if (conflict) return refuse(socket, call.id, conflict);

            const offerTo = [...call.participants.keys()];
            addParticipant(call, userId, socket.id);
            added = true;

            const wasRinging = call.ringing.delete(userId);
            call.rung.delete(userId);
            if (wasRinging) toUser(userId).except(socket.id).emit('call_cancel', { callId: call.id, reason: 'answered_elsewhere', group: true });

            if (!call.answeredAt && call.joined.size > 1) {
                call.answeredAt = now();
                call.status = 'active';
                await logged('answered bookkeeping', () => store.markAnswered(call.id));
            }
            const sent = sendParticipants(call, { [userId]: offerTo });
            roomUpdate(call, true);
            await logged('join bookkeeping', () => store.recordJoin(call.id, userId));
            await sent;
            return call.id;
        } finally {
            call.reserved.delete(userId);
            if (!added) {
                if (userCalls.get(userId) === 'pending') userCalls.delete(userId);
                await endIfEmpty(call);
            }
        }
    }

    // ----- Leaving -----

    async function removeParticipant(call, userId) {
        if (!call.participants.delete(userId)) return;
        if (userCalls.get(userId) === call.id) userCalls.delete(userId);
        if (call.graceTimers[userId]) {
            timers.clearTimeout(call.graceTimers[userId]);
            delete call.graceTimers[userId];
        }
        await logged('leave bookkeeping', () => store.recordLeave(call.id, userId));

        if (!calls.has(call.id)) return;
        if (call.participants.size === 0 && call.reserved.size === 0) {
            await endCall(call);
            return;
        }
        roomUpdate(call, true);
        await sendParticipants(call);
    }

    async function leave(socket, data) {
        const call = getCall(data && data.callId);
        if (!call || !call.isGroup) return;
        const participant = call.participants.get(socket.userId);
        // Only the tab that is in the call can leave it
        if (!participant || participant.socket !== socket.id) return;
        await removeParticipant(call, socket.userId);
    }

    /**
     * Someone who may no longer be in the room: out of it, and no more ringing
     */
    async function evict(call, userId) {
        if (call.ringing.delete(userId)) {
            toUser(userId).emit('call_cancel', { callId: call.id, reason: 'cancelled', group: true });
        }
        call.rung.delete(userId);
        if (!call.participants.has(userId)) return;
        toUser(userId).emit('call_hangup', { callId: call.id, reason: 'removed', group: true });
        await removeParticipant(call, userId);
    }

    async function endIfEmpty(call) {
        if (calls.has(call.id) && call.participants.size === 0 && call.reserved.size === 0) await endCall(call);
    }

    async function endCall(call) {
        if (!calls.has(call.id)) return;
        calls.delete(call.id);
        if (chatCalls.get(call.chatId) === call.id) chatCalls.delete(call.chatId);
        if (call.ringTimer) timers.clearTimeout(call.ringTimer);
        call.ringTimer = null;

        for (const userId of call.ringing) toUser(userId).emit('call_cancel', { callId: call.id, reason: 'cancelled', group: true });
        call.ringing.clear();
        roomUpdate(call, false);

        const someoneElseCame = call.joined.size > 1;
        const status = someoneElseCame ? 'completed' : 'missed';
        const seconds = call.answeredAt ? (now() - call.answeredAt) / 1000 : 0;
        await logged('end bookkeeping', async () => {
            await store.markEnded(call.id, status, someoneElseCame ? 'hangup' : 'timeout');
            await store.postGroupNotice(io, call, groupEndedCode(call.type, status, seconds, call.joined));
        });

        for (const userId of new Set([...call.joined, ...call.notified])) {
            toUser(userId).emit('call_log_updated', { callId: call.id });
        }
        if (push && push.notifyMissedGroupCall) {
            for (const userId of call.rung) {
                const card = await logged('caller card', () => store.callerCard(userId, call.callerId));
                push.notifyMissedGroupCall(io, call, card, userId);
            }
        }
    }

    // ----- Dismiss -----

    /**
     * call_reject on a group call: stops this user's ringing, the call goes on without them
     */
    function dismiss(socket, call) {
        const userId = socket.userId;
        if (!call.ringing.delete(userId)) return;
        call.rung.delete(userId);
        toUser(userId).emit('call_cancel', { callId: call.id, reason: 'declined', group: true });
    }

    // ----- Signaling -----

    /**
     * The sender's place in this call, or null (answered with call_error)
     */
    function sender(socket, data, event) {
        const call = getCall(data && data.callId);
        const participant = call && call.isGroup ? call.participants.get(socket.userId) : null;
        if (!participant) {
            emitError(socket, event, { code: 'NOT_FOUND', message: 'This call is no longer available' }, { callId: data && data.callId });
            return null;
        }
        if (participant.socket !== socket.id) {
            emitError(socket, event, { code: 'OTHER_DEVICE', message: 'This call is on another device' }, { callId: call.id });
            return null;
        }
        return { call, participant };
    }

    /**
     * Still a member of the chat? Someone who isn't any more is taken out of the call.
     */
    async function stillMember(socket, call, event) {
        if (await store.isChatMember(call.chatId, socket.userId)) return true;
        emitError(socket, event, { code: 'NOT_A_MEMBER', message: 'Access denied to this chat' }, { callId: call.id });
        await evict(call, socket.userId);
        return false;
    }

    /**
     * To the one participant named by `to`. The membership check is async, so each sender's events
     * go through a queue: a restart's offer stays ahead of its candidates.
     */
    function relayTo(socket, data, event, buildPayload) {
        const { call, participant } = sender(socket, data, event) || {};
        if (!call) return undefined;
        const payload = buildPayload(call);
        if (!payload) return undefined;
        const to = toId(data.to);
        if (!to || to === socket.userId || !call.participants.has(to)) {
            emitError(socket, event, { code: 'NOT_IN_CALL', message: 'That person isn\'t in this call' }, { callId: call.id });
            return undefined;
        }
        participant.relays = participant.relays.then(async () => {
            if (!await stillMember(socket, call, event)) return;
            const target = call.participants.get(to);
            if (target && target.socket) { // otherwise: reconnecting, and ICE restarts once it's back
                toSocket(target.socket).emit(event, { callId: call.id, from: socket.userId, ...payload });
            }
        }).catch(error => console.error(`${event} error:`, error));
        return participant.relays;
    }

    function relayDescription(socket, data, event, expectedType) {
        return relayTo(socket, data, event, (call) => {
            const sdp = cleanDescription(data.sdp, expectedType);
            if (!sdp) emitError(socket, event, { code: 'INVALID', message: 'Invalid session description' }, { callId: call.id });
            return sdp && { sdp, iceRestart: !!data.iceRestart };
        });
    }

    function offer(socket, data) {
        return relayDescription(socket, data, 'call_offer', 'offer');
    }

    function answer(socket, data) {
        return relayDescription(socket, data, 'call_answer', 'answer');
    }

    function iceCandidate(socket, data) {
        return relayTo(socket, data, 'call_ice_candidate', () => {
            const candidate = cleanCandidate(data.candidate);
            return candidate === undefined ? null : { candidate }; // malformed: dropped
        });
    }

    /**
     * Mute, camera and screen share, as the others should show them
     */
    async function mediaState(socket, data) {
        const { call, participant } = sender(socket, data, 'call_media_state') || {};
        if (!call) return;
        if (!await stillMember(socket, call, 'call_media_state')) return;
        participant.muted = data.muted === true;
        participant.cameraOff = data.cameraOff === true;
        participant.screen = data.screen === true;
        await sendParticipants(call);
    }

    // ----- Reconnecting -----

    /**
     * A tab reconnected and says it was in this call: bind its new socket
     */
    async function rebind(socket, call) {
        const userId = socket.userId;
        const participant = call.participants.get(userId);
        if (!participant) {
            socket.emit('call_sync', { callId: call.id, active: false, group: true });
            return;
        }
        if (participant.socket && participant.socket !== socket.id) {
            // Still connected elsewhere: this is another tab, not the one in the call
            socket.emit('call_sync', { callId: call.id, active: false, otherDevice: true, group: true });
            return;
        }
        if (!await stillMember(socket, call, 'call_sync')) return;
        participant.socket = socket.id;
        if (call.graceTimers[userId]) {
            timers.clearTimeout(call.graceTimers[userId]);
            delete call.graceTimers[userId];
        }
        socket.emit('call_sync', { callId: call.id, active: true, group: true });
        await sendParticipants(call);
        for (const other of call.participants.values()) {
            if (other.userId !== userId && other.socket) {
                toSocket(other.socket).emit('call_peer_reconnected', { callId: call.id, from: userId });
            }
        }
    }

    /**
     * A tab (re)connected with no call of its own: bring back any group call ringing for this user
     */
    async function resendInvites(socket) {
        for (const call of [...calls.values()]) {
            if (call.isGroup && call.ringing.has(socket.userId)) {
                socket.emit('call_invite', invitePayload(call, await cardFor(call, socket.userId, call.callerId)));
            }
        }
    }

    function socketGone(socket, call) {
        const userId = socket.userId;
        const participant = call.participants.get(userId);
        if (!participant || participant.socket !== socket.id) return;
        participant.socket = null;
        call.graceTimers[userId] = timers.setTimeout(async () => {
            delete call.graceTimers[userId];
            if (!calls.has(call.id) || call.participants.get(userId) !== participant || participant.socket) return;
            toUser(userId).emit('call_hangup', { callId: call.id, reason: 'connection_lost', group: true });
            await removeParticipant(call, userId);
        }, reconnectGraceMs);
    }

    // ----- Called from the REST side -----

    /**
     * A member was removed from the chat (or left it)
     */
    async function memberRemoved(userId, chatId) {
        const call = calls.get(chatCalls.get(toId(chatId)));
        if (call) await evict(call, toId(userId));
    }

    /**
     * blockerId just blocked blockedId: if they share a room the blocked person goes
     */
    async function userBlocked(blockerId, blockedId) {
        const current = userCalls.get(toId(blockerId));
        const call = typeof current === 'number' ? calls.get(current) : null;
        if (call && call.isGroup) await evict(call, toId(blockedId));
    }

    /**
     * What the banner shows this viewer, or null. The caller has checked membership.
     */
    async function activeCallForChat(chatId, viewerId) {
        const call = calls.get(chatCalls.get(toId(chatId)));
        if (!call) return null;
        return {
            callId: call.id,
            chatId: call.chatId,
            type: call.type,
            max: call.max,
            participants: await participantList(call, viewerId)
        };
    }

    function isLive(callId) {
        return calls.has(toId(callId));
    }

    return {
        start, join, leave, dismiss, offer, answer, iceCandidate, mediaState, rebind, resendInvites, socketGone,
        memberRemoved, userBlocked, activeCallForChat, isLive, stopRinging
    };
}

module.exports = { groupStore, groupStartedCode, groupEndedCode, createGroupCalls };
