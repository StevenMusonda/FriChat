/**
 * Scheduler for timed jobs: auto-unpinning expired messages, auth cleanup, (phase 8)
 * scheduled messages, reminders and polls that close at a set time, and (phase 10) deleting
 * disappearing messages whose time is up.
 *
 * The timed jobs keep their state in the database (scheduled_messages, message_reminders, polls),
 * so nothing is lost on a restart: the first tick after startup handles whatever came due meanwhile.
 */

const { executeQuery } = require('../config/database');
const { purgeOldSessions } = require('./sessions');
const { processDueScheduledMessages } = require('./scheduledMessages');
const { fireDueReminders } = require('./reminders');
const { closeDuePolls } = require('./polls');
const { deleteExpiredMessages } = require('./disappearing');
const { SCHEDULER_TICK_SECONDS } = require('../config/scheduling');

/**
 * Remove expired pinned messages
 */
async function removeExpiredPins() {
    try {
        const result = await executeQuery(
            'DELETE FROM pinned_messages WHERE pinned_until < CURRENT_TIMESTAMP'
        );
        
        const deletedCount = result.affectedRows || 0;
        if (deletedCount > 0) {
            console.log(`Auto-unpinned ${deletedCount} expired message(s)`);
        }
    } catch (error) {
        console.error('Error removing expired pins:', error);
    }
}

/**
 * Drop long-dead sessions and expired email verification links
 */
async function removeExpiredAuthRows() {
    try {
        await purgeOldSessions();
        await executeQuery('DELETE FROM email_verifications WHERE expires_at < CURRENT_TIMESTAMP');
    } catch (error) {
        console.error('Error removing expired sessions:', error);
    }
}

let timedJobsRunning = false;

/**
 * Send due scheduled messages, fire due reminders, close due polls and delete expired messages.
 * A tick that starts while the previous one is still running is skipped (the claims in each job
 * would keep it correct anyway, this just avoids piling up work).
 */
async function runTimedJobs(io) {
    if (timedJobsRunning) return null;
    timedJobsRunning = true;
    const result = {};
    try {
        for (const [name, job] of [
            ['scheduled', processDueScheduledMessages],
            ['reminders', fireDueReminders],
            ['polls', closeDuePolls],
            ['expired', deleteExpiredMessages]
        ]) {
            try {
                result[name] = await job(io);
            } catch (error) {
                console.error(`Timed job "${name}" failed:`, error.message);
            }
        }
    } finally {
        timedJobsRunning = false;
    }
    return result;
}

/**
 * Start the scheduler
 * @param {Object} io - Socket.IO server, so timed jobs deliver through the normal message path
 */
function startScheduler(io = null) {
    // Run every 5 minutes
    setInterval(removeExpiredPins, 5 * 60 * 1000);
    setInterval(removeExpiredAuthRows, 60 * 60 * 1000).unref();

    setInterval(() => runTimedJobs(io), SCHEDULER_TICK_SECONDS * 1000).unref();

    // Run immediately on startup
    removeExpiredPins();
    removeExpiredAuthRows();
    runTimedJobs(io);

    console.log('✓ Message pin scheduler started (runs every 5 minutes)');
    console.log(`✓ Scheduled messages, reminders, polls and disappearing messages checked every ${SCHEDULER_TICK_SECONDS} s`);
}

module.exports = { startScheduler, removeExpiredPins, removeExpiredAuthRows, runTimedJobs };
