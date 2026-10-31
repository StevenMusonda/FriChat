/**
 * Phase 14 settings: two-factor authentication, data exports and account deletion.
 * Read on every call so tests (and a restart with new env values) pick changes up.
 */

function intFromEnv(name, fallback, min, max) {
    const value = parseInt(process.env[name], 10);
    if (!Number.isInteger(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

const RECOVERY_CODE_COUNT = 10;
// A code from the previous or next 30-second step still counts (phone clocks drift)
const TOTP_TOLERANCE_SECONDS = 30;
// A setup that is never confirmed goes stale
const TOTP_SETUP_TTL_SECONDS = 15 * 60;
// Between the password and the code at sign-in
const LOGIN_CHALLENGE_TTL_SECONDS = 5 * 60;

const SECURITY_ACTIVITY_PAGE_SIZE = 30;

// Exports are built one after another, away from the timed jobs that deliver messages
const ACCOUNT_JOB_TICK_SECONDS = 60;
const EXPORT_PAGE_SIZE = 1000;
const EXPORT_MAX_ATTEMPTS = 3;
// A build still "running" after this long died with the server
const EXPORT_STALE_SECONDS = 60 * 60;
const EXPORT_LINK_TTL_SECONDS = 5 * 60;
const DELETION_BATCH_SIZE = 5;
const DELETION_FILE_BATCH_SIZE = 200;

function totpIssuer() {
    return process.env.TOTP_ISSUER || 'FriChat';
}

/**
 * maxAttempts wrong codes in a row lock the second factor for lockMinutes
 */
function twoFactorLimits() {
    return {
        maxAttempts: intFromEnv('TWO_FACTOR_MAX_ATTEMPTS', 5, 3, 20),
        lockMinutes: intFromEnv('TWO_FACTOR_LOCK_MINUTES', 15, 1, 1440)
    };
}

function exportConfig() {
    return {
        ttlHours: intFromEnv('DATA_EXPORT_TTL_HOURS', 72, 1, 720),
        cooldownHours: intFromEnv('DATA_EXPORT_COOLDOWN_HOURS', 24, 0, 720)
    };
}

function deletionGraceDays() {
    return intFromEnv('ACCOUNT_DELETION_GRACE_DAYS', 14, 1, 365);
}

module.exports = {
    RECOVERY_CODE_COUNT,
    TOTP_TOLERANCE_SECONDS,
    TOTP_SETUP_TTL_SECONDS,
    LOGIN_CHALLENGE_TTL_SECONDS,
    SECURITY_ACTIVITY_PAGE_SIZE,
    ACCOUNT_JOB_TICK_SECONDS,
    EXPORT_PAGE_SIZE,
    EXPORT_MAX_ATTEMPTS,
    EXPORT_STALE_SECONDS,
    EXPORT_LINK_TTL_SECONDS,
    DELETION_BATCH_SIZE,
    DELETION_FILE_BATCH_SIZE,
    totpIssuer,
    twoFactorLimits,
    exportConfig,
    deletionGraceDays
};
