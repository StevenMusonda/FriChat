/**
 * Per-user chat state: read position, mute and archive (all stored on group_members)
 */

const { executeQuery, queryOne, dbType } = require('../config/database');

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
 * Move the user's read position forward to messageId (or the newest message when omitted).
 * Never moves it backwards. Tells the user's other tabs, and tells the chat when
 * messages became read so senders can update their receipts.
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

    if (advanced) {
        await executeQuery(`
            UPDATE group_members SET last_read_message_id = ?
            WHERE chat_id = ? AND user_id = ?
            AND (last_read_message_id IS NULL OR last_read_message_id < ?)
        `, [target, chatId, userId, target]);

        // Keep sender-facing read receipts (messages.status) in step
        await executeQuery(`
            UPDATE messages SET status = 'read'
            WHERE chat_id = ? AND id > ? AND id <= ? AND sender_id <> ? AND status <> 'read'
        `, [chatId, previous, target, userId]);
    }

    const state = {
        chatId: parseInt(chatId),
        lastReadMessageId: advanced ? target : (membership.last_read_message_id || null),
        unreadCount: await getUnreadCount(chatId, userId),
        unreadMentionCount: await getUnreadMentionCount(chatId, userId)
    };

    if (io) {
        io.to(`user_${userId}`).emit('read_position_updated', state);
        if (advanced) {
            io.to(`chat_${chatId}`).emit('messages_read', {
                chatId: state.chatId,
                readerId: userId,
                upToMessageId: target
            });
        }
    }

    return state;
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
    recordNewMessage,
    getChatSettings,
    setMute,
    setArchived
};
