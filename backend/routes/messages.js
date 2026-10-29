/**
 * Message Routes
 */

const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const searchController = require('../controllers/searchController');
const { authenticateToken } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateMessage,
    validateUploadReply,
    validateMessageIdParam,
    validateReaction,
    validateReactionRemoval,
    validateEditMessage,
    validateForward,
    validateStarredQuery,
    validateMessagesQuery,
    validateSearchQuery,
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

// Search runs a full-text query per request (search-as-you-type is debounced by the client)
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many searches. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

// All routes require authentication
router.use(authenticateToken);

// Message search, in one chat (?chatId=) or across all of the user's chats (before the /:messageId routes)
router.get('/search', searchLimiter, validateSearchQuery, checkValidation, searchController.searchMessages);

// Size cap and allowed file types for the composer's upload tray
router.get('/upload-limits', messageActionLimiter, messageController.getUploadLimits);

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
// ?before= older page, ?after= newer page, ?around= a page centred on a message (jump to it)
router.get('/chat/:chatId', validateMessagesQuery, checkValidation, messageController.getMessages);
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

// Reaction routes (one reaction per user per message; same emoji again removes it)
router.post('/:messageId/reactions', messageActionLimiter, validateReaction, checkValidation, messageController.addReaction);
router.delete('/:messageId/reactions', messageActionLimiter, validateReactionRemoval, checkValidation, messageController.removeReaction);

// Delete message route
router.delete('/:messageId', messageController.deleteMessage);

// Pin/Unpin message routes
router.post('/:messageId/pin', messageController.pinMessage);
router.delete('/:messageId/unpin', messageController.unpinMessage);
router.get('/chat/:chatId/pinned', messageController.getPinnedMessages);

module.exports = router;
