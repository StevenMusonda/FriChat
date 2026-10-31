/**
 * Account deletion.
 *
 * Asking for it starts a grace period: every session ends, and signing in again (password and second
 * factor) before it runs out cancels the deletion. After that, purgeAccount removes the person's data.
 *
 * The users row stays as an anonymous tombstone, because messages need a sender and other people's
 * chats shouldn't lose their history: messages then read "Deleted user". Everything that identifies
 * the person goes: profile, photo, uploads, reactions, votes, memberships of groups, sessions, push
 * subscriptions. Text of messages they deleted for everyone is erased too: until now it was only
 * hidden.
 *
 * deleted_at is the claim and also what stops sign-ins, while deletion_due_at stays set until the
 * last step. Every step can run twice, so a purge that fails halfway is simply run again by the next
 * tick. A file that can't be removed from disk fails the purge rather than being forgotten.
 *
 * Two things are kept on purpose, see FEATURES_SETUP.md: the audit log, which is append-only, and the
 * text of report_evidence, whose sender is anonymised here.
 */

const crypto = require('crypto');
const fs = require('fs');
const { executeQuery, queryOne, updateAndCount } = require('../config/database');
const { DELETION_BATCH_SIZE, DELETION_FILE_BATCH_SIZE, deletionGraceDays } = require('../config/accountSecurity');
const { plusSecondsSql, secondsUntilSql, isoFromSecondsUntil } = require('./timeSql');
const sessions = require('./sessions');
const groups = require('./groups');
const avatars = require('./avatars');
const { deleteGroupAvatar } = require('./groupAvatar');
const { resolveUploadPath, deleteOrphanedFiles } = require('./uploads');
const { deleteUserExports } = require('./dataExport');
const { notifySecurityEvent } = require('./securityEmails');
const { emitProfileUpdate } = require('./privacy');
const auditLog = require('./auditLog');

const DELETED_NAME = 'Deleted user';
// Not a bcrypt hash, so no password can ever match it
const UNUSABLE_PASSWORD = '!deleted';

/**
 * Rows that are only about this person, removed outright
 */
const DELETED_ROWS = [
    ['password_resets', 'user_id'],
    ['email_verifications', 'user_id'],
    ['push_subscriptions', 'user_id'],
    ['notification_settings', 'user_id'],
    ['privacy_settings', 'user_id'],
    ['recovery_codes', 'user_id'],
    ['known_devices', 'user_id'],
    ['sessions', 'user_id'],
    ['message_reactions', 'user_id'],
    ['starred_messages', 'user_id'],
    ['message_mentions', 'user_id'],
    ['deleted_messages', 'user_id'],
    ['deleted_chats', 'user_id'],
    ['chat_join_requests', 'user_id'],
    ['user_blocks', 'blocker_id'],
    ['user_blocks', 'blocked_id'],
    ['group_bans', 'user_id'],
    ['poll_votes', 'user_id'],
    ['scheduled_messages', 'user_id'],
    ['message_reminders', 'user_id'],
    ['message_requests', 'requester_id'],
    ['message_requests', 'recipient_id'],
    ['voice_note_plays', 'user_id'],
    ['event_rsvps', 'user_id'],
    ['user_warnings', 'user_id']
];

/**
 * Columns that keep pointing at the tombstone, which says nothing about the person. Each table with
 * a users foreign key must be in DELETED_ROWS or here, or handled by name in purgeAccount; a test
 * reads the schema and fails if a new one isn't.
 */
const KEPT_REFERENCES = [
    'chats.created_by',
    'messages.sender_id', // reads "Deleted user"
    'messages.deleted_by',
    'pinned_messages.pinned_by',
    'chat_invites.created_by',
    'chat_join_requests.decided_by',
    'group_bans.banned_by',
    'polls.created_by',
    'calls.caller_id', // the other person's call history
    'calls.callee_id',
    'chat_events.created_by',
    'chat_lists.created_by',
    'chat_list_items.created_by',
    'chat_list_items.done_by',
    'chat_list_items.due_set_by',
    'reports.reported_user_id', // an open report still needs its target
    'reports.reviewed_by',
    'user_warnings.admin_id'
];

// --- the grace period ---

/**
 * Start the grace period: sign out everywhere and stop anything that would act for the user
 * @returns {Promise<{ dueAt: string } | { error }>}
 */
