/**
 * Call Routes (phase 11). Calls themselves run over Socket.IO (utils/calls.js); these serve the
 * ICE/TURN configuration and the call history.
 */

const express = require('express');
const router = express.Router();
const callController = require('../controllers/callController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validateCallHistoryQuery, checkValidation } = require('../utils/validation');

// Fetched before each call (and on ICE restarts), so a little room; per user, not per IP
const callLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many call requests. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);
router.use(callLimiter);

router.get('/ice-servers', callController.getIceServers);
router.get('/', validateCallHistoryQuery, checkValidation, callController.listCalls);

module.exports = router;
