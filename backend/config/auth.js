/**
 * Session, token and email-verification settings.
 * Read on every call so tests (and a restart with new env values) pick changes up.
 */

const REFRESH_COOKIE_NAME = 'frichat_refresh';
// The cookie is only sent to the auth routes, never to chats/messages/uploads
const REFRESH_COOKIE_PATH = '/api/auth';
const SAME_SITE_VALUES = ['strict', 'lax', 'none'];

function intFromEnv(name, fallback, min = 1) {
    const value = parseInt(process.env[name], 10);
    return Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * Access JWT lifetime (jsonwebtoken format, e.g. '15m')
 */
function accessTokenTtl() {
    return process.env.ACCESS_TOKEN_TTL || '15m';
}

/**
 * Refresh token lifetime in days; slides forward on every rotation, so a device that is
 * used at least this often stays signed in
 */
function refreshTokenTtlDays() {
    return intFromEnv('REFRESH_TOKEN_TTL_DAYS', 30);
}

/**
 * Two tabs refreshing with the same cookie at the same moment is a race, not theft.
 * Within this many seconds of a rotation, the old token gets "retry" instead of revoking the session.
 */
function refreshReuseGraceSeconds() {
    return intFromEnv('REFRESH_REUSE_GRACE_SECONDS', 10, 0);
}

function emailVerificationTtlHours() {
    return intFromEnv('EMAIL_VERIFICATION_TTL_HOURS', 24);
}

/**
 * Refresh cookie options. Secure is on unless COOKIE_SECURE=false (browsers accept Secure cookies
 * from http://localhost, except older Safari). SameSite defaults to strict; deployments where the
 * frontend and API are on different sites need COOKIE_SAMESITE=none (which also forces Secure).
 */
function refreshCookieOptions() {
    const sameSiteSetting = String(process.env.COOKIE_SAMESITE || 'strict').trim().toLowerCase();
    const sameSite = SAME_SITE_VALUES.includes(sameSiteSetting) ? sameSiteSetting : 'strict';
    const secure = sameSite === 'none' || String(process.env.COOKIE_SECURE || '').trim().toLowerCase() !== 'false';
    return {
        httpOnly: true,
        secure,
        sameSite,
        path: REFRESH_COOKIE_PATH,
        maxAge: refreshTokenTtlDays() * 24 * 60 * 60 * 1000
    };
}

module.exports = {
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_PATH,
    accessTokenTtl,
    refreshTokenTtlDays,
    refreshReuseGraceSeconds,
    emailVerificationTtlHours,
    refreshCookieOptions
};