async function scheduleDeletion(io, user) {
    const graceSeconds = deletionGraceDays() * 24 * 60 * 60;
    const changed = await updateAndCount(
        `UPDATE users SET deletion_requested_at = CURRENT_TIMESTAMP, deletion_due_at = ${plusSecondsSql()} WHERE id = ? AND deleted_at IS NULL`,
        [graceSeconds, user.id]
    );
    if (changed === 0) return { error: { status: 404, message: 'User not found' } };

    const row = await queryOne(`SELECT ${secondsUntilSql('deletion_due_at')} AS seconds_left FROM users WHERE id = ?`, [user.id]);
    const dueAt = isoFromSecondsUntil(row.seconds_left);

    await sessions.revokeUserSessions(io, user.id, 'deletion');
    if (io && typeof io.in === 'function') io.in(`user_${user.id}`).disconnectSockets(true);

    await executeQuery('DELETE FROM push_subscriptions WHERE user_id = ?', [user.id]);
    await executeQuery(
        "UPDATE scheduled_messages SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'pending'",
        [user.id]
    );

    notifySecurityEvent(user, 'deletion_scheduled', { dueAt });
    return { dueAt };
}

/**
 * Signing in cancels a pending deletion, unless the purge has already started.
 * @returns {Promise<boolean>} false: the account is being deleted, so this sign-in can't go ahead
 */
async function cancelDeletion(user) {
    const changed = await updateAndCount(
        'UPDATE users SET deletion_requested_at = NULL, deletion_due_at = NULL WHERE id = ? AND deleted_at IS NULL',
        [user.id]
    );
    if (changed === 0) return false;
    notifySecurityEvent(user, 'deletion_cancelled');
    return true;
}

// --- the purge ---

async function deleteChat(chat) {
    const rows = await executeQuery('SELECT DISTINCT file_id FROM messages WHERE chat_id = ? AND file_id IS NOT NULL', [chat.chat_id]);
    await executeQuery('DELETE FROM chats WHERE id = ?', [chat.chat_id]);
    await deleteOrphanedFiles(rows.map(row => row.file_id));
    if (chat.avatar_url) await deleteGroupAvatar(chat.avatar_url);
}

/**
 * Leave every group (admin passes on as usual). Direct chats keep the tombstone as their other side,
 * so the person left in them sees who they were talking to. A chat with nobody left goes.
 */
async function leaveChats(io, userId) {
    const chats = await executeQuery(`
        SELECT gm.chat_id, c.chat_type, c.avatar_url
        FROM group_members gm
        JOIN chats c ON c.id = gm.chat_id
        WHERE gm.user_id = ?
    `, [userId]);

    for (const chat of chats) {
        if (chat.chat_type === 'group') {
            const left = await groups.leaveGroup(chat.chat_id, userId);
            if (left.error) throw new Error(`Could not leave chat ${chat.chat_id}: ${left.error.message}`);
            groups.emitMembersUpdated(io, chat.chat_id);
            const remaining = await queryOne('SELECT COUNT(*) AS total FROM group_members WHERE chat_id = ?', [chat.chat_id]);
            if (Number(remaining.total) === 0) await deleteChat(chat);
        } else {
            const other = await queryOne(`
                SELECT gm.user_id
                FROM group_members gm
                JOIN users u ON u.id = gm.user_id
                WHERE gm.chat_id = ? AND gm.user_id <> ? AND u.deleted_at IS NULL
                LIMIT 1
            `, [chat.chat_id, userId]);
            if (!other) await deleteChat(chat);
        }
    }
}

