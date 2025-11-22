/**
 * Chat Routes
 */

const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticateToken } = require('../middleware/auth');
const { validateCreateChat, checkValidation } = require('../utils/validation');

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

// Delete chat
router.delete('/:chatId', chatController.deleteChat);

module.exports = router;
