/**
 * Phase 15 settings for incoming webhooks
 */

const WEBHOOK_NAME_MAX_LENGTH = 50;
const MAX_WEBHOOKS_PER_CHAT = 10;

// 32 random bytes as base64url
const WEBHOOK_TOKEN_BYTES = 32;
const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Room for a full-length message in \uXXXX escapes (5000 * 6 bytes), plus the JSON around it
const WEBHOOK_MAX_BODY = '32kb';

// The account every webhook message is sent from. A username registration can't produce
// (hyphen), so no person can already have it and it can't be @mentioned.
const BOT_USERNAME = 'frichat-bot';
const BOT_FULL_NAME = 'FriChat Bot';

function intFromEnv(name, fallback, min, max) {
    const value = parseInt(process.env[name], 10);
    if (!Number.isInteger(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

/**
 * perMinute: messages one webhook may post a minute.
 * ipPerMinute: requests one IP may make to the endpoint, right token or not, so ids can't be probed.
 * Read once, when the limiters are created.
 */
function webhookLimits() {
    return {
        perMinute: intFromEnv('WEBHOOK_RATE_PER_MINUTE', 30, 1, 6000),
        ipPerMinute: intFromEnv('WEBHOOK_IP_RATE_PER_MINUTE', 120, 1, 60000)
    };
}

module.exports = {
    WEBHOOK_NAME_MAX_LENGTH,
    MAX_WEBHOOKS_PER_CHAT,
    WEBHOOK_TOKEN_BYTES,
    WEBHOOK_TOKEN_PATTERN,
    WEBHOOK_MAX_BODY,
    BOT_USERNAME,
    BOT_FULL_NAME,
    webhookLimits
};