async function unlinkUpload(row) {
    const fullPath = resolveUploadPath(row.upload_path);
    if (!fullPath) {
        console.error(`Upload ${row.id} is stored outside the uploads folder; only its record was removed`);
        return;
    }
    try {
        await fs.promises.unlink(fullPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

/**
 * Every file the user uploaded, from disk first and then from the database, so a failure leaves the
 * row in place for the next run. A message carrying one of them is deleted for everyone, including
 * a copy someone else forwarded: the file is theirs to remove. The sender's own text goes with it.
 */
async function removeUploads(io, userId) {
    for (;;) {
        const files = await executeQuery(
            `SELECT id, upload_path FROM files WHERE uploaded_by = ? ORDER BY id LIMIT ${DELETION_FILE_BATCH_SIZE}`,
            [userId]
        );
        if (files.length === 0) return;

        const ids = files.map(file => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        const messages = await executeQuery(`SELECT id, chat_id FROM messages WHERE file_id IN (${placeholders})`, ids);

        await executeQuery(`
            UPDATE messages
            SET content = CASE WHEN sender_id = ? THEN NULL ELSE content END,
                file_id = NULL, deleted_for_everyone = TRUE, deleted_at = CURRENT_TIMESTAMP, deleted_by = NULL
            WHERE file_id IN (${placeholders})
        `, [userId, ...ids]);

        if (io) {
            for (const message of messages) {
                io.to(`chat_${message.chat_id}`).emit('message_deleted', {
                    messageId: Number(message.id),
                    chatId: Number(message.chat_id),
                    deletedForEveryone: true
                });
            }
        }

        for (const file of files) await unlinkUpload(file);
        await executeQuery(`DELETE FROM files WHERE id IN (${placeholders})`, ids);
    }
}

/**
 * Uploads the virus scanner set aside: the row keeps the original file name
 */
async function removeQuarantinedFiles(userId) {
    const rows = await executeQuery('SELECT id, quarantine_path FROM quarantined_files WHERE uploaded_by = ?', [userId]);
    for (const row of rows) {
        try {
            await fs.promises.unlink(row.quarantine_path);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await executeQuery('DELETE FROM quarantined_files WHERE id = ?', [row.id]);
    }
}

function tombstoneIdentity() {
    const suffix = crypto.randomBytes(8).toString('hex');
    return { username: `deleted_${suffix}`, email: `deleted-${suffix}@deleted.invalid` };
}

async function writeTombstone(userId) {
    const { username, email } = tombstoneIdentity();
    await executeQuery(`
        UPDATE users
        SET username = ?, email = ?, password_hash = ?, full_name = ?, avatar_url = NULL, bio = NULL,
            custom_status_text = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL,
            birthday_day = NULL, birthday_month = NULL, birthday_year = NULL,
            status = 'offline', last_seen = NULL, email_verified_at = NULL,
            is_admin = FALSE, suspended_at = NULL, suspended_reason = NULL,
            totp_secret_enc = NULL, totp_pending_enc = NULL, totp_pending_at = NULL, totp_enabled_at = NULL,
            totp_last_step = NULL, totp_failed_attempts = 0, totp_locked_until = NULL,
            deletion_requested_at = NULL, deletion_due_at = NULL
        WHERE id = ?
    `, [username, email, UNUSABLE_PASSWORD, DELETED_NAME, userId]);
}

/**
 * Remove a user's personal data. Claims the account first, which ends the chance to cancel.
 * @returns {Promise<boolean>} false when the deletion was cancelled in the meantime
 */
async function purgeAccount(io, userId) {
    const user = await queryOne('SELECT id, username, email, avatar_url, deleted_at, deletion_due_at FROM users WHERE id = ?', [userId]);
    if (!user || !user.deletion_due_at) return false;

    const claimed = await updateAndCount(
        "UPDATE users SET deleted_at = CURRENT_TIMESTAMP, status = 'offline' WHERE id = ? AND deleted_at IS NULL AND deletion_due_at <= CURRENT_TIMESTAMP",
        [userId]
    );
    if (claimed === 0 && !user.deleted_at) return false;

    await sessions.revokeUserSessions(io, userId, 'deletion');
    if (io && typeof io.in === 'function') io.in(`user_${userId}`).disconnectSockets(true);

    await leaveChats(io, userId);
    await removeUploads(io, userId);
    await deleteUserExports(userId);
    await removeQuarantinedFiles(userId);

    // Delete for everyone only hid these
    await executeQuery('UPDATE messages SET content = NULL WHERE sender_id = ? AND deleted_for_everyone = TRUE', [userId]);
    await executeQuery('UPDATE report_evidence SET sender_id = NULL, sender_username = ? WHERE sender_id = ?', [DELETED_NAME, userId]);
    await executeQuery('UPDATE reports SET reporter_id = NULL WHERE reporter_id = ?', [userId]);

    for (const [table, column] of DELETED_ROWS) {
        await executeQuery(`DELETE FROM ${table} WHERE ${column} = ?`, [userId]);
    }

    await avatars.deleteUserAvatar(user.avatar_url);
    await writeTombstone(userId);

    await auditLog.record('account_deleted', { targetType: 'user', targetId: userId });
    await emitProfileUpdate(io, userId).catch(error => console.error('Deleted account profile update:', error.message));

    if (claimed > 0) notifySecurityEvent(user, 'account_deleted');
    return true;
}

/**
 * Scheduler: accounts whose grace period is over, and purges that failed before
 * @returns {Promise<{ deleted: number }>}
 */
async function processDueDeletions(io) {
    const rows = await executeQuery(`
        SELECT id FROM users
        WHERE deletion_due_at IS NOT NULL AND deletion_due_at <= CURRENT_TIMESTAMP
        ORDER BY deletion_due_at
        LIMIT ${DELETION_BATCH_SIZE}
    `);

    let deleted = 0;
    for (const row of rows) {
        try {
            if (await purgeAccount(io, row.id)) deleted++;
        } catch (error) {
            // Tried again next tick: it stays due until the tombstone is written
            console.error(`Deleting account ${row.id} failed:`, error.message);
        }
    }
    return { deleted };
}

module.exports = {
    DELETED_NAME,
    DELETED_ROWS,
    KEPT_REFERENCES,
    scheduleDeletion,
    cancelDeletion,
    purgeAccount,
    processDueDeletions
};
