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

module.exports = router;
