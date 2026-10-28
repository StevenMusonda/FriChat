/**
 * Message reactions - one rule for the REST routes and the socket events:
 * a user has at most one reaction per message. Reacting with a different emoji
 * replaces it, reacting with the same emoji removes it.
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const { checkDirectChatBlock } = require('./blocks');

// message_reactions.emoji is VARCHAR(10), which both databases count in characters (code points)
const MAX_EMOJI_CHARS = 10;

/**
 * True for a short, non-blank string with no whitespace or control characters
 */
function isValidEmoji(emoji) {
    if (typeof emoji !== 'string' || emoji.length === 0) return false;
    if ([...emoji].length > MAX_EMOJI_CHARS) return false;
    return !/[\s\p{Cc}]/u.test(emoji);
}

/**
 * The message's chat, or null when it doesn't exist or the user isn't a member of its chat
 */
async function getMessageChatForMember(messageId, userId) {
    const message = await queryOne(`
        SELECT m.id, m.chat_id
        FROM messages m
        JOIN group_members gm ON m.chat_id = gm.chat_id
        WHERE m.id = ? AND gm.user_id = ?
    `, [messageId, userId]);
    return message ? message.chat_id : null;
}

/**
 * Apply a reaction with the toggle/replace rule
 * @returns {{error: string}|{chatId: number, messageId: number, userId: number, action: 'added'|'replaced'|'removed', emoji: string, previousEmoji: string|null}}
 */
async function toggleReaction(messageId, userId, emoji) {
    messageId = Number(messageId);
    if (!Number.isInteger(messageId) || messageId < 1) return { error: 'Invalid message ID' };
    if (!isValidEmoji(emoji)) return { error: 'Invalid emoji' };

    const chatId = await getMessageChatForMember(messageId, userId);
    if (!chatId) return { error: 'Message not found or access denied', notFound: true };

    // Reacting reaches the other person, so a block in a direct chat stops it (removing your own still works)
    const blockError = await checkDirectChatBlock(chatId, userId);
    if (blockError) return { error: blockError.message, blocked: true };

    const existing = await queryOne(
        'SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?',
        [messageId, userId]
    );
    const result = { chatId, messageId, userId, emoji, previousEmoji: existing ? existing.emoji : null };

    if (existing && existing.emoji === emoji) {
        // Matching the emoji too, so a replace that raced in isn't wiped
        await executeQuery(
            'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
            [messageId, userId, emoji]
        );
        return { ...result, action: 'removed', previousEmoji: null };
    }

    if (existing) {
        await executeQuery(
            'UPDATE message_reactions SET emoji = ? WHERE message_id = ? AND user_id = ?',
            [emoji, messageId, userId]
        );
        return { ...result, action: 'replaced' };
    }

    // Upsert on the (message_id, user_id) key, in case another tab reacted in between
    if (dbType === 'postgresql') {
        await executeQuery(
            'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji',
            [messageId, userId, emoji]
        );
    } else {
        await executeQuery(
            'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = VALUES(emoji)',
            [messageId, userId, emoji]
        );
    }
    return { ...result, action: 'added' };
}

/**
 * Remove the user's reaction (only if it is still `emoji`, when one is given)
 * @returns {{error: string}|{chatId: number, messageId: number, userId: number, action: 'removed'|null, emoji: string|null}}
 */
async function removeReaction(messageId, userId, emoji) {
    messageId = Number(messageId);
    if (!Number.isInteger(messageId) || messageId < 1) return { error: 'Invalid message ID' };
    if (emoji !== undefined && emoji !== null && !isValidEmoji(emoji)) return { error: 'Invalid emoji' };

    const chatId = await getMessageChatForMember(messageId, userId);
    if (!chatId) return { error: 'Message not found or access denied', notFound: true };

    const existing = await queryOne(
        'SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?',
        [messageId, userId]
    );
    if (!existing || (emoji && existing.emoji !== emoji)) {
        return { chatId, messageId, userId, action: null, emoji: null };
    }

    await executeQuery(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [messageId, userId, existing.emoji]
    );
    return { chatId, messageId, userId, action: 'removed', emoji: existing.emoji };
}

/**
 * Tell everyone in the chat. reaction_added covers add and replace (clients drop the user's
 * previous reaction first); reaction_removed covers toggle-off and explicit removal.
 */
function broadcastReaction(io, result, username) {
    if (!io || !result || !result.action) return;
    const room = `chat_${result.chatId}`;

    if (result.action === 'removed') {
        io.to(room).emit('reaction_removed', {
            messageId: result.messageId,
            userId: result.userId,
            emoji: result.emoji
        });
        return;
    }

    io.to(room).emit('reaction_added', {
        messageId: result.messageId,
        userId: result.userId,
        username,
        emoji: result.emoji,
        previousEmoji: result.previousEmoji
    });
}

module.exports = {
    MAX_EMOJI_CHARS,
    isValidEmoji,
    toggleReaction,
    removeReaction,
    broadcastReaction
};
