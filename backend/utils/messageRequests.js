/**
 * Message requests: a direct chat started by someone who shares no (accepted) chat with the other
 * person lands in that person's Requests section. Until they accept:
 *   - they can read it but not reply or react (the server refuses, see checkRequestReply)
 *   - their reads and typing are not sent to the requester (utils/chatState.js, server.js)
 *   - the two don't count as contacts for privacy settings (utils/privacy.js)
 * Delete hides the chat for the recipient without telling the requester; Block also blocks them.
 * The recipient starting a chat with the requester later counts as accepting.
 */

const { executeQuery, queryOne, dbType } = require('../config/database');

const STATUS = Object.freeze({
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    DELETED: 'deleted',
    BLOCKED: 'blocked'
});

// Requests the recipient hasn't accepted: replying, receipts and typing stay off
const UNACCEPTED = [STATUS.PENDING, STATUS.DELETED, STATUS.BLOCKED];

const REQUEST_PENDING = {
    status: 403,
    code: 'REQUEST_PENDING',
    message: 'Accept the message request to reply.'
};

async function createRequest(chatId, requesterId, recipientId) {
    await executeQuery(
        'INSERT INTO message_requests (chat_id, requester_id, recipient_id, status) VALUES (?, ?, ?, ?)',
        [chatId, requesterId, recipientId, STATUS.PENDING]
    );
}

async function getRequest(chatId) {
    const row = await queryOne(
        'SELECT chat_id, requester_id, recipient_id, status FROM message_requests WHERE chat_id = ?',
        [chatId]
    );
    if (!row) return null;
    return {
        chatId: Number(row.chat_id),
        requesterId: Number(row.requester_id),
        recipientId: Number(row.recipient_id),
        status: row.status
    };
}

/**
 * Pending requests among these chats, by chat id
 */
async function getPendingRequests(chatIds) {
    const byChat = new Map();
    const ids = [...new Set(chatIds.map(Number))].filter(Number.isInteger);
    if (ids.length === 0) return byChat;
    const rows = await executeQuery(
        `SELECT chat_id, requester_id, recipient_id, status FROM message_requests WHERE status = ? AND chat_id IN (${ids.map(() => '?').join(', ')})`,
        [STATUS.PENDING, ...ids]
    );
    for (const row of rows) {
        byChat.set(Number(row.chat_id), {
            chatId: Number(row.chat_id),
            requesterId: Number(row.requester_id),
            recipientId: Number(row.recipient_id),
            status: row.status
        });
    }
    return byChat;
}

/**
 * The request as one side sees it: { status: 'pending', incoming } or null once it's accepted.
 * The requester never learns that the recipient deleted the request.
 */
function describeRequest(request, userId) {
    if (!request) return null;
    const incoming = request.recipientId === Number(userId);
    if (request.status === STATUS.ACCEPTED) return null;
    if (!incoming) return { status: STATUS.PENDING, incoming: false };
    return { status: request.status, incoming: true };
}

/**
 * Is userId the recipient of a request in this chat they haven't accepted?
 */
async function isAwaitingAcceptance(chatId, userId) {
    const row = await queryOne(
        `SELECT chat_id FROM message_requests WHERE chat_id = ? AND recipient_id = ? AND status IN (${UNACCEPTED.map(() => '?').join(', ')})`,
        [chatId, userId, ...UNACCEPTED]
    );
    return !!row;
}

/**
 * Error for a recipient who tries to post or react before accepting, else null
 */
async function checkRequestReply(chatId, userId) {
    return (await isAwaitingAcceptance(chatId, userId)) ? REQUEST_PENDING : null;
}

/**
 * Hide a chat from one user's list (same row as "Delete chat")
 */
async function hideChatFor(chatId, userId) {
    if (dbType === 'postgresql') {
        await executeQuery(
            'INSERT INTO deleted_chats (chat_id, user_id) VALUES (?, ?) ON CONFLICT (chat_id, user_id) DO UPDATE SET deleted_at = CURRENT_TIMESTAMP',
            [chatId, userId]
        );
    } else {
        await executeQuery(
            'INSERT INTO deleted_chats (chat_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at = CURRENT_TIMESTAMP',
            [chatId, userId]
        );
    }
}

/**
 * The recipient answers a pending request: 'accepted' | 'deleted' | 'blocked'.
 * One conditional UPDATE, so two tabs can't both decide.
 * @returns {Promise<{ request } | { error }>}
 */
async function decideRequest(chatId, userId, decision) {
    const request = await getRequest(chatId);
    if (!request || request.recipientId !== Number(userId)) {
        return { error: { status: 404, message: 'Message request not found' } };
    }
    if (request.status !== STATUS.PENDING) {
        return { error: { status: 409, message: 'This request was already handled' } };
    }

    const sql = 'UPDATE message_requests SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND recipient_id = ? AND status = ?';
    const params = [decision, chatId, userId, STATUS.PENDING];
    const updated = dbType === 'postgresql'
        ? (await executeQuery(`${sql} RETURNING chat_id`, params)).length === 1
        : (await executeQuery(sql, params)).affectedRows === 1;
    if (!updated) {
        return { error: { status: 409, message: 'This request was already handled' } };
    }

    if (decision !== STATUS.ACCEPTED) {
        await hideChatFor(chatId, userId);
    }
    return { request: { ...request, status: decision } };
}

/**
 * The recipient opened a direct chat with the requester themselves: that accepts the request and
 * brings a deleted request back into their list.
 * @returns {Promise<boolean>} true if a request was accepted
 */
async function acceptByRecipientContact(chatId, userId) {
    if (!(await isAwaitingAcceptance(chatId, userId))) return false;
    await executeQuery(
        'UPDATE message_requests SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND recipient_id = ?',
        [STATUS.ACCEPTED, chatId, userId]
    );
    await executeQuery('DELETE FROM deleted_chats WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    return true;
}

module.exports = {
    STATUS,
    REQUEST_PENDING,
    createRequest,
    getRequest,
    getPendingRequests,
    describeRequest,
    isAwaitingAcceptance,
    checkRequestReply,
    hideChatFor,
    decideRequest,
    acceptByRecipientContact
};
