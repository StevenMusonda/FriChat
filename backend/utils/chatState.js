/**
 * Per-user chat state: read position, mute and archive (all stored on group_members)
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const { readReceiptsEnabled, receiptlessMemberRooms } = require('./privacy');
const { isAwaitingAcceptance } = require('./messageRequests');

// Stored in muted_until for "mute always"
const MUTE_FOREVER = '9999-12-31 00:00:00';

const MUTE_DURATIONS = {
    '8h': { pg: "INTERVAL '8 hours'", mysql: 'INTERVAL 8 HOUR' },
    '1w': { pg: "INTERVAL '7 days'", mysql: 'INTERVAL 7 DAY' }
};

/**
 * Count messages from other people after the user's read position
 */
async function getUnreadCount(chatId, userId) {
    const row = await queryOne(`
        SELECT COUNT(*) AS count
        FROM messages m
        JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
        WHERE m.chat_id = ?
        AND m.id > COALESCE(gm.last_read_message_id, 0)
        AND m.sender_id <> ?
        AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
    `, [userId, chatId, userId]);
    return row ? parseInt(row.count) || 0 : 0;
}

/**
 * Unread messages that mention the user (the sidebar's @ badge; stays until the message is read)
 */
async function getUnreadMentionCount(chatId, userId) {
    const row = await queryOne(`
        SELECT COUNT(*) AS count
        FROM message_mentions mm
        JOIN messages m ON m.id = mm.message_id
        JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = mm.user_id
        WHERE mm.user_id = ?
        AND m.chat_id = ?
        AND m.id > COALESCE(gm.last_read_message_id, 0)
        AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
    `, [userId, chatId]);
    return row ? parseInt(row.count) || 0 : 0;
}

/**
 * Does this user's reading show up as read receipts in this chat? Not when they turned read receipts
 * off, and not while the chat is a message request they haven't accepted.
 */
async function sendsReadReceipts(chatId, userId) {
    if (!(await readReceiptsEnabled(userId))) return false;
    return !(await isAwaitingAcceptance(chatId, userId));
}

/**
 * Send a read-receipt event to the chat, except to members who turned read receipts off
 */
async function emitToReceiptViewers(io, chatId, event, payload) {
    const hidden = await receiptlessMemberRooms(chatId);
    const target = io.to(`chat_${chatId}`);
    (hidden.length > 0 ? target.except(hidden) : target).emit(event, payload);
}

/**
 * Move the user's read position forward to messageId (or the newest message when omitted).
 * Never moves it backwards. Tells the user's other tabs, and tells the chat when
 * messages became read so senders can update their receipts (unless the reader's receipts are off).
 * Returns null if the user isn't a member.
 */
async function markChatRead(io, chatId, userId, messageId = null) {
    const membership = await queryOne(
        'SELECT last_read_message_id FROM group_members WHERE chat_id = ? AND user_id = ?',
        [chatId, userId]
    );
    if (!membership) return null;

    const previous = membership.last_read_message_id || 0;

    let target;
    if (messageId) {
        const message = await queryOne(
            'SELECT id FROM messages WHERE id = ? AND chat_id = ?',
            [messageId, chatId]
        );
        target = message ? message.id : null;
    } else {
        const newest = await queryOne('SELECT MAX(id) AS id FROM messages WHERE chat_id = ?', [chatId]);
        target = newest ? newest.id : null;
    }

    const advanced = !!target && target > previous;
    const receipts = advanced && await sendsReadReceipts(chatId, userId);

    if (advanced) {
        await executeQuery(`
            UPDATE group_members SET last_read_message_id = ?
            WHERE chat_id = ? AND user_id = ?
            AND (last_read_message_id IS NULL OR last_read_message_id < ?)
        `, [target, chatId, userId, target]);

        // Keep sender-facing read receipts (messages.status) in step
        if (receipts) {
            await executeQuery(`
                UPDATE messages SET status = 'read'
                WHERE chat_id = ? AND id > ? AND id <= ? AND sender_id <> ? AND status <> 'read'
            `, [chatId, previous, target, userId]);
        }
    }

    const state = {
        chatId: parseInt(chatId),
        lastReadMessageId: advanced ? target : (membership.last_read_message_id || null),
        unreadCount: await getUnreadCount(chatId, userId),
        unreadMentionCount: await getUnreadMentionCount(chatId, userId)
    };

    if (io) {
        io.to(`user_${userId}`).emit('read_position_updated', state);
        if (receipts) {
            await emitToReceiptViewers(io, chatId, 'messages_read', {
                chatId: state.chatId,
                readerId: userId,
                upToMessageId: target
            });
        }
    }

    return state;
}

/**
 * Send read receipts for everything the user has already read in this chat (after they accept a
 * message request, whose reads were held back until then)
 */
