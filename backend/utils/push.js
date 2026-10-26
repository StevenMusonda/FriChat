/**
 * Web Push: VAPID setup, subscription storage and new-message notifications
 */

const crypto = require('crypto');
const webpush = require('web-push');
const { executeQuery, dbType } = require('../config/database');
const { fromRow, isDndActive } = require('./notificationSettings');

const PREVIEW_LENGTH = 120;
// How long the push service keeps an undelivered notification (seconds)
const PUSH_TTL = 60 * 60;

const MEDIA_PREVIEWS = {
    image: '📷 Photo',
    video: '🎥 Video',
    file: '📎 File'
};

let vapidConfigured = null;

/**
 * True once VAPID keys are set; without them push is switched off and everything else keeps working
 */
function isPushConfigured() {
    if (vapidConfigured !== null) return vapidConfigured;

    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        vapidConfigured = false;
        return false;
    }

    try {
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:no-reply@frichat.local',
            VAPID_PUBLIC_KEY,
            VAPID_PRIVATE_KEY
        );
        vapidConfigured = true;
    } catch (error) {
        console.error('Web Push disabled - invalid VAPID settings:', error.message);
        vapidConfigured = false;
    }
    return vapidConfigured;
}

function getVapidPublicKey() {
    return isPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

function hashEndpoint(endpoint) {
    return crypto.createHash('sha256').update(endpoint).digest('hex');
}

/**
 * Store a browser's subscription for this user. Re-subscribing the same browser
 * (or a different account logging in on it) updates the existing row.
 */
async function saveSubscription(userId, { endpoint, keys }, userAgent) {
    const params = [userId, endpoint, hashEndpoint(endpoint), keys.p256dh, keys.auth, userAgent ? userAgent.slice(0, 255) : null];

    if (dbType === 'postgresql') {
        await executeQuery(`
            INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (endpoint_hash) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                endpoint = EXCLUDED.endpoint,
                p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth,
                user_agent = EXCLUDED.user_agent
        `, params);
    } else {
        await executeQuery(`
            INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
                endpoint = VALUES(endpoint),
                p256dh = VALUES(p256dh),
                auth = VALUES(auth),
                user_agent = VALUES(user_agent)
        `, params);
    }
}

/**
 * Remove one of this user's subscriptions (other users' rows are never touched)
 */
async function deleteSubscription(userId, endpoint) {
    await executeQuery(
        'DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?',
        [hashEndpoint(endpoint), userId]
    );
}

/**
 * Stored text is HTML-escaped (sanitizeHtml); notifications show plain text
 */
function decodeEntities(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/&amp;/g, '&');
}

/**
 * Short notification body; media gets generic text so file names never leak to the lock screen
 */
