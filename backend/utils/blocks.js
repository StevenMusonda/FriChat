/**
 * Blocking. A block stops direct messages both ways (sending, forwarding, uploads, reactions and
 * edits in the shared direct chat), hides the blocker's online status and typing from the blocked
 * user, keeps the blocked user from adding the blocker to groups, and drops @mentions and pushes
 * from the blocked user to the blocker. Every rule is enforced here on the server.
 */

const { executeQuery, queryOne } = require('../config/database');

function isDuplicateKeyError(error) {
    return !!error && (error.code === 'ER_DUP_ENTRY' || error.code === '23505');
}

/**
 * @returns {Promise<boolean>} false if already blocked
 */
async function blockUser(blockerId, blockedId) {
    try {
        await executeQuery('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', [blockerId, blockedId]);
        return true;
    } catch (error) {
        if (isDuplicateKeyError(error)) return false;
        throw error;
    }
}

/**
 * @returns {Promise<boolean>} false if there was no block
 */
async function unblockUser(blockerId, blockedId) {
    const existing = await queryOne('SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
    if (!existing) return false;
    await executeQuery('DELETE FROM user_blocks WHERE id = ?', [existing.id]);
    return true;
}

async function listBlockedUsers(userId) {
    const rows = await executeQuery(`
        SELECT u.id, u.username, u.full_name, u.avatar_url, b.created_at
        FROM user_blocks b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC, b.id DESC
    `, [userId]);
    return rows.map(row => ({
        id: Number(row.id),
        username: row.username,
        fullName: row.full_name || null,
        avatarUrl: row.avatar_url || null,
        blockedAt: row.created_at
    }));
}

/**
 * Users this user blocked, and users who blocked this user
 * @returns {Promise<{ blocked: number[], blockedBy: number[] }>}
 */
async function getBlockRelations(userId) {
    const rows = await executeQuery(
        'SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?',
        [userId, userId]
    );
    const blocked = [];
    const blockedBy = [];
    for (const row of rows) {
        if (Number(row.blocker_id) === Number(userId)) blocked.push(Number(row.blocked_id));
        else blockedBy.push(Number(row.blocker_id));
    }
    return { blocked, blockedBy };
}

/**
 * Ids of users who blocked userId (their status is shown to userId as offline)
 */
async function getBlockerIds(userId) {
    const rows = await executeQuery('SELECT blocker_id FROM user_blocks WHERE blocked_id = ?', [userId]);
    return new Set(rows.map(row => Number(row.blocker_id)));
}

/**
 * Show users who blocked the viewer as offline (rows with id/userId and status)
 */
function maskBlockerStatus(rows, blockerIds) {
    if (!blockerIds || blockerIds.size === 0) return rows;
    for (const row of rows) {
        const id = Number(row.id !== undefined ? row.id : row.userId);
        if (blockerIds.has(id)) {
            row.status = 'offline';
            if ('last_seen' in row) row.last_seen = null;
        }
    }
    return rows;
}

function blockedError(blockerId, userId) {
    return Number(blockerId) === Number(userId)
        ? { status: 403, code: 'BLOCKED', message: 'You blocked this user. Unblock them to send messages.' }
        : { status: 403, code: 'BLOCKED', message: 'You can\'t send messages to this user.' };
}

/**
 * Is there a block either way between the two users?
 * @returns {Promise<object|null>} error (worded for userId) or null
 */
async function checkBlockBetween(userId, otherUserId) {
    const row = await queryOne(
        'SELECT blocker_id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
        [userId, otherUserId, otherUserId, userId]
    );
    return row ? blockedError(row.blocker_id, userId) : null;
}

/**
 * For a direct chat: is there a block either way between userId and the other member?
 * Group chats (and chats the user isn't in) return null - membership is checked elsewhere.
 * @returns {Promise<object|null>} error or null
 */
async function checkDirectChatBlock(chatId, userId) {
    const row = await queryOne(`
        SELECT ub.blocker_id
        FROM chats c
        JOIN group_members gm ON gm.chat_id = c.id AND gm.user_id <> ?
        JOIN user_blocks ub ON (ub.blocker_id = gm.user_id AND ub.blocked_id = ?) OR (ub.blocker_id = ? AND ub.blocked_id = gm.user_id)
        WHERE c.id = ? AND c.chat_type = 'direct'
        LIMIT 1
    `, [userId, userId, userId, chatId]);
    return row ? blockedError(row.blocker_id, userId) : null;
}

/**
 * Which of candidateIds have blocked userId (they can't be added to groups by userId)
 */
async function findBlockersAmong(userId, candidateIds) {
    const ids = [...new Set(candidateIds.map(Number))].filter(Number.isInteger);
    if (ids.length === 0) return [];
    const rows = await executeQuery(
        `SELECT blocker_id FROM user_blocks WHERE blocked_id = ? AND blocker_id IN (${ids.map(() => '?').join(', ')})`,
        [userId, ...ids]
    );
    return rows.map(row => Number(row.blocker_id));
}

module.exports = {
    blockUser,
    unblockUser,
    listBlockedUsers,
    getBlockRelations,
    getBlockerIds,
    maskBlockerStatus,
    checkBlockBetween,
    checkDirectChatBlock,
    findBlockersAmong
};
