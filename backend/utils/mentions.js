/**
 * @mentions: find @username in message text, keep the ones that are members of the
 * (group) chat, and store them in message_mentions. Also used to read them back.
 *
 * Usernames follow the registration rule (letters, digits, underscore, 3-50 chars) and are
 * matched case-insensitively on both databases. Text inside `code` and ``` blocks is ignored,
 * the same way the frontend formatter shows it.
 */

const { executeQuery } = require('../config/database');

// More than this many people in one message is not a mention, it's a broadcast
const MAX_MENTIONS_PER_MESSAGE = 20;

// '@' must not follow a word character, so e-mail addresses (bob@example.com) aren't mentions
const MENTION_PATTERN = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{3,50})(?![A-Za-z0-9_])/g;

/**
 * Remove fenced code blocks and inline code spans (what the formatter renders as code)
 */
function stripCode(text) {
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]+`/g, ' ');
}

/**
 * Lowercased, de-duplicated usernames mentioned in `text`, in order of appearance
 */
function extractMentionUsernames(text) {
    if (!text || typeof text !== 'string' || !text.includes('@')) return [];

    const found = [];
    const source = stripCode(text);
    let match;
    MENTION_PATTERN.lastIndex = 0;
    while ((match = MENTION_PATTERN.exec(source)) !== null) {
        const name = match[2].toLowerCase();
        if (!found.includes(name)) found.push(name);
        if (found.length >= MAX_MENTIONS_PER_MESSAGE) break;
    }
    return found;
}

/**
 * Which of the mentioned usernames are members of this group chat (never the sender, and never
 * someone who blocked the sender). Direct chats have no mentions. Returns [{ user_id, username }].
 */
async function resolveMentions(chatId, senderId, text) {
    const usernames = extractMentionUsernames(text);
    if (usernames.length === 0) return [];

    return executeQuery(`
        SELECT u.id AS user_id, u.username
        FROM group_members gm
        JOIN chats c ON c.id = gm.chat_id AND c.chat_type = 'group'
        JOIN users u ON u.id = gm.user_id
        WHERE gm.chat_id = ?
        AND gm.user_id <> ?
        AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = gm.user_id AND ub.blocked_id = ?)
        AND LOWER(u.username) IN (${usernames.map(() => '?').join(', ')})
    `, [chatId, senderId, senderId, ...usernames]);
}

/**
 * Store a new message's mentions. Returns the stored [{ user_id, username }].
 */
async function saveMentions(chatId, messageId, senderId, text) {
    const mentions = await resolveMentions(chatId, senderId, text);
    for (const mention of mentions) {
        await executeQuery(
            'INSERT INTO message_mentions (message_id, user_id) VALUES (?, ?)',
            [messageId, mention.user_id]
        );
    }
    return mentions;
}

/**
 * Re-sync after an edit: mentions that were removed go away, new ones are added
 * (no push for an edit). Returns the current [{ user_id, username }].
 */
async function replaceMentions(chatId, messageId, senderId, text) {
    const mentions = await resolveMentions(chatId, senderId, text);
    const existing = await executeQuery('SELECT user_id FROM message_mentions WHERE message_id = ?', [messageId]);
    const existingIds = new Set(existing.map(row => Number(row.user_id)));
    const nextIds = new Set(mentions.map(m => Number(m.user_id)));

    for (const id of existingIds) {
        if (!nextIds.has(id)) {
            await executeQuery('DELETE FROM message_mentions WHERE message_id = ? AND user_id = ?', [messageId, id]);
        }
    }
    for (const id of nextIds) {
        if (!existingIds.has(id)) {
            await executeQuery('INSERT INTO message_mentions (message_id, user_id) VALUES (?, ?)', [messageId, id]);
        }
    }
    return mentions;
}

/**
 * Attach `mentions` ([{ user_id, username }]) to message objects in place.
 * Only messages whose text contains '@' can have mentions, so most pages need no query.
 */
async function attachMentions(messages) {
    const list = messages.filter(Boolean);
    for (const message of list) message.mentions = [];

    const candidates = list.filter(m => typeof m.content === 'string' && m.content.includes('@'));
    if (candidates.length === 0) return messages;

    const ids = candidates.map(m => m.id);
    const rows = await executeQuery(`
        SELECT mm.message_id, mm.user_id, u.username
        FROM message_mentions mm
        JOIN users u ON u.id = mm.user_id
        WHERE mm.message_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY mm.id
    `, ids);

    const byMessage = {};
    for (const row of rows) {
        (byMessage[row.message_id] = byMessage[row.message_id] || []).push({
            user_id: Number(row.user_id),
            username: row.username
        });
    }
    for (const message of candidates) {
        message.mentions = byMessage[message.id] || [];
    }
    return messages;
}

module.exports = {
    MAX_MENTIONS_PER_MESSAGE,
    extractMentionUsernames,
    resolveMentions,
    saveMentions,
    replaceMentions,
    attachMentions
};
