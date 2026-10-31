/**
 * Recognising a browser, for the "new sign-in" email. A random id in a long-lived HttpOnly cookie
 * says "this browser was here before"; nothing is derived from the browser itself (no fingerprinting).
 * It is hashed with the user id, so the stored rows can't link two accounts that share a browser.
 * It proves nothing and unlocks nothing: losing it costs one extra email.
 */

const crypto = require('crypto');
const { executeQuery, queryOne, updateAndCount } = require('../config/database');
const { DEVICE_COOKIE_NAME, deviceCookieOptions } = require('../config/auth');
const { readCookie, describeDevice } = require('./sessions');

const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function hashDevice(userId, token) {
    return crypto.createHash('sha256').update(`${userId}:${token}`).digest('hex');
}

function deviceToken(req) {
    const token = readCookie(req, DEVICE_COOKIE_NAME);
    return token && DEVICE_TOKEN_PATTERN.test(token) ? token : null;
}

async function remember(user, token, userAgent) {
    try {
        await executeQuery(
            'INSERT INTO known_devices (user_id, device_hash, label) VALUES (?, ?, ?)',
            [user.id, hashDevice(user.id, token), describeDevice(userAgent)]
        );
    } catch (error) {
        // Two tabs signing in at once: the other one recorded it
        if (error.code !== 'ER_DUP_ENTRY' && error.code !== '23505') throw error;
    }
}

function setCookie(res, token) {
    res.cookie(DEVICE_COOKIE_NAME, token, deviceCookieOptions());
}

/**
 * After a completed sign-in. An account with no devices on record (first sign-in after registering,
 * or before this feature) gets its baseline without an email.
 * @returns {Promise<{ isNew: boolean }>} isNew = worth an email
 */
async function recognize(req, res, user) {
    const existing = deviceToken(req);
    if (existing) {
        const seen = await updateAndCount(
            'UPDATE known_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE user_id = ? AND device_hash = ?',
            [user.id, hashDevice(user.id, existing)]
        );
        if (seen > 0) return { isNew: false };
    }

    const known = await queryOne('SELECT COUNT(*) AS total FROM known_devices WHERE user_id = ?', [user.id]);
    const firstEver = !known || Number(known.total) === 0;

    const token = existing || crypto.randomBytes(24).toString('base64url');
    await remember(user, token, req.headers && req.headers['user-agent']);
    if (!existing) setCookie(res, token);
    return { isNew: !firstEver };
}

/**
 * A signed-in browser with no cookie yet (a session from before this feature) is already trusted:
 * record it quietly, so that a sign-in from somewhere else is what triggers the email. Never fails
 * the request it runs in.
 */
async function adopt(req, res, user) {
    try {
        if (deviceToken(req)) return;
        const token = crypto.randomBytes(24).toString('base64url');
        await remember(user, token, req.headers && req.headers['user-agent']);
        setCookie(res, token);
    } catch (error) {
        console.error('Remember device error:', error.message);
    }
}

/**
 * Housekeeping: a browser unseen for over a year gets the email again
 */
async function purgeOldDevices() {
    await executeQuery(process.env.DB_TYPE === 'postgresql'
        ? "DELETE FROM known_devices WHERE last_seen_at < CURRENT_TIMESTAMP - INTERVAL '400 days'"
        : 'DELETE FROM known_devices WHERE last_seen_at < CURRENT_TIMESTAMP - INTERVAL 400 DAY');
}

module.exports = { recognize, adopt, purgeOldDevices, hashDevice };
