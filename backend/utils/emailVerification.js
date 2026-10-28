/**
 * Email verification: single-use, expiring links (only a SHA-256 hash of the token is stored),
 * and the rules for what an unverified account may not do yet.
 */

const crypto = require('crypto');
const { executeQuery, queryOne } = require('../config/database');
const { emailVerificationTtlHours } = require('../config/auth');
const { sendVerificationEmail } = require('./mailer');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const NOT_VERIFIED = {
    status: 403,
    code: 'EMAIL_NOT_VERIFIED',
    message: 'Please verify your email address first. Check your inbox or resend the link from Settings.'
};

function hashVerificationToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isEmailVerified(user) {
    return !!(user && user.email_verified_at);
}

/**
 * Error object for controllers when the signed-in user hasn't verified their email, else null
 */
function requireVerifiedEmail(user, action) {
    if (isEmailVerified(user)) return null;
    return action
        ? { ...NOT_VERIFIED, message: `Please verify your email address before you ${action}. Check your inbox or resend the link from Settings.` }
        : NOT_VERIFIED;
}

function frontendBase() {
    return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
}

/**
 * Replace the user's pending link with a new one and email it (the email is not awaited by callers
 * that must not reveal timing; errors are logged)
 * @returns {Promise<string>} the token (tests use it; never sent to the client)
 */
async function issueVerification(user) {
    await executeQuery('DELETE FROM email_verifications WHERE user_id = ?', [user.id]);

    const token = crypto.randomBytes(32).toString('hex');
    const hours = emailVerificationTtlHours();
    const expiresSql = process.env.DB_TYPE === 'postgresql'
        ? "CURRENT_TIMESTAMP + CAST(? AS INTEGER) * INTERVAL '1 hour'"
        : 'DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? HOUR)';

    await executeQuery(
        `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ${expiresSql})`,
        [user.id, hashVerificationToken(token), hours]
    );

    const url = `${frontendBase()}/verify-email.html?token=${token}`;
    sendVerificationEmail(user.email, user.username, url, hours)
        .catch(error => console.error('Verification email error:', error));
    return token;
}

/**
 * Use a link. Marks the email verified and deletes the user's links (single-use).
 * @returns {Promise<number|null>} the user id, or null if the token is unknown or expired
 */
async function consumeVerification(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;

    const row = await queryOne(
        'SELECT user_id FROM email_verifications WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP',
        [hashVerificationToken(token)]
    );
    if (!row) return null;

    await executeQuery('DELETE FROM email_verifications WHERE user_id = ?', [row.user_id]);
    await executeQuery(
        'UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ? AND email_verified_at IS NULL',
        [row.user_id]
    );
    return Number(row.user_id);
}

/**
 * Do the two users already share any chat (direct or group)?
 */
async function sharesChat(userId, otherUserId) {
    const row = await queryOne(`
        SELECT a.chat_id
        FROM group_members a
        JOIN group_members b ON b.chat_id = a.chat_id
        WHERE a.user_id = ? AND b.user_id = ?
        LIMIT 1
    `, [userId, otherUserId]);
    return !!row;
}

/**
 * Unverified users may only start chats with (or add) people they already share a chat with.
 * @returns {Promise<object|null>} error or null
 */
async function checkUnverifiedContact(user, otherUserIds) {
    if (isEmailVerified(user)) return null;
    for (const otherId of otherUserIds) {
        if (!(await sharesChat(user.id, otherId))) {
            return requireVerifiedEmail(user, 'message people you don\'t share a chat with');
        }
    }
    return null;
}

module.exports = {
    TOKEN_PATTERN,
    NOT_VERIFIED,
    hashVerificationToken,
    isEmailVerified,
    requireVerifiedEmail,
    issueVerification,
    consumeVerification,
    sharesChat,
    checkUnverifiedContact
};
