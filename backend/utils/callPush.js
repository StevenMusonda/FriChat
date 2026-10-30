/**
 * Push notifications for calls (phase 11), through push.notifyUser: only when the user has no visible
 * FriChat tab, never during do-not-disturb, never throws.
 *
 * An incoming call shows "Incoming video call / Alice is calling"; clicking it opens the chat, and the
 * page asks the server (call_sync) for the ringing call, which brings up the Accept/Decline modal.
 * When the call is missed the same notification (tag call-<id>) is replaced by "Missed video call".
 */

const { notifyUser, decodeEntities } = require('./push');
const { RING_TIMEOUT_MS } = require('../config/calls');

function callerName(caller) {
    return decodeEntities(String((caller && (caller.fullName || caller.username)) || 'Someone'));
}

function typeLabel(type) {
    return type === 'video' ? 'video' : 'voice';
}

function notifyIncomingCall(io, call, caller) {
    return notifyUser(io, call.calleeId, {
        type: 'call',
        callId: call.id,
        chatId: call.chatId,
        title: `Incoming ${typeLabel(call.type)} call`,
        body: `${callerName(caller)} is calling you`,
        tag: `call-${call.id}`,
        url: `chat.html?chat=${call.chatId}&call=${call.id}`,
        // A ring that arrives after the call timed out is useless
        ttl: Math.ceil(RING_TIMEOUT_MS / 1000)
    });
}

function notifyMissedCall(io, call, caller) {
    return notifyUser(io, call.calleeId, {
        type: 'missed_call',
        callId: call.id,
        chatId: call.chatId,
        title: `Missed ${typeLabel(call.type)} call`,
        body: callerName(caller),
        tag: `call-${call.id}`,
        url: `chat.html?chat=${call.chatId}`
    });
}

module.exports = { notifyIncomingCall, notifyMissedCall };
