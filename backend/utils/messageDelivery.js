/**
 * Store a new message and deliver it the way every send path does: @mentions, chat timestamp,
 * un-archive + sender read position, new_message to the chat room, Web Push to members who aren't
 * watching, and the link preview. Used by the scheduler (scheduled sends) and by poll creation.
 *
 * Callers check the rules first (checkCanPost, reply target); this only does the delivery.
 */

const { executeQuery, insertAndGetId } = require('../config/database');
const { recordNewMessage } = require('./chatState');
const { notifyNewMessage } = require('./push');
const { saveMentions } = require('./mentions');
const { attachLinkPreview } = require('./linkPreview');
const { getMessageById } = require('./messageQueries');
const { chatExpiresAtSql } = require('./timeSql');

/**
 * @param {Object} io - Socket.IO server (may be null in scripts)
 * @param {Object} options
 *   chatId, senderId, messageType ('text' | 'poll'), content, replyToMessageId
 *   afterInsert(messageId) - rows that belong to the message (e.g. the poll); if it throws, the message is removed
 *   decorate(message) - adds fields to the broadcast copy (e.g. message.poll)
 * @returns {Promise<Object|null>} the message as clients receive it
 */
async function deliverNewMessage(io, { chatId, senderId, messageType = 'text', content = null, replyToMessageId = null, afterInsert, decorate }) {
    // expires_at follows the chat's disappearing-messages timer at the moment it's actually sent
    const messageId = await insertAndGetId(
        `INSERT INTO messages (chat_id, sender_id, message_type, content, reply_to_message_id, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ${chatExpiresAtSql()})`,
        [chatId, senderId, messageType, content, replyToMessageId, 'sent', chatId]
    );

    if (afterInsert) {
        try {
            await afterInsert(messageId);
        } catch (error) {
            await executeQuery('DELETE FROM messages WHERE id = ?', [messageId]);
            throw error;
        }
    }

    // @mentions of group members (before reading the message back, so it carries them)
    if (messageType === 'text') {
        await saveMentions(chatId, messageId, senderId, content);
    }

    await executeQuery('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [chatId]);

    // Un-archive for members who haven't muted it; sender has now read up to here
    await recordNewMessage(io, chatId, senderId, messageId);

    const message = await getMessageById(messageId);
    if (!message) return null;
    if (decorate) await decorate(message);

    if (io) io.to(`chat_${chatId}`).emit('new_message', message);

    // Push to members who aren't watching (not awaited - never delays or fails the send)
    notifyNewMessage(io, message);

    // Preview card for the first link, broadcast as message_link_preview when ready (not awaited)
    if (messageType === 'text') attachLinkPreview(io, message);

    return message;
}

module.exports = { deliverNewMessage };
