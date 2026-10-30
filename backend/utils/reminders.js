/**
 * "Remind me" on a message: a private reminder, stored in message_reminders and fired by the
 * scheduler as an in-app notice (reminder_due to the user's own room) plus a push when enabled.
 *
 * Status: pending -> fired (shown until dismissed, which deletes it) | cancelled (the user can't
 * see the message any more when it comes due, so nothing is sent). One pending reminder per user
 * per message: setting a new one replaces it.
 */

const { executeQuery, queryOne, insertAndGetId, updateAndCount } = require('../config/database');
const { toBool } = require('./messageQueries');
const { buildPreview, notifyUser, decodeEntities } = require('./push');
const { plusSecondsSql, secondsUntilSql, isoFromSecondsUntil } = require('./timeSql');
const { MAX_PENDING_REMINDERS_PER_USER, BATCH_SIZE } = require('../config/scheduling');

// Reminder plus what the list and the notice show about its message.
// The message details are only filled in while the user is still a member and it isn't deleted.
const SELECT_REMINDER = `
    SELECT r.id, r.user_id, r.message_id, r.chat_id, r.status,
           ${secondsUntilSql('r.remind_at')} AS remind_in,
           ${secondsUntilSql('r.fired_at')} AS fired_in,
           m.message_type, m.content, m.deleted_for_everyone, m.sender_id,
           CASE WHEN m.expires_at IS NULL THEN 0 ELSE 1 END AS disappearing,
           u.username AS sender_username, u.full_name AS sender_full_name,
           f.original_name AS file_name,
           gm.id AS membership_id
    FROM message_reminders r
    JOIN messages m ON m.id = r.message_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN files f ON f.id = m.file_id
    LEFT JOIN group_members gm ON gm.chat_id = r.chat_id AND gm.user_id = r.user_id`;

function canSeeMessage(row) {
    return !!row.membership_id && !toBool(row.deleted_for_everyone);
}

function shapeReminder(row, now = Date.now()) {
    if (!row) return null;
    const visible = canSeeMessage(row);
    return {
        id: Number(row.id),
        chatId: Number(row.chat_id),
        messageId: Number(row.message_id),
        status: row.status,
        remindAt: isoFromSecondsUntil(row.remind_in, now),
        firedAt: isoFromSecondsUntil(row.fired_in, now),
        available: visible,
        message: visible ? {
            senderId: Number(row.sender_id),
            senderName: row.sender_full_name || row.sender_username,
            messageType: row.message_type,
            content: row.message_type === 'text' || row.message_type === 'poll' ? row.content : null,
            fileName: row.file_name || null,
            disappearing: !!parseInt(row.disappearing)
        } : null
    };
}

async function getReminderRow(id) {
    return queryOne(`${SELECT_REMINDER} WHERE r.id = ?`, [id]);
}

function emitReminder(io, userId, event, reminder) {
    if (io) io.to(`user_${userId}`).emit(event, reminder);
}

/**
 * @param {string} status - 'pending' (coming up) or 'fired' (waiting to be dismissed); default both
 */
async function listReminders(userId, status = null) {
    const statuses = status ? [status] : ['pending', 'fired'];
    const rows = await executeQuery(`
        ${SELECT_REMINDER}
        WHERE r.user_id = ? AND r.status IN (${statuses.map(() => '?').join(', ')})
        ORDER BY r.remind_at ASC, r.id ASC
        LIMIT 200
    `, [userId, ...statuses]);
    const now = Date.now();
    return rows.map(row => shapeReminder(row, now));
}

/**
 * Remind the user about a message they can see
 * @param {Object} input - { messageId, remindInSeconds }
 */
