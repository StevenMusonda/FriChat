/**
 * Scheduled messages: stored in scheduled_messages and sent by the scheduler (utils/scheduler.js)
 * through the normal delivery path. Everything lives in the database, so a restart loses nothing:
 * the next tick picks up whatever is due, including anything that came due while the server was down.
 *
 * Status: pending -> sending (claimed by one tick) -> sent | failed; pending/failed -> cancelled.
 * The claim is a conditional UPDATE, so a message is sent once even if two ticks overlap.
 */

const { executeQuery, queryOne, insertAndGetId, updateAndCount } = require('../config/database');
const { cleanMessageText } = require('./messageText');
const { checkCanPost } = require('./groups');
const { checkReplyTarget } = require('./messageQueries');
const { deliverNewMessage } = require('./messageDelivery');
const { notifyUser } = require('./push');
const { plusSecondsSql, secondsUntilSql, minusSecondsSql, isoFromSecondsUntil } = require('./timeSql');
const {
    MAX_PENDING_SCHEDULED_PER_USER,
    STALE_CLAIM_SECONDS,
    MAX_SEND_ATTEMPTS,
    BATCH_SIZE
} = require('../config/scheduling');

const COLUMNS = `
    sm.id, sm.user_id, sm.chat_id, sm.content, sm.reply_to_message_id, sm.status, sm.failure_reason,
    sm.sent_message_id, sm.attempts, ${secondsUntilSql('sm.send_at')} AS send_in`;

// What the user is told when the message couldn't go out
const FAILURE_REASONS = {
    NOT_A_MEMBER: 'You were no longer a member of this chat, so the message was discarded.',
    ANNOUNCEMENT_ONLY: 'Only admins can send messages in this group now, so the message was discarded.',
    BLOCKED: 'You can no longer message this person, so the message was discarded.',
    SPAM_LIMIT: 'You reached the hourly limit for new accounts, so the message was not sent.',
    DELIVERY: 'The message could not be delivered.'
};

function shapeScheduled(row, now = Date.now()) {
    if (!row) return null;
    return {
        id: Number(row.id),
        chatId: Number(row.chat_id),
        content: row.content,
        replyToMessageId: row.reply_to_message_id ? Number(row.reply_to_message_id) : null,
        status: row.status,
        failureReason: row.failure_reason || null,
        sentMessageId: row.sent_message_id ? Number(row.sent_message_id) : null,
        sendAt: isoFromSecondsUntil(row.send_in, now)
    };
}

async function getScheduledRow(id) {
    return queryOne(`SELECT ${COLUMNS} FROM scheduled_messages sm WHERE sm.id = ?`, [id]);
}

/**
 * Every tab of the user keeps its list in step (create, edit, cancel, sent, failed)
 */
function emitScheduled(io, userId, scheduledMessage) {
    if (io) io.to(`user_${userId}`).emit('scheduled_message_updated', scheduledMessage);
}

/**
 * The user's pending and failed scheduled messages (optionally one chat), soonest first
 */
async function listScheduled(userId, chatId = null) {
    const params = [userId];
    let chatSql = '';
    if (chatId) {
        chatSql = 'AND sm.chat_id = ?';
        params.push(chatId);
    }
    const rows = await executeQuery(`
        SELECT ${COLUMNS}
        FROM scheduled_messages sm
        JOIN group_members gm ON gm.chat_id = sm.chat_id AND gm.user_id = sm.user_id
        WHERE sm.user_id = ? ${chatSql}
        AND sm.status IN ('pending', 'sending', 'failed')
        ORDER BY sm.send_at ASC, sm.id ASC
        LIMIT 200
    `, params);
    // Failed ones stay listed (with the reason) until dismissed, even after leaving the chat
    const failedElsewhere = chatId ? [] : await executeQuery(`
        SELECT ${COLUMNS}
        FROM scheduled_messages sm
        LEFT JOIN group_members gm ON gm.chat_id = sm.chat_id AND gm.user_id = sm.user_id
        WHERE sm.user_id = ? AND sm.status = 'failed' AND gm.id IS NULL
        ORDER BY sm.send_at ASC, sm.id ASC
        LIMIT 50
    `, [userId]);
    const now = Date.now();
    return rows.concat(failedElsewhere).map(row => shapeScheduled(row, now));
}

/**
 * The rules a scheduled message must pass now (and again when it's sent)
 * @returns {Promise<null | { status, message, code? }>}
 */
