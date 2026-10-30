/**
 * Disappearing messages: a per-chat timer (chats.disappearing_seconds) and the sweep that deletes
 * expired messages.
 *
 * Messages sent while the timer is on get expires_at = now + timer (timeSql.chatExpiresAtSql, used in
 * every insert); messages sent before a change keep what they had. The scheduler calls
 * deleteExpiredMessages each tick: the rows go (reactions, stars, mentions, pins, polls and plays
 * cascade; replies keep an "Original message deleted" quote), their files go from the database and the
 * disk once no forwarded copy uses them, and open clients drop them live (messages_expired).
 *
 * Who may change it: either person in a direct chat (not while a block or an unaccepted message
 * request stands), only admins in a group. Each change posts a system message to the chat.
 */

const { executeQuery, queryOne, insertAndGetId } = require('../config/database');
const { DISAPPEARING_DURATIONS, EXPIRED_BATCH_SIZE } = require('../config/messages');
const { getMembership } = require('./groups');
const { checkDirectChatBlock } = require('./blocks');
const { checkRequestReply } = require('./messageRequests');
const { recordNewMessage } = require('./chatState');
const { getMessageById } = require('./messageQueries');
const { deleteOrphanedFiles } = require('./uploads');

// Content of the system message that announces a change: "disappearing:<seconds>" (0 = off).
// Clients turn the code into text, so nothing user-written is ever in a system message.
const SYSTEM_CODE_PREFIX = 'disappearing:';

function isValidTimer(seconds) {
    return DISAPPEARING_DURATIONS.includes(Number(seconds));
}

/**
 * The chat's timer in seconds (0 = off)
 */
async function getTimer(chatId) {
    const chat = await queryOne('SELECT disappearing_seconds FROM chats WHERE id = ?', [chatId]);
    return chat ? (parseInt(chat.disappearing_seconds) || 0) : 0;
}

/**
 * Why this user can't change the chat's timer, or null
 * @returns {Promise<null | { status, message, code? }>}
 */
async function checkCanChangeTimer(chatId, userId) {
    const membership = await getMembership(chatId, userId);
    if (!membership) return { status: 403, code: 'NOT_A_MEMBER', message: 'Access denied to this chat' };

    if (membership.chat_type === 'group') {
        if (membership.role !== 'admin') {
            return { status: 403, code: 'ADMIN_ONLY', message: 'Only group admins can change disappearing messages' };
        }
        return null;
    }

    // The change is announced in the chat, so it follows the same rules as sending a message
    return (await checkDirectChatBlock(chatId, userId)) || (await checkRequestReply(chatId, userId));
}

/**
 * Set the timer and announce it in the chat.
 * @returns {Promise<{ error } | { seconds, changed: boolean, message?: Object }>}
 */
async function setTimer(io, chatId, userId, seconds) {
    seconds = Number(seconds);
    if (!isValidTimer(seconds)) {
        return { error: { status: 400, message: 'Pick off, 24 hours, 7 days or 90 days' } };
    }

    const error = await checkCanChangeTimer(chatId, userId);
    if (error) return { error };

    // Same value again: nothing to announce
    if (await getTimer(chatId) === seconds) return { seconds, changed: false };

    await executeQuery(
        'UPDATE chats SET disappearing_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [seconds > 0 ? seconds : null, chatId]
    );

    // The notice itself never expires: it is how people learn the chat's messages do
    const messageId = await insertAndGetId(
        'INSERT INTO messages (chat_id, sender_id, message_type, content, status) VALUES (?, ?, ?, ?, ?)',
        [chatId, userId, 'system', `${SYSTEM_CODE_PREFIX}${seconds}`, 'sent']
    );

    // The person who changed it has read up to here; the chat comes back for members who archived it
    await recordNewMessage(io, chatId, userId, messageId);

    const message = await getMessageById(messageId);
    if (io) {
        io.to(`chat_${chatId}`).emit('chat_disappearing_updated', {
            chatId: Number(chatId),
            seconds,
            changedBy: Number(userId)
        });
        if (message) io.to(`chat_${chatId}`).emit('new_message', message);
    }
    // No push: a settings notice isn't worth waking a phone for

    return { seconds, changed: true, message };
}

/**
 * Scheduler tick: delete messages whose time is up, then their files, and tell open clients.
 * @returns {Promise<{ deleted: number, filesRemoved: number }>}
 */
async function deleteExpiredMessages(io) {
    const rows = await executeQuery(`
        SELECT id, chat_id, file_id
        FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
        ORDER BY expires_at, id
        LIMIT ${parseInt(EXPIRED_BATCH_SIZE)}
    `);
    if (rows.length === 0) return { deleted: 0, filesRemoved: 0 };

    const ids = rows.map(row => Number(row.id));
    await executeQuery(
        `DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids
    );

    // Files only once no other message (a forwarded copy) uses them
    const filesRemoved = await deleteOrphanedFiles(rows.map(row => row.file_id).filter(Boolean));

    if (io) {
        const byChat = new Map();
        for (const row of rows) {
            const chatId = Number(row.chat_id);
            if (!byChat.has(chatId)) byChat.set(chatId, []);
            byChat.get(chatId).push(Number(row.id));
        }
        for (const [chatId, messageIds] of byChat) {
            io.to(`chat_${chatId}`).emit('messages_expired', { chatId, messageIds });
        }
    }

    console.log(`Disappearing messages: deleted ${rows.length} expired message(s), ${filesRemoved} file(s)`);
    return { deleted: rows.length, filesRemoved };
}

module.exports = {
    SYSTEM_CODE_PREFIX,
    isValidTimer,
    getTimer,
    checkCanChangeTimer,
    setTimer,
    deleteExpiredMessages
};