async function createReminder(io, userId, input) {
    const message = await queryOne(`
        SELECT m.id, m.chat_id, m.deleted_for_everyone
        FROM messages m
        JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
        LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
        WHERE m.id = ? AND dm.id IS NULL
    `, [userId, userId, input.messageId]);
    if (!message) return { error: { status: 404, message: 'Message not found' } };
    if (toBool(message.deleted_for_everyone)) {
        return { error: { status: 400, message: 'You cannot set a reminder on a deleted message' } };
    }

    // Replaces this message's earlier pending reminder
    await executeQuery(
        "DELETE FROM message_reminders WHERE user_id = ? AND message_id = ? AND status = 'pending'",
        [userId, message.id]
    );

    const open = await queryOne(
        "SELECT COUNT(*) AS count FROM message_reminders WHERE user_id = ? AND status = 'pending'",
        [userId]
    );
    if (open && parseInt(open.count) >= MAX_PENDING_REMINDERS_PER_USER) {
        return { error: { status: 409, message: `You can have up to ${MAX_PENDING_REMINDERS_PER_USER} reminders` } };
    }

    const id = await insertAndGetId(
        `INSERT INTO message_reminders (user_id, message_id, chat_id, remind_at, status) VALUES (?, ?, ?, ${plusSecondsSql()}, 'pending')`,
        [userId, message.id, message.chat_id, parseInt(input.remindInSeconds, 10)]
    );

    const reminder = shapeReminder(await getReminderRow(id));
    emitReminder(io, userId, 'reminder_updated', reminder);
    return { reminder };
}

/**
 * Cancel a pending reminder or dismiss a fired one (either way it's deleted)
 */
async function deleteReminder(io, userId, id) {
    const changed = await updateAndCount(
        'DELETE FROM message_reminders WHERE id = ? AND user_id = ?',
        [id, userId]
    );
    if (!changed) return { error: { status: 404, message: 'Reminder not found' } };

    const reminder = { id: Number(id), status: 'deleted' };
    emitReminder(io, userId, 'reminder_updated', reminder);
    return { reminder };
}

/**
 * Notification text: who wrote it and a short preview (media gets a label, never the file name)
 */
function reminderBody(reminder) {
    const message = reminder.message;
    // A disappearing message's text stays off the lock screen (push.js)
    const preview = buildPreview({ message_type: message.messageType, content: message.content }, { disappearing: message.disappearing });
    // Profile names are still entity-escaped on write (see push.js); notifications are plain text
    return `${decodeEntities(String(message.senderName || 'Someone'))}: ${preview}`;
}

/**
 * Scheduler tick: fire every reminder that is due
 */
async function fireDueReminders(io) {
    const result = { fired: 0, cancelled: 0 };
    const due = await executeQuery(
        `SELECT id FROM message_reminders WHERE status = 'pending' AND remind_at <= CURRENT_TIMESTAMP ORDER BY remind_at, id LIMIT ${parseInt(BATCH_SIZE)}`
    );

    for (const { id } of due) {
        // Exactly one tick fires it
        const claimed = await updateAndCount(
            "UPDATE message_reminders SET status = 'fired', fired_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
            [id]
        );
        if (!claimed) continue;

        const row = await getReminderRow(id);
        if (!row) continue;

        // Left the chat or the message was deleted for everyone: nothing to remind about
        if (!canSeeMessage(row)) {
            await executeQuery("UPDATE message_reminders SET status = 'cancelled' WHERE id = ?", [id]);
            result.cancelled++;
            continue;
        }

        const reminder = shapeReminder(row);
        emitReminder(io, row.user_id, 'reminder_due', reminder);
        notifyUser(io, row.user_id, {
            type: 'reminder',
            chatId: reminder.chatId,
            messageId: reminder.messageId,
            title: '⏰ Reminder',
            body: reminderBody(reminder),
            url: `chat.html?chat=${reminder.chatId}&message=${reminder.messageId}`,
            tag: `reminder-${reminder.id}`
        });
        result.fired++;
    }
    return result;
}

module.exports = {
    shapeReminder,
    listReminders,
    createReminder,
    deleteReminder,
    fireDueReminders
};
