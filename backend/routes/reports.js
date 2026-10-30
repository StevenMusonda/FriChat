/**
 * Report routes: any signed-in user can report; warnings are the user's own
 */

const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validateReport, validateWarningIdParam, checkValidation } = require('../utils/validation');

// A report copies messages and possibly a file, so it gets a low hourly budget
const reportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'You\'ve sent a lot of reports. Please try again later.',
    keyGenerator: (req) => `user:${req.user.id}`
});

const warningLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many requests. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);

router.post('/', reportLimiter, validateReport, checkValidation, reportController.createReport);
router.get('/warnings', warningLimiter, reportController.listWarnings);
router.post('/warnings/:warningId/acknowledge', warningLimiter, validateWarningIdParam, checkValidation, reportController.acknowledgeWarning);

module.exports = router;
