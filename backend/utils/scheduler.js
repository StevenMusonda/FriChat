/**
 * Scheduler for timed jobs: auto-unpinning expired messages, auth cleanup, (phase 8)
 * scheduled messages, reminders and polls that close at a set time, and (phase 10) deleting
 * disappearing messages whose time is up, (phase 12) event reminders and list item due dates, and
 * (phase 14) data exports and account deletions, which run apart from the rest: an export can take
 * minutes, and messages mustn't wait for it.
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
const { fireDueEventReminders } = require('./events');
const { fireDueListItems } = require('./lists');
const { processPendingExports, sweepExpiredExports } = require('./dataExport');
const { processDueDeletions } = require('./accountDeletion');
const { purgeOldDevices } = require('./knownDevices');
const { SCHEDULER_TICK_SECONDS } = require('../config/scheduling');
const { ACCOUNT_JOB_TICK_SECONDS } = require('../config/accountSecurity');

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
        await purgeOldDevices();
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
            ['eventReminders', fireDueEventReminders],
            ['listItems', fireDueListItems],
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

let accountJobsRunning = false;

/**
 * Build data exports, remove expired ones and delete accounts whose grace period is over
 */
async function runAccountJobs(io) {
    if (accountJobsRunning) return null;
    accountJobsRunning = true;
    const result = {};
    try {
        for (const [name, job] of [
            ['exports', processPendingExports],
            ['expiredExports', sweepExpiredExports],
            ['deletions', processDueDeletions]
        ]) {
            try {
                result[name] = await job(io);
            } catch (error) {
                console.error(`Account job "${name}" failed:`, error.message);
            }
        }
    } finally {
        accountJobsRunning = false;
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
    setInterval(() => runAccountJobs(io), ACCOUNT_JOB_TICK_SECONDS * 1000).unref();

    // Run immediately on startup
    removeExpiredPins();
    removeExpiredAuthRows();
    runTimedJobs(io);
    runAccountJobs(io);

    console.log('✓ Message pin scheduler started (runs every 5 minutes)');
    console.log(`✓ Scheduled messages, reminders, polls and disappearing messages, event reminders and list due dates checked every ${SCHEDULER_TICK_SECONDS} s`);
}

module.exports = { startScheduler, removeExpiredPins, removeExpiredAuthRows, runTimedJobs, runAccountJobs };