async function publishReadReceipts(io, chatId, userId) {
    if (!(await sendsReadReceipts(chatId, userId))) return;
    const membership = await queryOne(
        'SELECT last_read_message_id FROM group_members WHERE chat_id = ? AND user_id = ?',
        [chatId, userId]
    );
    const upTo = membership && membership.last_read_message_id;
    if (!upTo) return;

    await executeQuery(`
        UPDATE messages SET status = 'read'
        WHERE chat_id = ? AND id <= ? AND sender_id <> ? AND status <> 'read'
    `, [chatId, upTo, userId]);
    if (io) {
        await emitToReceiptViewers(io, chatId, 'messages_read', { chatId: Number(chatId), readerId: userId, upToMessageId: upTo });
    }
}

const STATUS_RANK = { sent: 0, delivered: 1, read: 2 };

/**
 * A member reports one message as 'delivered' or 'read' (REST and the message_status socket event).
 * Only other people's messages, only forwards, and 'read' becomes 'delivered' when the reader
 * doesn't send read receipts in this chat.
 * @returns {Promise<{ error } | { messageId, chatId, status, changed }>}
 */
async function updateMessageStatus(io, messageId, userId, status) {
    if (status !== 'delivered' && status !== 'read') {
        return { error: { status: 400, message: "status must be 'delivered' or 'read'" } };
    }
    const message = await queryOne(`
        SELECT m.id, m.chat_id, m.sender_id, m.status
        FROM messages m
        JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
        WHERE m.id = ?
    `, [userId, messageId]);
    if (!message) {
        return { error: { status: 404, message: 'Message not found or access denied' } };
    }

    let next = status;
    if (next === 'read' && !(await sendsReadReceipts(message.chat_id, userId))) next = 'delivered';

    const result = { messageId: Number(message.id), chatId: Number(message.chat_id), status: message.status, changed: false };
    if (Number(message.sender_id) === Number(userId) || STATUS_RANK[next] <= (STATUS_RANK[message.status] || 0)) {
        return result;
    }

    await executeQuery('UPDATE messages SET status = ? WHERE id = ?', [next, message.id]);
    if (io) {
        const payload = { messageId: result.messageId, status: next, userId };
        if (next === 'read') {
            await emitToReceiptViewers(io, message.chat_id, 'message_status_update', payload);
        } else {
            io.to(`chat_${message.chat_id}`).emit('message_status_update', payload);
        }
    }
    return { ...result, status: next, changed: true };
}

/**
 * Bookkeeping after a message is stored: un-archive the chat for members who
 * haven't muted it, and count the message as read by its sender.
 */
async function recordNewMessage(io, chatId, senderId, messageId) {
    await executeQuery(`
        UPDATE group_members SET archived_at = NULL
        WHERE chat_id = ? AND archived_at IS NOT NULL
        AND (muted_until IS NULL OR muted_until <= CURRENT_TIMESTAMP)
    `, [chatId]);

    await markChatRead(io, chatId, senderId, messageId);
}

/**
 * Current mute/archive state for one member
 */
async function getChatSettings(chatId, userId) {
    const row = await queryOne(`
        SELECT
            muted_until,
            CASE WHEN muted_until IS NOT NULL AND muted_until > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_muted,
            archived_at,
            mentions_only
        FROM group_members
        WHERE chat_id = ? AND user_id = ?
    `, [chatId, userId]);
    if (!row) return null;

    return {
        chatId: parseInt(chatId),
        mutedUntil: row.muted_until,
        isMuted: !!parseInt(row.is_muted),
        archivedAt: row.archived_at,
        mentionsOnly: row.mentions_only === true || row.mentions_only === 1 || row.mentions_only === '1'
    };
}

/**
 * duration: '8h' | '1w' | 'always' | 'off'
 */
async function setMute(chatId, userId, duration) {
    if (duration === 'off') {
        await executeQuery(
            'UPDATE group_members SET muted_until = NULL WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );
    } else if (duration === 'always') {
        await executeQuery(
            'UPDATE group_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?',
            [MUTE_FOREVER, chatId, userId]
        );
    } else {
        // Computed in SQL so it compares cleanly with CURRENT_TIMESTAMP regardless of Node's timezone
        const interval = MUTE_DURATIONS[duration][dbType === 'postgresql' ? 'pg' : 'mysql'];
        await executeQuery(
            `UPDATE group_members SET muted_until = CURRENT_TIMESTAMP + ${interval} WHERE chat_id = ? AND user_id = ?`,
            [chatId, userId]
        );
    }
}

async function setArchived(chatId, userId, archived) {
    await executeQuery(
        `UPDATE group_members SET archived_at = ${archived ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE chat_id = ? AND user_id = ?`,
        [chatId, userId]
    );
}

/**
 * Push only for @mentions in this chat (and let mentions through a mute)
 */
async function setMentionsOnly(chatId, userId, enabled) {
    await executeQuery(
        'UPDATE group_members SET mentions_only = ? WHERE chat_id = ? AND user_id = ?',
        [!!enabled, chatId, userId]
    );
}

module.exports = {
    MUTE_DURATIONS,
    getUnreadCount,
    getUnreadMentionCount,
    setMentionsOnly,
    markChatRead,
    sendsReadReceipts,
    publishReadReceipts,
    updateMessageStatus,
    recordNewMessage,
    getChatSettings,
    setMute,
    setArchived
};
