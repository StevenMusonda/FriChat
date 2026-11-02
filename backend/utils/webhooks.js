/**
 * Incoming webhooks: a secret URL an outside system posts to, which appears in a group as a message
 * with a Bot badge.
 *
 * The token exists in full only in the response that creates the webhook. The database holds its
 * SHA-256 hash (it is 256 random bits, so nothing slower is needed), and nothing here logs it.
 *
 * Every webhook message is sent by one reserved account (config/webhooks.js), because messages need
 * a sender and every read of them joins users. The name people see is messages.bot_name. A webhook
 * belongs to the group, not to the admin who made it: it keeps working when they leave, and any admin
 * can revoke it.
 */

const crypto = require('crypto');
const { executeQuery, queryOne, insertAndGetId, updateAndCount } = require('../config/database');
const {
    WEBHOOK_NAME_MAX_LENGTH,
    MAX_WEBHOOKS_PER_CHAT,
    WEBHOOK_TOKEN_BYTES,
    WEBHOOK_TOKEN_PATTERN,
    BOT_USERNAME,
    BOT_FULL_NAME
} = require('../config/webhooks');
const { stripControlChars } = require('./messageText');
const { isDuplicateKeyError } = require('./groups');
const { deliverNewMessage } = require('./messageDelivery');

// Not a bcrypt hash, so no password can ever match it
const UNUSABLE_PASSWORD = '!bot';

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function sameHash(a, b) {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * A name people will read next to a message: one line, no markup characters. Bot names reach the same
 * places as display names, which are escaped on write, so these simply can't hold anything to escape.
 */
function cleanBotName(value) {
    if (typeof value !== 'string') return '';
    return stripControlChars(value)
        .replace(/[<>&"'`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, WEBHOOK_NAME_MAX_LENGTH)
        .trim();
}

function shapeWebhook(row) {
    return {
        id: Number(row.id),
        name: row.name,
        createdByUsername: row.created_by_username || null,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at || null
    };
}

/**
 * The reserved sender, created the first time a webhook posts
 */
async function getBotUserId() {
    const existing = await queryOne('SELECT id FROM users WHERE username = ?', [BOT_USERNAME]);
    if (existing) return Number(existing.id);

    try {
        const suffix = crypto.randomBytes(8).toString('hex');
        const id = await insertAndGetId(
            'INSERT INTO users (username, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
            [BOT_USERNAME, `bot-${suffix}@bot.invalid`, UNUSABLE_PASSWORD, BOT_FULL_NAME]
        );
        return Number(id);
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        // Two first posts at the same moment
        const created = await queryOne('SELECT id FROM users WHERE username = ?', [BOT_USERNAME]);
        return Number(created.id);
    }
}

/**
 * Active webhooks of a chat. Callers check that the user is an admin of it.
 */
async function listWebhooks(chatId) {
    const rows = await executeQuery(`
        SELECT w.id, w.name, w.created_at, w.last_used_at, u.username AS created_by_username
        FROM chat_webhooks w
        LEFT JOIN users u ON u.id = w.created_by
        WHERE w.chat_id = ? AND w.revoked_at IS NULL
        ORDER BY w.id
    `, [chatId]);
    return rows.map(shapeWebhook);
}

/**
 * @returns {Promise<{ error } | { webhook, token }>} the only place the token is ever available
 */
async function createWebhook(chatId, userId, name) {
    const cleaned = cleanBotName(name);
    if (!cleaned) {
        return { error: { status: 400, message: 'Give the webhook a name' } };
    }

    const active = await queryOne('SELECT COUNT(*) AS total FROM chat_webhooks WHERE chat_id = ? AND revoked_at IS NULL', [chatId]);
    if (active && Number(active.total) >= MAX_WEBHOOKS_PER_CHAT) {
        return { error: { status: 409, code: 'WEBHOOK_LIMIT', message: `A group can have ${MAX_WEBHOOKS_PER_CHAT} webhooks. Revoke one first.` } };
    }

    const token = crypto.randomBytes(WEBHOOK_TOKEN_BYTES).toString('base64url');
    const id = await insertAndGetId(
        'INSERT INTO chat_webhooks (chat_id, name, token_hash, created_by) VALUES (?, ?, ?, ?)',
        [chatId, cleaned, hashToken(token), userId]
    );
    return { webhook: { id: Number(id), name: cleaned }, token };
}

/**
 * @returns {Promise<boolean>} false if there's no such active webhook in this chat
 */
async function revokeWebhook(chatId, webhookId, userId) {
    const changed = await updateAndCount(
        'UPDATE chat_webhooks SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE id = ? AND chat_id = ? AND revoked_at IS NULL',
        [userId, webhookId, chatId]
    );
    return changed > 0;
}

/**
 * The active webhook these credentials open, or null. A wrong token, an unknown id and a revoked
 * webhook all look the same to the caller.
 */
async function findWebhook(webhookId, token) {
    if (!WEBHOOK_TOKEN_PATTERN.test(String(token))) return null;
    const row = await queryOne(
        'SELECT id, chat_id, name, token_hash FROM chat_webhooks WHERE id = ? AND revoked_at IS NULL',
        [webhookId]
    );
    if (!row || !sameHash(String(row.token_hash).trim(), hashToken(token))) return null;
    return { id: Number(row.id), chatId: Number(row.chat_id), name: row.name };
}

/**
 * Post a checked text through the normal send path (mentions, push, link preview, disappearing timer)
 * @param {string} text - already cleaned by cleanMessageText
 * @param {*} username - optional display name for this message; falls back to the webhook's name
 * @returns {Promise<Object|null>} the message as clients receive it
 */
async function postWebhookMessage(io, webhook, text, username) {
    const message = await deliverNewMessage(io, {
        chatId: webhook.chatId,
        senderId: await getBotUserId(),
        content: text,
        webhookId: webhook.id,
        botName: cleanBotName(username) || webhook.name
    });
    await executeQuery('UPDATE chat_webhooks SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [webhook.id]);
    return message;
}

module.exports = {
    hashToken,
    cleanBotName,
    getBotUserId,
    listWebhooks,
    createWebhook,
    revokeWebhook,
    findWebhook,
    postWebhookMessage
};
