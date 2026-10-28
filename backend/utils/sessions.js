/**
 * Sessions: one row per signed-in device.
 *
 * The client holds a short-lived access JWT (in memory, carries userId + sid) and a refresh token in an
 * HttpOnly cookie. Only SHA-256 hashes of refresh tokens are stored. Every refresh rotates the token;
 * the old hash moves to session_refresh_tokens, and presenting it again (after a short grace period
 * for two tabs racing) revokes the whole session, because it means someone else holds a copy.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { executeQuery, queryOne } = require('../config/database');
const authConfig = require('../config/auth');

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60 * 1000;
const REVOKED_REASONS = ['logout', 'user', 'password', 'reuse'];

const isPostgres = () => process.env.DB_TYPE === 'postgresql';

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateRefreshToken() {
    return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

function isWellFormedRefreshToken(token) {
    return typeof token === 'string' && REFRESH_TOKEN_PATTERN.test(token);
}

// --- SQL helpers (the only values put into SQL text are these fixed snippets; amounts are parameters) ---

function plusDaysSql() {
    return isPostgres()
        ? "CURRENT_TIMESTAMP + CAST(? AS INTEGER) * INTERVAL '1 day'"
        : 'DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY)';
}

function minusSecondsSql() {
    return isPostgres()
        ? "CURRENT_TIMESTAMP - CAST(? AS INTEGER) * INTERVAL '1 second'"
        : 'DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? SECOND)';
}

function minusDaysSql() {
    return isPostgres()
        ? "CURRENT_TIMESTAMP - CAST(? AS INTEGER) * INTERVAL '1 day'"
        : 'DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)';
}

/**
 * Rows changed by an UPDATE/DELETE on either database
 */
async function countAffected(sql, params) {
    if (isPostgres()) {
        return (await executeQuery(`${sql} RETURNING id`, params)).length;
    }
    const result = await executeQuery(sql, params);
    return result.affectedRows || 0;
}

const toBool = (value) => value === true || value === 1 || value === '1';

// --- device and request info ---

/**
 * 'Chrome on Windows', 'Safari on iPhone', ... from a user agent (no external parser, no fingerprinting)
 */
function describeDevice(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return 'Unknown device';

    let browser = null;
    if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
    else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
    else if (/CriOS\/|Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Version\/[\d.]+.*Safari\//.test(ua)) browser = 'Safari';

    let os = null;
    if (/iPhone/.test(ua)) os = 'iPhone';
    else if (/iPad/.test(ua)) os = 'iPad';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    if (!browser && !os) return 'Unknown device';
    return `${browser || 'Browser'} on ${os || 'unknown system'}`;
}

/**
 * Client IP as Express sees it (honours TRUST_PROXY), without the IPv4-mapped IPv6 prefix
 */
function normalizeIp(ip) {
    if (!ip) return null;
    const value = String(ip).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
    return value.slice(0, 45);
}

function requestMeta(req) {
    const userAgent = (req.headers && req.headers['user-agent']) || '';
    return { userAgent: userAgent.slice(0, 255), ip: normalizeIp(req.ip) };
}

// --- access tokens ---

/**
 * @returns {{ accessToken: string, expiresIn: number }} expiresIn in seconds
 */
function signAccessToken(user, sessionId) {
    const accessToken = jwt.sign(
        { userId: user.id, username: user.username, sid: sessionId },
        process.env.JWT_SECRET,
        { expiresIn: authConfig.accessTokenTtl() }
    );
    const { exp, iat } = jwt.decode(accessToken);
    return { accessToken, expiresIn: exp - iat };
}

/**
 * Verify an access JWT. Tokens from before sessions existed (no sid) are refused.
 * @returns {{ userId, sid } | null}
 */
function verifyAccessToken(token) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const sid = Number(decoded.sid);
        if (!decoded.userId || !Number.isInteger(sid) || sid < 1) return null;
        return { userId: decoded.userId, sid };
    } catch (error) {
        return null;
    }
}

/**
 * The signed-in user for an access token's session, or null if the session was revoked
 */
async function findSessionUser(userId, sessionId) {
    return queryOne(`
        SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.status, u.email_verified_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL
    `, [sessionId, userId]);
}

// --- refresh cookie ---

