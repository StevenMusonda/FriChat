/**
 * Phase 13 settings: reports, audit events, upload hardening, ClamAV and spam limits
 */

function intFromEnv(name, fallback, min, max) {
    const value = parseInt(process.env[name], 10);
    if (!Number.isInteger(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

const REPORT_REASONS = ['spam', 'harassment', 'inappropriate', 'other'];
const REPORT_STATUSES = ['open', 'dismissed', 'actioned'];
const REPORT_NOTE_MAX_LENGTH = 500;
const WARNING_MAX_LENGTH = 500;
const SUSPEND_REASON_MAX_LENGTH = 255;

// How many messages around a reported one are copied (split evenly, topped up from the other side)
const EVIDENCE_CONTEXT_MESSAGES = 10;

const ADMIN_PAGE_SIZE = 50;

// Every event the audit log accepts (filter list of the admin console)
const AUDIT_EVENTS = [
    'login',
    'login_failed',
    'login_blocked_suspended',
    'password_changed',
    'password_reset',
    'session_revoked',
    'group_settings_changed',
    'member_removed',
    'invite_created',
    'report_filed',
    'upload_quarantined',
    'admin_flag_changed',
    'admin_report_viewed',
    'admin_report_dismissed',
    'admin_user_warned',
    'admin_user_suspended',
    'admin_user_unsuspended',
    'admin_user_logged_out',
    'admin_message_deleted'
];

// Images are decoded and re-encoded, so a decompression bomb is refused before sharp allocates it
const UPLOAD_MAX_IMAGE_PIXELS = 100 * 1000 * 1000;

/**
 * Read at call time, so an operator's .env (and tests) apply without a code change
 */
function clamavConfig() {
    return {
        enabled: process.env.CLAMAV_ENABLED === 'true',
        host: process.env.CLAMAV_HOST || '127.0.0.1',
        port: intFromEnv('CLAMAV_PORT', 3310, 1, 65535),
        socketPath: process.env.CLAMAV_SOCKET || null,
        timeoutMs: intFromEnv('CLAMAV_TIMEOUT_MS', 30000, 1000, 300000),
        // Scanner down: refuse the upload (default), or let it through with this set to true
        failOpen: process.env.CLAMAV_FAIL_OPEN === 'true'
    };
}

/**
 * Accounts younger than newAccountHours may send nonContactMessagesPerHour messages an hour to
 * people who haven't accepted their message request. Either value at 0 switches the limit off.
 */
function spamConfig() {
    return {
        newAccountHours: intFromEnv('SPAM_NEW_ACCOUNT_HOURS', 72, 0, 8760),
        nonContactMessagesPerHour: intFromEnv('SPAM_NON_CONTACT_MESSAGES_PER_HOUR', 20, 0, 100000)
    };
}

function reportEvidenceMaxBytes() {
    return intFromEnv('REPORT_EVIDENCE_MAX_BYTES', 25 * 1024 * 1024, 0, 1024 * 1024 * 1024);
}

module.exports = {
    REPORT_REASONS,
    REPORT_STATUSES,
    REPORT_NOTE_MAX_LENGTH,
    WARNING_MAX_LENGTH,
    SUSPEND_REASON_MAX_LENGTH,
    EVIDENCE_CONTEXT_MESSAGES,
    ADMIN_PAGE_SIZE,
    AUDIT_EVENTS,
    UPLOAD_MAX_IMAGE_PIXELS,
    clamavConfig,
    spamConfig,
    reportEvidenceMaxBytes
};
