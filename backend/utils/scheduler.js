/**
 * Scheduler for auto-unpinning expired messages
 */

const { executeQuery } = require('../config/database');

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
 * Start the scheduler
 */
function startScheduler() {
    // Run every 5 minutes
    setInterval(removeExpiredPins, 5 * 60 * 1000);
    
    // Run immediately on startup
    removeExpiredPins();
    
    console.log('✓ Message pin scheduler started (runs every 5 minutes)');
}

module.exports = { startScheduler, removeExpiredPins };
