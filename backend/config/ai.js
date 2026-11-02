/**
 * Phase 15 settings for the optional AI features. Nothing here turns on by itself: without
 * ANTHROPIC_API_KEY every AI route answers AI_DISABLED, the status route says so and the app shows
 * no AI controls. Read on every call so tests (and a restart with new env values) pick changes up.
 */

const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_LANGUAGE = 'en';

// "Summarize unread" appears for a chat with more than this many unread messages
const SUMMARY_MIN_UNREAD = 30;
// Newest messages sent per summary, and their size. Anything older is left out and the user is told.
const SUMMARY_MAX_MESSAGES = 300;
const SUMMARY_MAX_CHARS = 60000;
const SUMMARY_MAX_BULLETS = 8;
const SUMMARY_MAX_BULLET_LENGTH = 400;
const SUMMARY_MAX_OUTPUT_TOKENS = 2048;

// A 5000-character message can grow when translated, and adaptive thinking counts towards this
const TRANSLATION_MAX_OUTPUT_TOKENS = 8000;
const TRANSLATION_MAX_LENGTH = 20000;

// Opening a chat marks it read. For this long the server remembers where it was, so the summary
// can still be asked for. A plain number of seconds, inlined in SQL.
const CATCHUP_WINDOW_SECONDS = 2 * 60 * 60;

const REQUEST_TIMEOUT_MS = 30 * 1000;
const REQUEST_MAX_RETRIES = 1;
// Rough size of a request before it is sent; the real count replaces it afterwards
const CHARS_PER_TOKEN_ESTIMATE = 3;

// Usage rows are only for accounting
const USAGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

// What Translate can target. The code is what's stored; the name is what the prompt says.
const TRANSLATION_LANGUAGES = {
    ar: 'Arabic',
    de: 'German',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    hi: 'Hindi',
    id: 'Indonesian',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    nl: 'Dutch',
    pl: 'Polish',
    pt: 'Portuguese',
    ru: 'Russian',
    sv: 'Swedish',
    tr: 'Turkish',
    uk: 'Ukrainian',
    vi: 'Vietnamese',
    zh: 'Chinese'
};

function intFromEnv(name, fallback, min, max) {
    const value = parseInt(process.env[name], 10);
    if (!Number.isInteger(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

function aiApiKey() {
    return String(process.env.ANTHROPIC_API_KEY || '').trim() || null;
}

function aiEnabled() {
    return aiApiKey() !== null;
}

function aiModel() {
    return String(process.env.ANTHROPIC_MODEL || '').trim() || DEFAULT_MODEL;
}

/**
 * userDailyRequests: API calls one user may start per UTC day (cached translations don't count).
 * monthlyTokens: input plus output tokens the whole server may use per UTC month.
 */
function aiLimits() {
    return {
        userDailyRequests: intFromEnv('AI_USER_DAILY_REQUESTS', 20, 0, 100000),
        monthlyTokens: intFromEnv('AI_MONTHLY_TOKEN_LIMIT', 5000000, 0, Number.MAX_SAFE_INTEGER)
    };
}

module.exports = {
    DEFAULT_MODEL,
    DEFAULT_LANGUAGE,
    SUMMARY_MIN_UNREAD,
    SUMMARY_MAX_MESSAGES,
    SUMMARY_MAX_CHARS,
    SUMMARY_MAX_BULLETS,
    SUMMARY_MAX_BULLET_LENGTH,
    SUMMARY_MAX_OUTPUT_TOKENS,
    TRANSLATION_MAX_OUTPUT_TOKENS,
    TRANSLATION_MAX_LENGTH,
    CATCHUP_WINDOW_SECONDS,
    REQUEST_TIMEOUT_MS,
    REQUEST_MAX_RETRIES,
    CHARS_PER_TOKEN_ESTIMATE,
    USAGE_RETENTION_SECONDS,
    TRANSLATION_LANGUAGES,
    aiApiKey,
    aiEnabled,
    aiModel,
    aiLimits
};
