/**
 * Message Routes
 */

const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { authenticateToken } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateMessage,
    validateUploadReply,
    validateMessageIdParam,
    validateEditMessage,
    validateForward,
    validateStarredQuery,
    checkValidation
} = require('../utils/validation');

// Edit, star and the starred list
const messageActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many message actions. Please slow down.'
});

// Each forward can create up to 50 messages, so it gets a tighter budget
const forwardLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many forwards. Please wait a moment.'
});

// All routes require authentication
router.use(authenticateToken);

// Starred messages (before the /:messageId routes)
router.get('/starred', messageActionLimiter, validateStarredQuery, checkValidation, messageController.getStarredMessages);

// Forward one or more messages to one or more chats
router.post('/forward', forwardLimiter, validateForward, checkValidation, messageController.forwardMessages);

// Uploads write to disk, so they get their own budget (checked before multer stores anything)
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many uploads. Please wait a moment.'
});

// Message routes
router.get('/chat/:chatId', messageController.getMessages);
router.post('/', validateMessage, checkValidation, messageController.sendMessage);
router.post('/upload', uploadLimiter, upload.single('file'), handleUploadError, validateUploadReply, checkValidation, messageController.uploadFile);
router.patch('/:messageId/status', messageController.updateMessageStatus);

// Edit a text message (sender only, within the edit window)
router.patch('/:messageId', messageActionLimiter, validateEditMessage, checkValidation, messageController.editMessage);

// Per-user stars
router.post('/:messageId/star', messageActionLimiter, validateMessageIdParam, checkValidation, messageController.starMessage);
router.delete('/:messageId/star', messageActionLimiter, validateMessageIdParam, checkValidation, messageController.unstarMessage);

// Remove the link preview card (sender only)
router.delete('/:messageId/link-preview', messageActionLimiter, validateMessageIdParam, checkValidation, messageController.dismissLinkPreview);

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
