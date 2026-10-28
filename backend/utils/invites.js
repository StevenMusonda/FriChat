/**
 * Group invite links.
 *
 * A link carries a random 128-bit token (22 base64url characters). The database keeps only
 * its SHA-256 hash, plus the first 4 characters as a hint so admins can tell links apart,
 * so a database leak doesn't hand out working links. The full link is shown once, when created.
 */

const crypto = require('crypto');
const { executeQuery, queryOne, insertAndGetId } = require('../config/database');

const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_HINT_LENGTH = 4;

// Whitelisted SQL intervals (never built from client input)
const INVITE_EXPIRY_INTERVALS = {
    '1h': { pg: "INTERVAL '1 hour'", mysql: 'INTERVAL 1 HOUR' },
    '1d': { pg: "INTERVAL '1 day'", mysql: 'INTERVAL 1 DAY' },
    '7d': { pg: "INTERVAL '7 days'", mysql: 'INTERVAL 7 DAY' }
};

// Why a link can't be used, in the words the join page shows
const INVITE_ERRORS = {
    DISABLED: { status: 404, code: 'DISABLED', message: 'Invite links are turned off on this server.' },
    INVALID: { status: 404, code: 'INVALID', message: 'This invite link is invalid. Check that you copied the whole link.' },
    REVOKED: { status: 410, code: 'REVOKED', message: 'This invite link has been revoked by a group admin.' },
    EXPIRED: { status: 410, code: 'EXPIRED', message: 'This invite link has expired. Ask a group admin for a new one.' },
    USED_UP: { status: 410, code: 'USED_UP', message: 'This invite link has reached its maximum number of uses.' }
};

function generateInviteToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashInviteToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isValidInviteToken(token) {
    return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/**
 * Public link for a token: <FRONTEND_URL>/join.html?code=<token> (same base as password reset links)
 */
function buildInviteUrl(token) {
    const base = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
    return `${base}/join.html?code=${encodeURIComponent(token)}`;
}

// Columns every invite query reads; is_expired is decided by the database clock, like mutes
const INVITE_COLUMNS = `
    ci.id, ci.chat_id, ci.token_hint, ci.created_by, ci.expires_at, ci.max_uses, ci.use_count,
    ci.revoked_at, ci.created_at,
    CASE WHEN ci.expires_at IS NOT NULL AND ci.expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_expired
`;

/**
 * 'active' | 'revoked' | 'expired' | 'used_up' (revoked wins, then expiry, then the use limit)
 */
function inviteStatus(invite) {
    if (invite.revoked_at) return 'revoked';
    if (parseInt(invite.is_expired) === 1 || invite.is_expired === true) return 'expired';
    if (invite.max_uses !== null && invite.max_uses !== undefined && Number(invite.use_count) >= Number(invite.max_uses)) {
        return 'used_up';
    }
    return 'active';
}

function inviteErrorFor(status) {
    return {
        revoked: INVITE_ERRORS.REVOKED,
        expired: INVITE_ERRORS.EXPIRED,
        used_up: INVITE_ERRORS.USED_UP
    }[status] || null;
}

/**
 * How an invite is shown to admins (never includes the token or its hash)
 */
function shapeInvite(invite) {
    return {
        id: invite.id,
        chatId: invite.chat_id,
        tokenHint: invite.token_hint,
        createdBy: invite.created_by,
        createdByUsername: invite.created_by_username || null,
        createdAt: invite.created_at,
        expiresAt: invite.expires_at || null,
        maxUses: invite.max_uses === null || invite.max_uses === undefined ? null : Number(invite.max_uses),
        useCount: Number(invite.use_count) || 0,
        revokedAt: invite.revoked_at || null,
        status: inviteStatus(invite)
    };
}

/**
 * Create a link for a group. expiresIn: '1h' | '1d' | '7d' | 'never'; maxUses: positive int or null.
 * @returns {{ token, invite }} - the token is returned only here
 */
async function createInvite(chatId, userId, expiresIn, maxUses) {
    const token = generateInviteToken();
    const interval = INVITE_EXPIRY_INTERVALS[expiresIn];
    const expiresSql = interval
        ? `CURRENT_TIMESTAMP + ${process.env.DB_TYPE === 'postgresql' ? interval.pg : interval.mysql}`
        : 'NULL';

    const id = await insertAndGetId(
        `INSERT INTO chat_invites (chat_id, token_hash, token_hint, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ${expiresSql}, ?)`,
        [chatId, hashInviteToken(token), token.slice(0, TOKEN_HINT_LENGTH), userId, maxUses || null]
    );

    const invite = await getInviteById(chatId, id);
    return { token, invite };
}

async function getInviteById(chatId, inviteId) {
    const row = await queryOne(`
        SELECT ${INVITE_COLUMNS}, u.username AS created_by_username
        FROM chat_invites ci
        LEFT JOIN users u ON u.id = ci.created_by
        WHERE ci.id = ? AND ci.chat_id = ?
    `, [inviteId, chatId]);
    return row ? shapeInvite(row) : null;
}

/**
 * A group's links, newest first
 */
async function listInvites(chatId) {
    const rows = await executeQuery(`
        SELECT ${INVITE_COLUMNS}, u.username AS created_by_username
        FROM chat_invites ci
        LEFT JOIN users u ON u.id = ci.created_by
        WHERE ci.chat_id = ?
        ORDER BY ci.created_at DESC, ci.id DESC
    `, [chatId]);
    return rows.map(shapeInvite);
}

/**
 * @returns {Promise<boolean>} false if the link doesn't belong to the group or was already revoked
 */
async function revokeInvite(chatId, inviteId) {
    const sql = 'UPDATE chat_invites SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND chat_id = ? AND revoked_at IS NULL';
    if (process.env.DB_TYPE === 'postgresql') {
        const rows = await executeQuery(`${sql} RETURNING id`, [inviteId, chatId]);
        return rows.length === 1;
    }
    const result = await executeQuery(sql, [inviteId, chatId]);
    return result.affectedRows === 1;
}

/**
 * Look a token up and say whether it can be used.
 * @returns {{ error } | { invite }} - invite is the raw row (with chat_type) when usable
 */
async function resolveInvite(token) {
    if (!isValidInviteToken(token)) {
        return { error: INVITE_ERRORS.INVALID };
    }

    const invite = await queryOne(`
        SELECT ${INVITE_COLUMNS}, c.chat_type
        FROM chat_invites ci
        JOIN chats c ON c.id = ci.chat_id
        WHERE ci.token_hash = ?
    `, [hashInviteToken(token)]);

    // Links only ever point at groups
    if (!invite || invite.chat_type !== 'group') {
        return { error: INVITE_ERRORS.INVALID };
    }

    const statusError = inviteErrorFor(inviteStatus(invite));
    if (statusError) {
        return { error: statusError };
    }

    return { invite };
}

/**
 * Count one use, but only while the link is still usable. One conditional UPDATE, so two people
 * racing for the last use of a link can't both get in.
 * @returns {Promise<boolean>}
 */
async function consumeInviteUse(inviteId) {
    const sql = `
        UPDATE chat_invites SET use_count = use_count + 1
        WHERE id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        AND (max_uses IS NULL OR use_count < max_uses)
    `;
    if (process.env.DB_TYPE === 'postgresql') {
        const rows = await executeQuery(`${sql} RETURNING id`, [inviteId]);
        return rows.length === 1;
    }
    const result = await executeQuery(sql, [inviteId]);
    return result.affectedRows === 1;
}

/**
 * Give a use back when the join it was counted for didn't happen
 */
async function releaseInviteUse(inviteId) {
    try {
        await executeQuery('UPDATE chat_invites SET use_count = use_count - 1 WHERE id = ? AND use_count > 0', [inviteId]);
    } catch (error) {
        console.error('Release invite use error:', error);
    }
}

module.exports = {
    TOKEN_PATTERN,
    INVITE_ERRORS,
    generateInviteToken,
    hashInviteToken,
    isValidInviteToken,
    buildInviteUrl,
    inviteStatus,
    inviteErrorFor,
    shapeInvite,
    createInvite,
    getInviteById,
    listInvites,
    revokeInvite,
    resolveInvite,
    consumeInviteUse,
    releaseInviteUse
};
