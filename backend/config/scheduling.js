/**
 * Phase 8 limits: polls, scheduled messages and reminders.
 * The frontend mirrors the poll limits (CONFIG.POLL_*); the server enforces all of them.
 */

function intFromEnv(name, fallback, min, max) {
    const value = parseInt(process.env[name], 10);
    if (!Number.isInteger(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

module.exports = {
    // How often the scheduler looks for due scheduled messages, reminders and polls to close
    SCHEDULER_TICK_SECONDS: intFromEnv('SCHEDULER_TICK_SECONDS', 15, 5, 300),

    // A scheduled time must be at least this far in the future, and at most MAX_SCHEDULE_DAYS away
    MIN_LEAD_SECONDS: 5,
    MAX_SCHEDULE_DAYS: 365,

    // Open items per user, so one account can't fill the scheduler's queue
    MAX_PENDING_SCHEDULED_PER_USER: 100,
    MAX_PENDING_REMINDERS_PER_USER: 200,

    // A row left in 'sending' this long (the server stopped mid-send) goes back to 'pending'
    STALE_CLAIM_SECONDS: 120,
    // Unexpected delivery errors are retried on the next ticks, then the message is marked failed
    MAX_SEND_ATTEMPTS: 3,
    // Rows handled per tick (the rest wait for the next tick)
    BATCH_SIZE: 50,

    POLL_QUESTION_MAX_LENGTH: 300,
    POLL_OPTION_MAX_LENGTH: 100,
    POLL_MIN_OPTIONS: 2,
    POLL_MAX_OPTIONS: 12
};