async function checkSchedulable(userId, chatId, replyToMessageId) {
    const postError = await checkCanPost(chatId, userId);
    if (postError) return postError;
    if (replyToMessageId) {
        const replyError = await checkReplyTarget(chatId, replyToMessageId);
        if (replyError) return { status: 400, message: replyError };
    }
    return null;
}

/**
 * @param {Object} input - { chatId, content, replyToMessageId, sendInSeconds }
 */
async function createScheduled(io, userId, input) {
    const cleaned = cleanMessageText(input.content, { required: true });
    if (!cleaned.ok) return { error: { status: 400, message: cleaned.error } };

    const replyToMessageId = input.replyToMessageId || null;
    const ruleError = await checkSchedulable(userId, input.chatId, replyToMessageId);
    if (ruleError) return { error: ruleError };

    const open = await queryOne(
        "SELECT COUNT(*) AS count FROM scheduled_messages WHERE user_id = ? AND status IN ('pending', 'sending')",
        [userId]
    );
    if (open && parseInt(open.count) >= MAX_PENDING_SCHEDULED_PER_USER) {
        return { error: { status: 409, message: `You can have up to ${MAX_PENDING_SCHEDULED_PER_USER} scheduled messages` } };
    }

    const id = await insertAndGetId(
        `INSERT INTO scheduled_messages (user_id, chat_id, content, reply_to_message_id, send_at, status) VALUES (?, ?, ?, ?, ${plusSecondsSql()}, 'pending')`,
        [userId, input.chatId, cleaned.text, replyToMessageId, parseInt(input.sendInSeconds, 10)]
    );

    const scheduledMessage = shapeScheduled(await getScheduledRow(id));
    emitScheduled(io, userId, scheduledMessage);
    return { scheduledMessage };
}

async function findOwnScheduled(userId, id) {
    return queryOne(`SELECT ${COLUMNS} FROM scheduled_messages sm WHERE sm.id = ? AND sm.user_id = ?`, [id, userId]);
}

function notEditable(row) {
    if (!row) return { status: 404, message: 'Scheduled message not found' };
    if (row.status === 'sending' || row.status === 'sent') {
        return { status: 409, message: 'This message has already been sent' };
    }
    return { status: 409, message: 'This scheduled message was cancelled' };
}

/**
 * Edit the text and/or the time. A failed message that is rescheduled goes back to pending.
 * @param {Object} changes - { content?, sendInSeconds? }
 */
async function updateScheduled(io, userId, id, changes) {
    const row = await findOwnScheduled(userId, id);
    if (!row || !['pending', 'failed'].includes(row.status)) return { error: notEditable(row) };

    const sets = [];
    const params = [];
    if (changes.content !== undefined) {
        const cleaned = cleanMessageText(changes.content, { required: true });
        if (!cleaned.ok) return { error: { status: 400, message: cleaned.error } };
        sets.push('content = ?');
        params.push(cleaned.text);
    }
    if (changes.sendInSeconds !== undefined) {
        sets.push(`send_at = ${plusSecondsSql()}`);
        params.push(parseInt(changes.sendInSeconds, 10));
    }
    if (sets.length === 0) return { error: { status: 400, message: 'Nothing to change' } };

    // Still allowed to post there? (a reschedule after being removed fails right away, not later)
    const ruleError = await checkCanPost(row.chat_id, userId);
    if (ruleError) return { error: ruleError };

    // Only while nobody is sending it: the scheduler's claim and this edit can't both win
    const changed = await updateAndCount(
        `UPDATE scheduled_messages SET ${sets.join(', ')}, status = 'pending', failure_reason = NULL, attempts = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')`,
        [...params, id, userId]
    );
    if (!changed) return { error: notEditable(await findOwnScheduled(userId, id)) };

    const scheduledMessage = shapeScheduled(await getScheduledRow(id));
    emitScheduled(io, userId, scheduledMessage);
    return { scheduledMessage };
}

/**
 * Cancel a pending message, or dismiss a failed one
 */
async function cancelScheduled(io, userId, id) {
    const changed = await updateAndCount(
        "UPDATE scheduled_messages SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')",
        [id, userId]
    );
    if (!changed) return { error: notEditable(await findOwnScheduled(userId, id)) };

    const scheduledMessage = { id: Number(id), status: 'cancelled' };
    emitScheduled(io, userId, scheduledMessage);
    return { scheduledMessage };
}