function buildPreview(message) {
    if (MEDIA_PREVIEWS[message.message_type]) return MEDIA_PREVIEWS[message.message_type];

    const text = decodeEntities(String(message.content || '')).replace(/\s+/g, ' ').trim();
    if (!text) return 'New message';
    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

/**
 * Does the user have a visible tab that receives this chat's messages live?
 * (sockets report visibility with the `presence` event; unknown counts as visible)
 */
async function hasActiveViewer(io, userId, chatId) {
    if (!io || typeof io.in !== 'function') return false;
    const sockets = await io.in(`user_${userId}`).fetchSockets();
    return sockets.some(s => s.rooms.has(`chat_${chatId}`) && s.data.visible !== false);
}

/**
 * Members who should get a push for a new message: not the sender, not muted,
 * chat not deleted on their side, DND off, and no visible tab on the chat
 */
async function findRecipients(io, message, now = new Date()) {
    const rows = await executeQuery(`
        SELECT
            gm.user_id,
            ns.dnd_enabled,
            ns.quiet_hours_enabled,
            ns.quiet_start,
            ns.quiet_end,
            ns.timezone
        FROM group_members gm
        LEFT JOIN notification_settings ns ON ns.user_id = gm.user_id
        LEFT JOIN deleted_chats dc ON dc.chat_id = gm.chat_id AND dc.user_id = gm.user_id
        WHERE gm.chat_id = ?
        AND gm.user_id <> ?
        AND (gm.muted_until IS NULL OR gm.muted_until <= CURRENT_TIMESTAMP)
        AND dc.id IS NULL
    `, [message.chat_id, message.sender_id]);

    const recipients = [];
    for (const row of rows) {
        if (isDndActive(fromRow(row), now)) continue;
        if (await hasActiveViewer(io, row.user_id, message.chat_id)) continue;
        recipients.push(row.user_id);
    }
    return recipients;
}

/**
 * Unread total per user across their non-muted, non-deleted chats (for the app icon badge)
 */
async function getUnreadTotals(userIds) {
    const placeholders = userIds.map(() => '?').join(', ');
    const rows = await executeQuery(`
        SELECT gm.user_id, COUNT(m.id) AS unread
        FROM group_members gm
        JOIN messages m ON m.chat_id = gm.chat_id
            AND m.id > COALESCE(gm.last_read_message_id, 0)
            AND m.sender_id <> gm.user_id
            AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
        LEFT JOIN deleted_chats dc ON dc.chat_id = gm.chat_id AND dc.user_id = gm.user_id
        WHERE gm.user_id IN (${placeholders})
        AND (gm.muted_until IS NULL OR gm.muted_until <= CURRENT_TIMESTAMP)
        AND dc.id IS NULL
        GROUP BY gm.user_id
    `, userIds);

    const totals = {};
    for (const row of rows) totals[row.user_id] = parseInt(row.unread) || 0;
    return totals;
}

/**
 * Send one payload to one subscription. Returns 'sent', 'gone' (row deleted) or 'failed'.
 */
async function sendToSubscription(subscription, payload) {
    try {
        await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            JSON.stringify(payload),
            // topic lets the push service replace an undelivered notification for the same chat
            { TTL: PUSH_TTL, urgency: 'high', topic: `chat-${payload.chatId}` }
        );
        return 'sent';
    } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
            // Browser unsubscribed or the subscription expired
            await executeQuery('DELETE FROM push_subscriptions WHERE id = ?', [subscription.id]);
            return 'gone';
        }
        console.error('Push send error:', error.statusCode || '', error.message);
        return 'failed';
    }
}

/**
 * Push a new message to every member who isn't watching the chat. Never throws:
 * a push problem must not fail the send. Returns counts for logging/tests.
 */
async function notifyNewMessage(io, message) {
    const result = { sent: 0, removed: 0, failed: 0 };
    try {
        if (!message || !isPushConfigured()) return result;

        const recipients = await findRecipients(io, message);
        if (recipients.length === 0) return result;

        const subscriptions = await executeQuery(
            `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${recipients.map(() => '?').join(', ')})`,
            recipients
        );
        if (subscriptions.length === 0) return result;

        const subscribedUsers = [...new Set(subscriptions.map(s => s.user_id))];
        const [unreadTotals, chatRows] = await Promise.all([
            getUnreadTotals(subscribedUsers),
            executeQuery('SELECT chat_type, chat_name FROM chats WHERE id = ?', [message.chat_id])
        ]);

        const chat = chatRows[0] || {};
        const senderName = decodeEntities(String(message.full_name || message.username || 'Someone'));
        const preview = buildPreview(message);
        const isGroup = chat.chat_type === 'group' && chat.chat_name;

        const outcomes = await Promise.all(subscriptions.map(subscription => sendToSubscription(subscription, {
            type: 'message',
            chatId: message.chat_id,
            messageId: message.id,
            senderName,
            title: isGroup ? decodeEntities(String(chat.chat_name)) : senderName,
            body: isGroup ? `${senderName}: ${preview}` : preview,
            url: `chat.html?chat=${message.chat_id}`,
            badge: unreadTotals[subscription.user_id] || 0
        })));

        for (const outcome of outcomes) {
            if (outcome === 'sent') result.sent++;
            else if (outcome === 'gone') result.removed++;
            else result.failed++;
        }
    } catch (error) {
        console.error('Push notify error:', error);
    }
    return result;
}

module.exports = {
    isPushConfigured,
    getVapidPublicKey,
    hashEndpoint,
    saveSubscription,
    deleteSubscription,
    buildPreview,
    findRecipients,
    notifyNewMessage
};
