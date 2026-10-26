/**
 * Notification Routes (Web Push subscriptions and do-not-disturb)
 */

const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validatePushSubscription,
    validatePushUnsubscribe,
    validateNotificationSettings,
    checkValidation
} = require('../utils/validation');

const notificationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many notification requests. Please slow down.'
});

// All routes require authentication
router.use(notificationLimiter, authenticateToken);

router.get('/push-config', notificationController.getPushConfig);
router.post('/subscriptions', validatePushSubscription, checkValidation, notificationController.subscribe);
router.delete('/subscriptions', validatePushUnsubscribe, checkValidation, notificationController.unsubscribe);

router.get('/settings', notificationController.getSettings);
router.put('/settings', validateNotificationSettings, checkValidation, notificationController.updateSettings);

module.exports = router;
