/**
 * Chat Routes
 */

const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validateCreateChat, validateMentionsOnly, checkValidation } = require('../utils/validation');

// Per-chat notification settings
const chatSettingsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many setting changes. Please wait a moment.'
});

// All routes require authentication
router.use(authenticateToken);

// Chat routes
router.get('/', chatController.getUserChats);
router.get('/:chatId', chatController.getChatById);
router.post('/', validateCreateChat, checkValidation, chatController.createChat);

// Group management
router.post('/:chatId/members', chatController.addMember);
router.delete('/:chatId/members/:userId', chatController.removeMember);

// User search
router.get('/search/users', chatController.searchUsers);

// Per-user read position, mute and archive
router.post('/:chatId/read', chatController.markRead);
router.put('/:chatId/mute', chatController.updateMute);
router.put('/:chatId/archive', chatController.updateArchive);
router.put('/:chatId/mentions-only', chatSettingsLimiter, validateMentionsOnly, checkValidation, chatController.updateMentionsOnly);

// Delete chat
router.delete('/:chatId', chatController.deleteChat);

module.exports = router;
