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
    file: '📎 File',
    voice: '🎤 Voice message'
};

// Body for chats with disappearing messages on: no text (or poll question) on a lock screen,
// where it would outlive the message
const DISAPPEARING_PREVIEW = 'New message';

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
 * Profile names are still HTML-escaped on write (sanitizeHtml in authController); notifications
 * show plain text. Message text and chat names are stored raw and must NOT go through this.
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
 * Short notification body; media gets generic text so file names never leak to the lock screen.
 * A disappearing message (expires_at set, or { disappearing: true }) never shows its text.
 */
function buildPreview(message, { disappearing = false } = {}) {
    if (disappearing || message.expires_at) return DISAPPEARING_PREVIEW;
    if (MEDIA_PREVIEWS[message.message_type]) return MEDIA_PREVIEWS[message.message_type];
    if (message.message_type === 'poll') {
        const question = String(message.content || '').replace(/\s+/g, ' ').trim();
        const text = `📊 Poll: ${question}`;
        return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
    }

    // Raw text (utils/messageText.js); the notification API shows it as plain text
    const text = String(message.content || '').replace(/\s+/g, ' ').trim();
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
 * Does this member's per-chat setting allow a push? Not mentioned: only when the chat is
 * neither muted nor "mentions only". Mentioned: when not muted, or when "mentions only" is on
 * (that setting is how a muted chat still notifies on mentions).
 */
function chatAllowsPush({ isMuted, mentionsOnly, mentioned }) {
    if (mentioned) return !isMuted || mentionsOnly;
    return !isMuted && !mentionsOnly;
}

/**
 * Members who should get a push for a new message: not the sender, allowed by their
 * mute / "mentions only" setting, chat not deleted on their side, DND off, no visible tab on the chat,
 * and not someone who blocked the sender
 */
async function findRecipients(io, message, now = new Date()) {
    const mentioned = new Set((message.mentions || []).map(m => Number(m.user_id)));
    const rows = await executeQuery(`
        SELECT
            gm.user_id,
            CASE WHEN gm.muted_until IS NOT NULL AND gm.muted_until > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_muted,
            gm.mentions_only,
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
        AND dc.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = gm.user_id AND ub.blocked_id = ?)
    `, [message.chat_id, message.sender_id, message.sender_id]);

    const recipients = [];
    for (const row of rows) {
        const allowed = chatAllowsPush({
            isMuted: !!parseInt(row.is_muted),
            mentionsOnly: row.mentions_only === true || row.mentions_only === 1 || row.mentions_only === '1',
            mentioned: mentioned.has(Number(row.user_id))
        });
        if (!allowed) continue;
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
            // (or the same reminder: payload.tag); payload.ttl shortens delivery (a ringing call)
            { TTL: payload.ttl || PUSH_TTL, urgency: 'high', topic: payload.tag || `chat-${payload.chatId}` }
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
        // Chat notices (e.g. a disappearing-messages change) don't notify
        if (message.message_type === 'system') return result;

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
            executeQuery('SELECT chat_type, chat_name, disappearing_seconds FROM chats WHERE id = ?', [message.chat_id])
        ]);

        const chat = chatRows[0] || {};
        const senderName = decodeEntities(String(message.full_name || message.username || 'Someone'));
        // Timer on now, or this message will disappear: the push carries no message text
        const preview = buildPreview(message, { disappearing: (parseInt(chat.disappearing_seconds) || 0) > 0 });
        const isGroup = chat.chat_type === 'group' && chat.chat_name;

        const mentioned = new Set((message.mentions || []).map(m => Number(m.user_id)));

        const outcomes = await Promise.all(subscriptions.map(subscription => sendToSubscription(subscription, {
            type: 'message',
            chatId: message.chat_id,
            messageId: message.id,
            senderName,
            mentioned: mentioned.has(Number(subscription.user_id)),
            title: isGroup
                ? (mentioned.has(Number(subscription.user_id)) ? `${senderName} mentioned you in ${chat.chat_name}` : String(chat.chat_name))
                : senderName,
            body: isGroup && !mentioned.has(Number(subscription.user_id)) ? `${senderName}: ${preview}` : preview,
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

/**
 * Tell someone who asked to join a group that an admin approved or declined it, on every device
 * they enabled push on (respects do-not-disturb). Never throws.
 * @param {{ chatId, chatName, status: 'approved' | 'declined' }} decision
 */
async function notifyJoinDecision(userId, decision) {
    const result = { sent: 0, removed: 0, failed: 0 };
    try {
        if (!isPushConfigured()) return result;

        const settings = await executeQuery(
            'SELECT dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone FROM notification_settings WHERE user_id = ?',
            [userId]
        );
        if (settings[0] && isDndActive(fromRow(settings[0]), new Date())) return result;

        const subscriptions = await executeQuery(
            'SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
            [userId]
        );
        if (subscriptions.length === 0) return result;

        const approved = decision.status === 'approved';
        const groupName = String(decision.chatName || 'the group');
        const payload = {
            type: 'join_decision',
            chatId: approved ? decision.chatId : null,
            status: decision.status,
            title: approved ? `You joined ${groupName}` : 'Join request declined',
            body: approved
                ? 'An admin approved your request. Tap to open the chat.'
                : `An admin declined your request to join ${groupName}.`,
            url: approved ? `chat.html?chat=${decision.chatId}` : 'chat.html'
        };

        const outcomes = await Promise.all(subscriptions.map(subscription => sendToSubscription(subscription, payload)));
        for (const outcome of outcomes) {
            if (outcome === 'sent') result.sent++;
            else if (outcome === 'gone') result.removed++;
            else result.failed++;
        }
    } catch (error) {
        console.error('Push join decision error:', error);
    }
    return result;
}

/**
 * Does the user have any visible tab right now? (they'll see the in-app notice instead of a push)
 */
async function hasVisibleTab(io, userId) {
    if (!io || typeof io.in !== 'function') return false;
    const sockets = await io.in(`user_${userId}`).fetchSockets();
    return sockets.some(s => s.data.visible !== false);
}

/**
 * A personal notification for one user (a reminder, a scheduled message that couldn't be sent),
 * on every device they enabled push on. Respects do-not-disturb and skips users who have a visible
 * tab, since those get the in-app notice. Never throws.
 * @param {{ type, title, body, url, chatId?, messageId?, tag? }} payload - tag groups/replaces notifications
 */
async function notifyUser(io, userId, payload) {
    const result = { sent: 0, removed: 0, failed: 0 };
    try {
        if (!isPushConfigured()) return result;

        const settings = await executeQuery(
            'SELECT dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone FROM notification_settings WHERE user_id = ?',
            [userId]
        );
        if (settings[0] && isDndActive(fromRow(settings[0]), new Date())) return result;
        if (await hasVisibleTab(io, userId)) return result;

        const subscriptions = await executeQuery(
            'SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
            [userId]
        );
        const outcomes = await Promise.all(subscriptions.map(subscription => sendToSubscription(subscription, payload)));
        for (const outcome of outcomes) {
            if (outcome === 'sent') result.sent++;
            else if (outcome === 'gone') result.removed++;
            else result.failed++;
        }
    } catch (error) {
        console.error('Push notify user error:', error);
    }
    return result;
}

module.exports = {
    DISAPPEARING_PREVIEW,
    notifyJoinDecision,
    notifyUser,
    decodeEntities,
    isPushConfigured,
    getVapidPublicKey,
    hashEndpoint,
    saveSubscription,
    deleteSubscription,
    buildPreview,
    chatAllowsPush,
    findRecipients,
    notifyNewMessage
};
