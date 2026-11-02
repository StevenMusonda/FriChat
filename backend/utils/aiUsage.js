/**
 * Caps and accounting for AI requests.
 *
 * reserve() takes the request's place before anything is sent: both counters move with a conditional
 * UPDATE, so requests racing each other can't pass a cap, and the monthly counter takes an estimate
 * that settle() later replaces with the real token count. A call that fails gives its place back.
 * Usage rows hold counts only, never message text.
 */

const { executeQuery, updateAndCount, dbType } = require('../config/database');
const { aiLimits, USAGE_RETENTION_SECONDS } = require('../config/ai');
const { minusSecondsSql } = require('./timeSql');

const GLOBAL_SCOPE = 'global';

const DAILY_LIMIT_ERROR = {
    status: 429,
    code: 'AI_DAILY_LIMIT',
    message: 'You\'ve reached today\'s limit for AI features. Try again tomorrow.'
};

const MONTHLY_LIMIT_ERROR = {
    status: 429,
    code: 'AI_MONTHLY_LIMIT',
    message: 'AI features have reached this server\'s monthly limit.'
};

function userScope(userId) {
    return `user:${userId}`;
}

/**
 * UTC, so a cap resets at the same moment for everyone
 */
function currentPeriods(now = new Date()) {
    const iso = now.toISOString();
    return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

async function ensureCounter(scope, period) {
    await executeQuery(dbType === 'postgresql'
        ? 'INSERT INTO ai_usage_counters (scope, period) VALUES (?, ?) ON CONFLICT (scope, period) DO NOTHING'
        : 'INSERT IGNORE INTO ai_usage_counters (scope, period) VALUES (?, ?)', [scope, period]);
}

async function adjustCounter(scope, period, requests, tokens) {
    await executeQuery(
        'UPDATE ai_usage_counters SET requests = requests + ?, tokens = tokens + ?, updated_at = CURRENT_TIMESTAMP WHERE scope = ? AND period = ?',
        [requests, tokens, scope, period]
    );
}

/**
 * @returns {Promise<{ error } | { reservation }>}
 */
async function reserve(userId, estimatedTokens, now = new Date()) {
    const { userDailyRequests, monthlyTokens } = aiLimits();
    const { day, month } = currentPeriods(now);
    const scope = userScope(userId);
    await ensureCounter(scope, day);
    await ensureCounter(GLOBAL_SCOPE, month);

    const allowed = await updateAndCount(
        'UPDATE ai_usage_counters SET requests = requests + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = ? AND period = ? AND requests < ?',
        [scope, day, userDailyRequests]
    );
    if (allowed === 0) return { error: DAILY_LIMIT_ERROR };

    const fits = await updateAndCount(
        'UPDATE ai_usage_counters SET requests = requests + 1, tokens = tokens + ?, updated_at = CURRENT_TIMESTAMP WHERE scope = ? AND period = ? AND tokens + ? <= ?',
        [estimatedTokens, GLOBAL_SCOPE, month, estimatedTokens, monthlyTokens]
    );
    if (fits === 0) {
        await adjustCounter(scope, day, -1, 0);
        return { error: MONTHLY_LIMIT_ERROR };
    }

    return { reservation: { scope, day, month, estimatedTokens } };
}

/**
 * The call was answered: swap the estimate for what it really used
 */
async function settle(reservation, usedTokens) {
    await adjustCounter(reservation.scope, reservation.day, 0, usedTokens);
    await adjustCounter(GLOBAL_SCOPE, reservation.month, 0, usedTokens - reservation.estimatedTokens);
}

/**
 * The call failed: it doesn't count
 */
async function release(reservation) {
    await adjustCounter(reservation.scope, reservation.day, -1, 0);
    await adjustCounter(GLOBAL_SCOPE, reservation.month, -1, -reservation.estimatedTokens);
}

/**
 * Never throws: accounting must not fail a request that already went through
 */
async function logUsage({ userId, feature, model, inputTokens = 0, outputTokens = 0, outcome }) {
    try {
        await executeQuery(
            'INSERT INTO ai_usage_log (user_id, feature, model, input_tokens, output_tokens, outcome) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, feature, model, inputTokens, outputTokens, outcome]
        );
        console.log(`AI usage: ${feature} ${model} ${outcome} input=${inputTokens} output=${outputTokens}`);
    } catch (error) {
        console.error('AI usage log failed:', error.message);
    }
}

/**
 * Scheduler: accounting rows are only kept for a while
 */
async function purgeOldUsage() {
    await executeQuery(`DELETE FROM ai_usage_log WHERE created_at < ${minusSecondsSql(USAGE_RETENTION_SECONDS)}`);
    await executeQuery(`DELETE FROM ai_usage_counters WHERE updated_at < ${minusSecondsSql(USAGE_RETENTION_SECONDS)}`);
}

module.exports = {
    GLOBAL_SCOPE,
    DAILY_LIMIT_ERROR,
    MONTHLY_LIMIT_ERROR,
    userScope,
    currentPeriods,
    reserve,
    settle,
    release,
    logUsage,
    purgeOldUsage
};
