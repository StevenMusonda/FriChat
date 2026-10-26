/**
 * Notification Controller
 * Web Push subscriptions and do-not-disturb settings for the current user
 */

const {
    getVapidPublicKey,
    saveSubscription,
    deleteSubscription
} = require('../utils/push');
const {
    getNotificationSettings,
    saveNotificationSettings,
    isDndActive
} = require('../utils/notificationSettings');

/**
 * Public VAPID key the browser needs to subscribe; enabled is false when the server has no keys
 */
async function getPushConfig(req, res) {
    const publicKey = getVapidPublicKey();
    res.json({
        success: true,
        data: {
            enabled: !!publicKey,
            publicKey: publicKey
        }
    });
}

/**
 * Save this browser's push subscription
 * Body: { endpoint, keys: { p256dh, auth } }
 */
async function subscribe(req, res) {
    try {
        if (!getVapidPublicKey()) {
            return res.status(503).json({
                success: false,
                message: 'Push notifications are not configured on this server'
            });
        }

        const { endpoint, keys } = req.body;
        await saveSubscription(req.user.id, { endpoint, keys }, req.get('user-agent'));

        res.status(201).json({
            success: true,
            message: 'Notifications enabled'
        });
    } catch (error) {
        console.error('Push subscribe error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save subscription'
        });
    }
}

/**
 * Remove this browser's push subscription (on toggle off and on logout)
 * Body: { endpoint }
 */
async function unsubscribe(req, res) {
    try {
        await deleteSubscription(req.user.id, req.body.endpoint);

        res.json({
            success: true,
            message: 'Notifications disabled'
        });
    } catch (error) {
        console.error('Push unsubscribe error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove subscription'
        });
    }
}

function settingsResponse(settings) {
    return { ...settings, dndActive: isDndActive(settings) };
}

/**
 * Do-not-disturb settings
 */
async function getSettings(req, res) {
    try {
        const settings = await getNotificationSettings(req.user.id);
        res.json({
            success: true,
            data: settingsResponse(settings)
        });
    } catch (error) {
        console.error('Get notification settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load notification settings'
        });
    }
}

/**
 * Update any of: dndEnabled, quietHoursEnabled, quietStart, quietEnd ('HH:MM'), timezone (IANA)
 */
async function updateSettings(req, res) {
    try {
        const changes = {};
        for (const key of ['dndEnabled', 'quietHoursEnabled', 'quietStart', 'quietEnd', 'timezone']) {
            if (req.body[key] !== undefined) changes[key] = req.body[key];
        }

        const data = settingsResponse(await saveNotificationSettings(req.user.id, changes));

        // Keep the user's other tabs in sync
        if (req.io) {
            req.io.to(`user_${req.user.id}`).emit('notification_settings_updated', data);
        }

        res.json({
            success: true,
            data: data
        });
    } catch (error) {
        console.error('Update notification settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save notification settings'
        });
    }
}

module.exports = {
    getPushConfig,
    subscribe,
    unsubscribe,
    getSettings,
    updateSettings
};
