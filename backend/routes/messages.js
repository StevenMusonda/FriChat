/**
 * Message Routes
 */

const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { authenticateToken } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');
const { validateMessage, checkValidation } = require('../utils/validation');

// All routes require authentication
router.use(authenticateToken);

// Message routes
router.get('/chat/:chatId', messageController.getMessages);
router.post('/', validateMessage, checkValidation, messageController.sendMessage);
router.post('/upload', upload.single('file'), handleUploadError, messageController.uploadFile);
router.patch('/:messageId/status', messageController.updateMessageStatus);

// Reaction routes
router.post('/:messageId/reactions', messageController.addReaction);
router.delete('/:messageId/reactions', messageController.removeReaction);

// Delete message route
router.delete('/:messageId', messageController.deleteMessage);

// Pin/Unpin message routes
router.post('/:messageId/pin', messageController.pinMessage);
router.delete('/:messageId/unpin', messageController.unpinMessage);
router.get('/chat/:chatId/pinned', messageController.getPinnedMessages);

module.exports = router;
