/**
 * Scheduler for auto-unpinning expired messages
 */

const { executeQuery } = require('../config/database');
const { purgeOldSessions } = require('./sessions');

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

/**
 * Start the scheduler
 */
function startScheduler() {
    // Run every 5 minutes
    setInterval(removeExpiredPins, 5 * 60 * 1000);
    setInterval(removeExpiredAuthRows, 60 * 60 * 1000).unref();

    // Run immediately on startup
    removeExpiredPins();
    removeExpiredAuthRows();

    console.log('✓ Message pin scheduler started (runs every 5 minutes)');
}

module.exports = { startScheduler, removeExpiredPins, removeExpiredAuthRows };
