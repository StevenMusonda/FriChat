/**
 * Input Validation and Sanitization Utilities
 */

const { body, param, query, validationResult } = require('express-validator');
const { isValidTimezone } = require('./notificationSettings');
const { MAX_MESSAGE_LENGTH, MAX_FORWARD_MESSAGES, MAX_FORWARD_CHATS } = require('../config/messages');

/**
 * Validation rules for user registration
 */
const validateRegistration = [
    body('username')
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be between 3 and 50 characters')
        .matches(/^[a-zA-Z0-9_]+$/)
        .withMessage('Username can only contain letters, numbers, and underscores'),
    
    body('email')
        .trim()
        .isEmail()
        .withMessage('Invalid email address')
        .normalizeEmail(),
    
    body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long'),
    
    body('fullName')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Full name must not exceed 100 characters')
];

/**
 * Validation rules for login
 */
const validateLogin = [
    body('username')
        .trim()
        .notEmpty()
        .withMessage('Username or email is required'),
    
    body('password')
        .notEmpty()
        .withMessage('Password is required')
];

/**
 * Validation rules for requesting a password reset
 */
const validateForgotPassword = [
    body('email')
        .trim()
        .isEmail()
        .withMessage('Invalid email address')
        .normalizeEmail()
];

/**
 * Validation rules for resetting a password
 */
const validateResetPassword = [
    body('token')
        .isString()
        .matches(/^[a-f0-9]{64}$/)
        .withMessage('Invalid reset token'),

    body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long')
];

/**
 * Validation rules for sending messages
 */
const validateMessage = [
    body('chatId')
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required'),
    
    body('messageType')
        .isIn(['text', 'image', 'video', 'file'])
        .withMessage('Invalid message type'),
    
    body('content')
        .optional()
        .trim()
        .isLength({ max: MAX_MESSAGE_LENGTH })
        .withMessage('Message content too long'),

    body('replyToMessageId')
        .optional({ values: 'null' })
        .isInt({ min: 1 })
        .withMessage('Invalid reply target')
        .toInt(),

    // Id from POST /api/messages/upload; the server takes every file detail from its own record
    body('fileId')
        .optional({ values: 'null' })
        .isInt({ min: 1 })
        .withMessage('Invalid file reference')
        .toInt()
];

/**
 * Optional chat and reply target on a file upload (multipart fields).
 * No chatId = upload only; the response's fileId is attached by a later send.
 */
const validateUploadReply = [
    body('chatId')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required')
        .toInt(),

    body('replyToMessageId')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Invalid reply target')
        .toInt()
];

const messageIdParamRule = param('messageId')
    .isInt({ min: 1 })
    .withMessage('Invalid message ID')
    .toInt();

/**
 * Validation rules for routes that only take :messageId (star/unstar)
 */
const validateMessageIdParam = [
    messageIdParamRule
];

/**
 * Validation rules for editing a message
 */
const validateEditMessage = [
    messageIdParamRule,

    body('content')
        .isString()
        .withMessage('Message content is required')
        .bail()
        .trim()
        .isLength({ min: 1, max: MAX_MESSAGE_LENGTH })
        .withMessage(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters`)
];

/**
 * Validation rules for forwarding messages
 */
const validateForward = [
    body('messageIds')
        .isArray({ min: 1, max: MAX_FORWARD_MESSAGES })
        .withMessage(`Select between 1 and ${MAX_FORWARD_MESSAGES} messages`),

    body('messageIds.*')
        .isInt({ min: 1 })
        .withMessage('Invalid message ID')
        .toInt(),

    body('chatIds')
        .isArray({ min: 1, max: MAX_FORWARD_CHATS })
        .withMessage(`Select between 1 and ${MAX_FORWARD_CHATS} chats`),

    body('chatIds.*')
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt()
];

/**
 * Validation rules for listing starred messages
 */
const validateStarredQuery = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('limit must be between 1 and 100')
        .toInt(),

    query('before')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid cursor')
        .toInt()
];

/**
 * Validation rules for creating a chat
 */
const validateCreateChat = [
    body('chatType')
        .isIn(['direct', 'group'])
        .withMessage('Invalid chat type'),
    
    body('chatName')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Chat name must not exceed 100 characters'),
    
    body('participants')
        .isArray({ min: 1 })
        .withMessage('At least one participant is required')
];

/**
 * Validation rules for the per-chat "mentions only" setting
 */
const validateMentionsOnly = [
    param('chatId')
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    body('enabled')
        .isBoolean({ strict: true })
        .withMessage('enabled must be true or false')
];

// Push service endpoints are public HTTPS URLs; refuse anything that points the server at itself
// or at a raw IP, since the server will POST to this URL
function isPushEndpoint(value) {
    let url;
    try {
        url = new URL(value);
    } catch (e) {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
        && host !== 'localhost'
        && !host.endsWith('.localhost')
        && !/^[\d.]+$/.test(host)
        && !host.includes(':')
        && !host.startsWith('[');
}

const pushEndpointRule = body('endpoint')
    .isString()
    .isLength({ min: 10, max: 2048 })
    .custom(isPushEndpoint)
    .withMessage('Invalid push endpoint');

// Base64url, as produced by PushSubscription.toJSON()
const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Validation rules for saving a push subscription
 */
const validatePushSubscription = [
    pushEndpointRule,

    body('keys.p256dh')
        .isString()
        .isLength({ min: 16, max: 255 })
        .matches(PUSH_KEY_PATTERN)
        .withMessage('Invalid p256dh key'),

    body('keys.auth')
        .isString()
        .isLength({ min: 8, max: 255 })
        .matches(PUSH_KEY_PATTERN)
        .withMessage('Invalid auth key')
];

/**
 * Validation rules for removing a push subscription
 */
const validatePushUnsubscribe = [
    pushEndpointRule
];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validation rules for do-not-disturb settings (every field optional, only sent fields change)
 */
const validateNotificationSettings = [
    body('dndEnabled')
        .optional()
        .isBoolean({ strict: true })
        .withMessage('dndEnabled must be true or false'),

    body('quietHoursEnabled')
        .optional()
        .isBoolean({ strict: true })
        .withMessage('quietHoursEnabled must be true or false'),

    body(['quietStart', 'quietEnd'])
        .optional({ values: 'null' })
        .matches(TIME_PATTERN)
        .withMessage('Times must be HH:MM (24-hour)'),

    body('timezone')
        .optional()
        .custom(isValidTimezone)
        .withMessage('Unknown timezone')
];

/**
 * Middleware to check validation results
 */
const checkValidation = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors.array()
        });
    }
    next();
};

/**
 * Legacy HTML escaping on write, still used for profile full names only.
 * Never use it for message text or chat names: those are stored raw (utils/messageText.js)
 * and escaped by the frontend at render time.
 */
function sanitizeHtml(text) {
    if (!text) return text;
    
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

/**
 * Validate file type
 */
function validateFileType(mimetype, allowedTypes) {
    return allowedTypes.includes(mimetype);
}

module.exports = {
    validateRegistration,
    validateLogin,
    validateForgotPassword,
    validateResetPassword,
    validateMessage,
    validateUploadReply,
    validateMessageIdParam,
    validateEditMessage,
    validateForward,
    validateStarredQuery,
    validateCreateChat,
    validateMentionsOnly,
    validatePushSubscription,
    validatePushUnsubscribe,
    validateNotificationSettings,
    checkValidation,
    sanitizeHtml,
    validateFileType
};