/**
 * Discard a message that can't be sent any more, and tell its author (in-app and push)
 */
async function markFailed(io, row, reason) {
    await executeQuery(
        "UPDATE scheduled_messages SET status = 'failed', failure_reason = ?, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [reason, row.id]
    );
    const scheduledMessage = shapeScheduled({ ...row, status: 'failed', failure_reason: reason });
    emitScheduled(io, row.user_id, scheduledMessage);

    const preview = String(row.content || '').replace(/\s+/g, ' ').trim();
    notifyUser(io, row.user_id, {
        type: 'scheduled_failed',
        title: 'Scheduled message not sent',
        body: `${reason} "${preview.length > 60 ? `${preview.slice(0, 59)}…` : preview}"`,
        url: 'chat.html',
        tag: `scheduled-${row.id}`
    });
    return scheduledMessage;
}

function failureReasonFor(postError) {
    if (postError.code === 'NOT_A_MEMBER') return FAILURE_REASONS.NOT_A_MEMBER;
    if (postError.code === 'ANNOUNCEMENT_ONLY') return FAILURE_REASONS.ANNOUNCEMENT_ONLY;
    if (postError.code === 'SPAM_LIMIT') return FAILURE_REASONS.SPAM_LIMIT;
    return FAILURE_REASONS.BLOCKED;
}

/**
 * Send one claimed row (status 'sending')
 * @returns {Promise<'sent' | 'failed' | 'retry'>}
 */
async function sendClaimed(io, row) {
    const postError = await checkCanPost(row.chat_id, row.user_id);
    if (postError) {
        await markFailed(io, row, failureReasonFor(postError));
        return 'failed';
    }

    // The quoted message may have been deleted meanwhile: send without the quote
    let replyToMessageId = row.reply_to_message_id || null;
    if (replyToMessageId && await checkReplyTarget(row.chat_id, replyToMessageId)) {
        replyToMessageId = null;
    }

    let message;
    try {
        message = await deliverNewMessage(io, {
            chatId: row.chat_id,
            senderId: row.user_id,
            messageType: 'text',
            content: row.content,
            replyToMessageId
        });
    } catch (error) {
        console.error(`Scheduled message ${row.id} delivery error:`, error.message);
        if ((parseInt(row.attempts) || 0) < MAX_SEND_ATTEMPTS) {
            await executeQuery(
                "UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL WHERE id = ? AND status = 'sending'",
                [row.id]
            );
            return 'retry';
        }
        await markFailed(io, row, FAILURE_REASONS.DELIVERY);
        return 'failed';
    }

    const messageId = message ? message.id : null;
    await executeQuery(
        "UPDATE scheduled_messages SET status = 'sent', sent_message_id = ?, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [messageId, row.id]
    );
    emitScheduled(io, row.user_id, shapeScheduled({ ...row, status: 'sent', sent_message_id: messageId }));
    return 'sent';
}

/**
 * Scheduler tick: send everything that is due
 */
async function processDueScheduledMessages(io) {
    const result = { sent: 0, failed: 0, retry: 0, recovered: 0 };

    // The server stopped while sending these: try again (see FEATURES_SETUP.md, known limitations)
    result.recovered = await updateAndCount(
        `UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL WHERE status = 'sending' AND claimed_at < ${minusSecondsSql(STALE_CLAIM_SECONDS)}`
    );

    const due = await executeQuery(
        `SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= CURRENT_TIMESTAMP ORDER BY send_at, id LIMIT ${parseInt(BATCH_SIZE)}`
    );

    for (const { id } of due) {
        // Exactly one tick wins the claim; an edit or cancel that got there first wins instead
        const claimed = await updateAndCount(
            "UPDATE scheduled_messages SET status = 'sending', claimed_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND send_at <= CURRENT_TIMESTAMP",
            [id]
        );
        if (!claimed) continue;

        const row = await getScheduledRow(id);
        if (!row) continue;
        try {
            result[await sendClaimed(io, row)]++;
        } catch (error) {
            console.error(`Scheduled message ${id} error:`, error);
        }
    }
    return result;
}

module.exports = {
    FAILURE_REASONS,
    shapeScheduled,
    listScheduled,
    createScheduled,
    updateScheduled,
    cancelScheduled,
    processDueScheduledMessages
};
