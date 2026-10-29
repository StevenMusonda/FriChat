/**
 * Message Request Controller
 * The recipient of a message request accepts it, deletes it, or blocks the sender
 * (reporting comes in a later phase). Only the recipient can do any of this.
 */

const requests = require('../utils/messageRequests');
const blocks = require('../utils/blocks');
const { emitPresenceChange } = require('./blockController');
const { publishReadReceipts } = require('../utils/chatState');

function sendError(res, error) {
    return res.status(error.status).json({ success: false, message: error.message });
}

/**
 * Shared flow for the three decisions
 */
async function decide(req, res, decision) {
    const chatId = Number(req.params.chatId);
    const userId = Number(req.user.id);

    const result = await requests.decideRequest(chatId, userId, decision);
    if (result.error) return sendError(res, result.error);

    const { requesterId } = result.request;

    if (decision === requests.STATUS.BLOCKED && (await blocks.blockUser(userId, requesterId))) {
        await emitPresenceChange(req.io, userId, requesterId, true);
        if (req.io) req.io.to(`user_${userId}`).emit('block_updated', { userId: requesterId, blocked: true });
    }

    // Reads held back while it was a request now show as read receipts (if the recipient shares them)
    if (decision === requests.STATUS.ACCEPTED) {
        await publishReadReceipts(req.io, chatId, userId);
    }

    if (req.io) {
        // The recipient's tabs move the chat out of Requests (or drop it)
        req.io.to(`user_${userId}`).emit('message_request_updated', { chatId, status: decision });
        // The requester only learns about an acceptance, never about a delete
        if (decision === requests.STATUS.ACCEPTED) {
            req.io.to(`user_${requesterId}`).emit('message_request_updated', { chatId, status: decision });
        }
    }

    return res.json({ success: true, data: { chatId, status: decision } });
}

function handler(decision, label) {
    return async (req, res) => {
        try {
            await decide(req, res, decision);
        } catch (error) {
            console.error(`${label} message request error:`, error);
            res.status(500).json({ success: false, message: 'Failed to update the message request' });
        }
    };
}

module.exports = {
    acceptRequest: handler(requests.STATUS.ACCEPTED, 'Accept'),
    deleteRequest: handler(requests.STATUS.DELETED, 'Delete'),
    blockRequest: handler(requests.STATUS.BLOCKED, 'Block')
};