function readRefreshCookie(req) {
    const header = req.headers && req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        if (part.slice(0, index).trim() === authConfig.REFRESH_COOKIE_NAME) {
            try {
                return decodeURIComponent(part.slice(index + 1).trim());
            } catch (error) {
                return null;
            }
        }
    }
    return null;
}

function setRefreshCookie(res, token) {
    res.cookie(authConfig.REFRESH_COOKIE_NAME, token, authConfig.refreshCookieOptions());
}

function clearRefreshCookie(res) {
    const { maxAge, ...options } = authConfig.refreshCookieOptions();
    res.clearCookie(authConfig.REFRESH_COOKIE_NAME, options);
}

// --- session lifecycle ---

/**
 * New session at login/registration
 * @returns {{ sessionId, refreshToken }}
 */
async function createSession(userId, { userAgent, ip }) {
    const refreshToken = generateRefreshToken();
    const sql = `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, device_label, ip_address, expires_at)
        VALUES (?, ?, ?, ?, ?, ${plusDaysSql()})`;
    const params = [userId, hashToken(refreshToken), userAgent || null, describeDevice(userAgent), ip || null, authConfig.refreshTokenTtlDays()];

    let sessionId;
    if (isPostgres()) {
        sessionId = (await executeQuery(`${sql} RETURNING id`, params))[0].id;
    } else {
        sessionId = (await executeQuery(sql, params)).insertId;
    }
    lastTouched.set(Number(sessionId), Date.now());
    return { sessionId: Number(sessionId), refreshToken };
}

function isDuplicateKeyError(error) {
    return !!error && (error.code === 'ER_DUP_ENTRY' || error.code === '23505');
}

/**
 * Exchange a refresh token for a new one.
 * @returns {{ sessionId, userId, refreshToken }
 *   | { error: 'invalid' }   unknown, expired or revoked: sign in again
 *   | { error: 'race' }      rotated by a parallel request a moment ago: retry with the newer cookie
 *   | { error: 'reused', sessionId, userId }  an already-rotated token: the caller revokes the session}
 */
