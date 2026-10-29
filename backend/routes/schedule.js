/**
 * Scheduled messages and "Remind me" routes (phase 8)
 * Mounted at /api/scheduled-messages and /api/reminders (see server.js)
 */

const express = require('express');
const scheduleController = require('../controllers/scheduleController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateScheduledIdParam,
    validateScheduledQuery,
    validateScheduleMessage,
    validateUpdateScheduled,
    validateCreateReminder,
    validateReminderIdParam,
    validateRemindersQuery,
    checkValidation
} = require('../utils/validation');

function limiter(message) {
    return rateLimit({
        windowMs: 60 * 1000,
        max: 30,
        message,
        keyGenerator: (req) => `user:${req.user.id}`
    });
}

const scheduledRouter = express.Router();
const scheduledLimiter = limiter('Too many scheduled message changes. Please wait a moment.');
scheduledRouter.use(authenticateToken, scheduledLimiter);

scheduledRouter.get('/', validateScheduledQuery, checkValidation, scheduleController.listScheduled);
scheduledRouter.post('/', validateScheduleMessage, checkValidation, scheduleController.createScheduled);
scheduledRouter.patch('/:scheduledId', validateUpdateScheduled, checkValidation, scheduleController.updateScheduled);
scheduledRouter.delete('/:scheduledId', validateScheduledIdParam, checkValidation, scheduleController.cancelScheduled);

const remindersRouter = express.Router();
const reminderLimiter = limiter('Too many reminder changes. Please wait a moment.');
remindersRouter.use(authenticateToken, reminderLimiter);

remindersRouter.get('/', validateRemindersQuery, checkValidation, scheduleController.listReminders);
remindersRouter.post('/', validateCreateReminder, checkValidation, scheduleController.createReminder);
remindersRouter.delete('/:reminderId', validateReminderIdParam, checkValidation, scheduleController.deleteReminder);

module.exports = { scheduledRouter, remindersRouter };
