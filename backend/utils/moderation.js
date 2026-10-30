/**
 * What admins can do to accounts and messages, and the warnings users see.
 * Controllers check the admin flag and write the audit entry; these functions do the work.
 */

const { executeQuery, queryOne, updateAndCount, insertAndGetId } = require('../config/database');
const { ADMIN_PAGE_SIZE } = require('../config/moderation');
const { revokeUserSessions } = require('./sessions');
const { deleteOrphanedFiles } = require('./uploads');
const { toBool } = require('./messageQueries');

const NOT_FOUND = { status: 404, message: 'User not found' };

function escapeLike(text) {
    return `%${String(text).toLowerCase().replace(/[|%_]/g, '|$&')}%`;
}

function shapeUser(row) {
    return {
        id: Number(row.id),
        username: row.username,
        email: row.email,
        fullName: row.full_name || null,
        isAdmin: toBool(row.is_admin),
        suspended: !!row.suspended_at,
        suspendedAt: row.suspended_at || null,
        suspendedReason: row.suspended_reason || null,
        status: row.status,
        lastSeen: row.last_seen || null,
        createdAt: row.created_at,
        openReports: parseInt(row.open_reports, 10) || 0
    };
}

/**
 * Newest accounts first. q matches username, email or name; status 'suspended' | 'active'.
 */
async function searchUsers({ q, status, before } = {}) {
    const where = [];
    const params = [];
    if (q) {
        const like = escapeLike(q);
        where.push("(LOWER(u.username) LIKE ? ESCAPE '|' OR LOWER(u.email) LIKE ? ESCAPE '|' OR LOWER(u.full_name) LIKE ? ESCAPE '|')");
        params.push(like, like, like);
    }
    if (status === 'suspended') where.push('u.suspended_at IS NOT NULL');
    if (status === 'active') where.push('u.suspended_at IS NULL');
    if (before) {
        where.push('u.id < ?');
        params.push(before);
    }

    const rows = await executeQuery(`
        SELECT u.id, u.username, u.email, u.full_name, u.is_admin, u.suspended_at, u.suspended_reason,
               u.status, u.last_seen, u.created_at,
               (SELECT COUNT(*) FROM reports r WHERE r.reported_user_id = u.id AND r.status = 'open') AS open_reports
        FROM users u
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY u.id DESC
        LIMIT ${ADMIN_PAGE_SIZE + 1}
    `, params);

    const page = rows.slice(0, ADMIN_PAGE_SIZE).map(shapeUser);
    return { users: page, nextCursor: rows.length > ADMIN_PAGE_SIZE ? page[page.length - 1].id : null };
}

/**
 * Suspend an account: no sign-in, every session ended, sockets dropped, nothing left that would
 * reach people on its behalf. Admins can't be suspended; take the flag away first (CLI).
 * @returns {Promise<{ revokedSessions } | { error }>}
 */
async function suspendUser(io, userId, reason) {
    const user = await queryOne('SELECT id, is_admin, suspended_at FROM users WHERE id = ?', [userId]);
    if (!user) return { error: NOT_FOUND };
    if (toBool(user.is_admin)) return { error: { status: 403, message: 'Admins can\'t be suspended. Remove the admin flag first.' } };
    if (user.suspended_at) return { error: { status: 409, message: 'This account is already suspended' } };

    const changed = await updateAndCount(
        "UPDATE users SET suspended_at = CURRENT_TIMESTAMP, suspended_reason = ?, status = 'offline' WHERE id = ? AND suspended_at IS NULL",
        [reason || null, userId]
    );
    if (changed === 0) return { error: { status: 409, message: 'This account is already suspended' } };

    const revokedSessions = await revokeUserSessions(io, userId, 'suspended');

    // Whatever still holds a socket of this user (the session rooms cover active sessions only)
    if (io && typeof io.in === 'function') io.in(`user_${userId}`).disconnectSockets(true);

    await executeQuery('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
    await executeQuery(
        "UPDATE scheduled_messages SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'pending'",
        [userId]
    );

    return { revokedSessions };
}

/**
 * @returns {Promise<{ ok: true } | { error }>}
 */
async function unsuspendUser(userId) {
    const user = await queryOne('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) return { error: NOT_FOUND };

    const changed = await updateAndCount(
        'UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND suspended_at IS NOT NULL',
        [userId]
    );
    if (changed === 0) return { error: { status: 409, message: 'This account isn\'t suspended' } };
    return { ok: true };
}

/**
 * End every session of a user. They can sign in again.
 * @returns {Promise<{ revokedSessions } | { error }>}
 */
async function forceLogout(io, userId) {
    const user = await queryOne('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) return { error: NOT_FOUND };
    return { revokedSessions: await revokeUserSessions(io, userId, 'admin') };
}

/**
 * Warn a user. They see it right away if online, otherwise when they next open the app.
 * @returns {Promise<{ warningId } | { error }>}
 */
async function warnUser(io, userId, adminId, message, reportId = null) {
    const user = await queryOne('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) return { error: NOT_FOUND };

    const warningId = await insertAndGetId(
        'INSERT INTO user_warnings (user_id, admin_id, report_id, message) VALUES (?, ?, ?, ?)',
        [userId, adminId, reportId, message]
    );
    if (io) io.to(`user_${userId}`).emit('account_warning', { id: Number(warningId), message });
    return { warningId: Number(warningId) };
}

async function listOpenWarnings(userId) {
    const rows = await executeQuery(
        'SELECT id, message, created_at FROM user_warnings WHERE user_id = ? AND acknowledged_at IS NULL ORDER BY id ASC',
        [userId]
    );
    return rows.map(row => ({ id: Number(row.id), message: row.message, createdAt: row.created_at }));
}

/**
 * @returns {Promise<boolean>} false unless this is the user's own open warning
 */
async function acknowledgeWarning(userId, warningId) {
    const changed = await updateAndCount(
        'UPDATE user_warnings SET acknowledged_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL',
        [warningId, userId]
    );
    return changed > 0;
}

/**
 * Take a message down for everyone, whatever its age, and its attachment with it (a forwarded copy
 * keeps the file). Report evidence is a separate copy and isn't touched.
 * @returns {Promise<{ deleted: boolean }>} deleted is false when it was already gone
 */
async function deleteMessageForEveryone(io, messageId, adminId) {
    const message = await queryOne('SELECT id, chat_id, file_id, deleted_for_everyone FROM messages WHERE id = ?', [messageId]);
    if (!message || toBool(message.deleted_for_everyone)) return { deleted: false };

    await executeQuery(
        'UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, deleted_for_everyone = TRUE, file_id = NULL WHERE id = ?',
        [adminId, messageId]
    );

    if (io) {
        io.to(`chat_${message.chat_id}`).emit('message_deleted', {
            messageId: Number(message.id),
            chatId: Number(message.chat_id),
            deletedForEveryone: true
        });
    }
    if (message.file_id) await deleteOrphanedFiles([message.file_id]);
    return { deleted: true };
}

module.exports = {
    searchUsers,
    suspendUser,
    unsuspendUser,
    forceLogout,
    warnUser,
    listOpenWarnings,
    acknowledgeWarning,
    deleteMessageForEveryone
};