async function rotateRefreshToken(token, { ip } = {}) {
    if (!isWellFormedRefreshToken(token)) return { error: 'invalid' };
    const hash = hashToken(token);

    const session = await queryOne(`
        SELECT id, user_id, revoked_at,
            CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_expired
        FROM sessions
        WHERE refresh_token_hash = ?
    `, [hash]);

    if (session) {
        if (session.revoked_at || toBool(session.is_expired)) {
            return { error: 'invalid' };
        }

        // Recorded before the swap, so a request that loses the race always finds the old token here
        try {
            await executeQuery('INSERT INTO session_refresh_tokens (session_id, token_hash) VALUES (?, ?)', [session.id, hash]);
        } catch (error) {
            if (isDuplicateKeyError(error)) return { error: 'race' };
            throw error;
        }

        const next = generateRefreshToken();
        const swapped = await countAffected(
            `UPDATE sessions SET refresh_token_hash = ?, last_active_at = CURRENT_TIMESTAMP, ip_address = ?, expires_at = ${plusDaysSql()}
             WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
            [hashToken(next), ip || null, authConfig.refreshTokenTtlDays(), session.id, hash]
        );
        if (swapped !== 1) return { error: 'race' };

        lastTouched.set(Number(session.id), Date.now());
        return { sessionId: Number(session.id), userId: Number(session.user_id), refreshToken: next };
    }

    const used = await queryOne(`
        SELECT t.session_id, s.user_id, s.revoked_at,
            CASE WHEN t.rotated_at > ${minusSecondsSql()} THEN 1 ELSE 0 END AS in_grace
        FROM session_refresh_tokens t
        JOIN sessions s ON s.id = t.session_id
        WHERE t.token_hash = ?
    `, [authConfig.refreshReuseGraceSeconds(), hash]);

    if (!used) return { error: 'invalid' };
    if (used.revoked_at) return { error: 'invalid' };
    if (toBool(used.in_grace)) return { error: 'race' };
    return { error: 'reused', sessionId: Number(used.session_id), userId: Number(used.user_id) };
}

/**
 * The live session a refresh token belongs to (for logout with an expired access token), or null
 */
async function findSessionByRefreshToken(token) {
    if (!isWellFormedRefreshToken(token)) return null;
    return queryOne(
        'SELECT id, user_id FROM sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL',
        [hashToken(token)]
    );
}

/**
 * Tell every socket of these sessions why, then disconnect them (works across tabs; no-op without io)
 */
function disconnectSessions(io, sessionIds, reason) {
    if (!io || typeof io.in !== 'function') return;
    for (const sessionId of sessionIds) {
        const room = `session_${sessionId}`;
        io.to(room).emit('session_revoked', { reason });
        io.in(room).disconnectSockets(true);
    }
}

/**
 * Revoke one session (only the user's own when userId is given) and drop its sockets
 * @returns {Promise<boolean>} false if it didn't exist, wasn't theirs, or was already revoked
 */
async function revokeSession(io, sessionId, reason, userId = null) {
    const safeReason = REVOKED_REASONS.includes(reason) ? reason : 'user';
    const params = [safeReason, sessionId];
    let sql = 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL';
    if (userId !== null) {
        sql += ' AND user_id = ?';
        params.push(userId);
    }
    const revoked = (await countAffected(sql, params)) > 0;
    if (revoked) disconnectSessions(io, [sessionId], safeReason);
    return revoked;
}

/**
 * Revoke all of a user's sessions, optionally keeping one (the device that asked)
 * @returns {Promise<number>} how many were revoked
 */
async function revokeUserSessions(io, userId, reason, exceptSessionId = null) {
    const safeReason = REVOKED_REASONS.includes(reason) ? reason : 'user';
    const keep = exceptSessionId ? ' AND id <> ?' : '';
    const keepParams = exceptSessionId ? [exceptSessionId] : [];

    const rows = await executeQuery(
        `SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL${keep}`,
        [userId, ...keepParams]
    );
    if (rows.length === 0) return 0;

    await executeQuery(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL${keep}`,
        [safeReason, userId, ...keepParams]
    );
    disconnectSessions(io, rows.map(row => row.id), safeReason);
    return rows.length;
}

/**
 * Active (not revoked, not expired) sessions, most recently used first
 */
async function listActiveSessions(userId) {
    const rows = await executeQuery(`
        SELECT id, device_label, user_agent, ip_address, created_at, last_active_at
        FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        ORDER BY last_active_at DESC, id DESC
    `, [userId]);
    return rows.map(row => ({
        id: Number(row.id),
        device: row.device_label || describeDevice(row.user_agent),
        userAgent: row.user_agent || null,
        ipAddress: row.ip_address || null,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at
    }));
}

// sessionId -> ms of the last last_active_at write, so busy clients don't write on every request
const lastTouched = new Map();

/**
 * Record activity at most once a minute per session (never throws)
 */
function touchSession(sessionId, ip) {
    const now = Date.now();
    const last = lastTouched.get(sessionId) || 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    if (lastTouched.size > 10000) lastTouched.clear();
    lastTouched.set(sessionId, now);
    executeQuery(
        'UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP, ip_address = COALESCE(?, ip_address) WHERE id = ? AND revoked_at IS NULL',
        [ip || null, sessionId]
    ).catch(error => console.error('Touch session error:', error.message));
}

/**
 * Housekeeping: sessions expired or revoked more than a refresh lifetime ago (their rotated tokens go with them)
 */
async function purgeOldSessions() {
    const days = authConfig.refreshTokenTtlDays();
    await executeQuery(
        `DELETE FROM sessions WHERE expires_at < ${minusDaysSql()} OR (revoked_at IS NOT NULL AND revoked_at < ${minusDaysSql()})`,
        [days, days]
    );
}

module.exports = {
    REFRESH_TOKEN_PATTERN,
    hashToken,
    generateRefreshToken,
    isWellFormedRefreshToken,
    describeDevice,
    normalizeIp,
    requestMeta,
    signAccessToken,
    verifyAccessToken,
    findSessionUser,
    readRefreshCookie,
    setRefreshCookie,
    clearRefreshCookie,
    createSession,
    rotateRefreshToken,
    findSessionByRefreshToken,
    disconnectSessions,
    revokeSession,
    revokeUserSessions,
    listActiveSessions,
    touchSession,
    purgeOldSessions
};
