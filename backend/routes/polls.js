/**
 * Poll Routes (phase 8). Voting also works over Socket.IO (poll_vote).
 */

const express = require('express');
const router = express.Router();
const pollController = require('../controllers/pollController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateCreatePoll,
    validatePollIdParam,
    validatePollVote,
    checkValidation
} = require('../utils/validation');

// Each poll is a new message, so creating gets a tighter budget than voting
const pollCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many polls. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

const pollActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many poll actions. Please slow down.',
    keyGenerator: (req) => `user:${req.user.id}`
});

// All routes require authentication
router.use(authenticateToken);

router.post('/', pollCreateLimiter, validateCreatePoll, checkValidation, pollController.createPoll);
router.get('/:pollId', pollActionLimiter, validatePollIdParam, checkValidation, pollController.getPoll);
router.put('/:pollId/votes', pollActionLimiter, validatePollVote, checkValidation, pollController.vote);
router.post('/:pollId/close', pollActionLimiter, validatePollIdParam, checkValidation, pollController.closePoll);

module.exports = router;
