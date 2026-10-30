/**
 * Event routes (phase 12). Answering also works over Socket.IO (event_rsvp).
 */

const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateCreateEvent,
    validateEventIdParam,
    validateUpdateEvent,
    validateRsvp,
    validateEventsQuery,
    checkValidation
} = require('../utils/validation');

// Creating, editing and cancelling post messages to the chat, so they get a tighter budget
const eventWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    message: 'Too many event changes. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

const eventActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many event requests. Please slow down.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);

router.get('/', eventActionLimiter, validateEventsQuery, checkValidation, eventController.listEvents);
router.post('/', eventWriteLimiter, validateCreateEvent, checkValidation, eventController.createEvent);
router.get('/:eventId', eventActionLimiter, validateEventIdParam, checkValidation, eventController.getEvent);
router.get('/:eventId/ics', eventActionLimiter, validateEventIdParam, checkValidation, eventController.downloadIcs);
router.patch('/:eventId', eventWriteLimiter, validateUpdateEvent, checkValidation, eventController.updateEvent);
router.post('/:eventId/cancel', eventWriteLimiter, validateEventIdParam, checkValidation, eventController.cancelEvent);
router.put('/:eventId/rsvp', eventActionLimiter, validateRsvp, checkValidation, eventController.setRsvp);

module.exports = router;
