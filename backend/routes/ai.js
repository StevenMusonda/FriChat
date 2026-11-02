/**
 * Optional AI features (phase 15). Off unless ANTHROPIC_API_KEY is set: see utils/ai.js.
 */

const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateAiConsent,
    validateAiLanguage,
    validateAiChatSetting,
    validateChatIdParam,
    validateMessageIdParam,
    checkValidation
} = require('../utils/validation');

const aiSettingsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many requests. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

// Each one can cost a call to the provider; the daily cap is in utils/aiUsage.js
const aiActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many AI requests. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);

router.get('/status', aiSettingsLimiter, aiController.getStatus);
router.post('/consent', aiSettingsLimiter, validateAiConsent, checkValidation, aiController.giveConsent);
router.put('/language', aiSettingsLimiter, validateAiLanguage, checkValidation, aiController.setLanguage);
router.put('/chats/:chatId', aiSettingsLimiter, validateAiChatSetting, checkValidation, aiController.setChatEnabled);
router.post('/chats/:chatId/summary', aiActionLimiter, validateChatIdParam, checkValidation, aiController.summarizeUnread);
router.post('/messages/:messageId/translate', aiActionLimiter, validateMessageIdParam, checkValidation, aiController.translateMessage);

module.exports = router;
