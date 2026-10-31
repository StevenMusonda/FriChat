/**
 * Input Validation and Sanitization Utilities
 */

const { body, param, query, validationResult } = require('express-validator');
const { isValidTimezone } = require('./notificationSettings');
const {
    MAX_MESSAGE_LENGTH,
    MAX_FORWARD_MESSAGES,
    MAX_FORWARD_CHATS,
    VOICE_MAX_SECONDS,
    VOICE_DURATION_GRACE_MS,
    VOICE_WAVEFORM_MAX_BARS,
    DISAPPEARING_DURATIONS
} = require('../config/messages');
const { isValidEmoji } = require('./reactions');
const { stripControlChars } = require('./messageText');
const { TOKEN_PATTERN } = require('./invites');
const { HAS_FILTERS, MEDIA_TABS, MAX_QUERY_LENGTH: MAX_SEARCH_QUERY_LENGTH } = require('./messageSearch');
const {
    GROUP_NAME_MAX_LENGTH,
    GROUP_DESCRIPTION_MAX_LENGTH,
    MEMBER_TAG_MAX_LENGTH,
    INVITE_EXPIRY_OPTIONS,
    INVITE_MAX_USES_LIMIT
} = require('../config/groups');
const { secondsFromNow } = require('./timeSql');
const {
    DISPLAY_NAME_MAX_LENGTH,
    BIO_MAX_LENGTH,
    STATUS_TEXT_MAX_LENGTH,
    STATUS_EMOJI_MAX_CHARS,
    STATUS_DURATION_OPTIONS,
    AUDIENCES
} = require('../config/profile');
const {
    POLL_QUESTION_MAX_LENGTH,
    POLL_OPTION_MAX_LENGTH,
    POLL_MIN_OPTIONS,
    POLL_MAX_OPTIONS
} = require('../config/scheduling');
const { HISTORY_MAX_PAGE_SIZE: CALL_HISTORY_MAX_PAGE_SIZE } = require('../config/calls');
const {
    REPORT_REASONS,
    REPORT_STATUSES,
    REPORT_NOTE_MAX_LENGTH,
    WARNING_MAX_LENGTH,
    SUSPEND_REASON_MAX_LENGTH,
    AUDIT_EVENTS
} = require('../config/moderation');
const {
    EVENT_TITLE_MAX_LENGTH,
    EVENT_DESCRIPTION_MAX_LENGTH,
    EVENT_LOCATION_MAX_LENGTH,
    EVENT_REMINDER_OFFSETS,
    RSVP_RESPONSES,
    LIST_NAME_MAX_LENGTH,
    LIST_ITEM_MAX_LENGTH
} = require('../config/planning');
const { eventSecondsFromNow } = require('./events');
const { checkBirthday } = require('./birthdays');

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
        .isIn(['text', 'image', 'video', 'file', 'voice'])
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
        .toInt(),

    // Voice notes: length and level bars measured while recording (only kept for audio files)
    body('voiceDurationMs')
        .optional({ values: 'falsy' })
        .isInt({ min: 1, max: VOICE_MAX_SECONDS * 1000 + VOICE_DURATION_GRACE_MS })
        .withMessage(`Voice notes can be up to ${VOICE_MAX_SECONDS / 60} minutes long`)
        .toInt(),

    body('voiceWaveform')
        .optional({ values: 'falsy' })
        .isString()
        .custom(isWaveform)
        .withMessage(`Waveform must be up to ${VOICE_WAVEFORM_MAX_BARS} comma-separated levels from 0 to 100`)
];

/**
 * "12,40,100,0": 1..VOICE_WAVEFORM_MAX_BARS whole numbers from 0 to 100
 */
function isWaveform(value) {
    if (typeof value !== 'string' || value.length > VOICE_WAVEFORM_MAX_BARS * 4) return false;
    const levels = value.split(',');
    return levels.length >= 1 && levels.length <= VOICE_WAVEFORM_MAX_BARS
        && levels.every(level => /^\d{1,3}$/.test(level) && Number(level) <= 100);
}

/**
 * PUT /api/chats/:chatId/disappearing - { seconds: 0 | 86400 | 604800 | 7776000 }
 */
const validateDisappearingTimer = [
    param('chatId')
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    body('seconds')
        .isInt()
        .withMessage('seconds must be a number')
        .bail()
        .toInt()
        .isIn(DISAPPEARING_DURATIONS)
        .withMessage('Pick off, 24 hours, 7 days or 90 days')
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
 * Validation rules for reacting to a message (toggle/replace)
 */
const validateReaction = [
    messageIdParamRule,

    body('emoji')
        .custom(isValidEmoji)
        .withMessage('Invalid emoji')
];

/**
 * Validation rules for removing a reaction (emoji optional: only removed if it still matches)
 */
const validateReactionRemoval = [
    messageIdParamRule,

    body('emoji')
        .optional({ values: 'null' })
        .custom(isValidEmoji)
        .withMessage('Invalid emoji')
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
 * Validation rules for the Calls tab: GET /api/calls?limit=&before=
 */
const validateCallHistoryQuery = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: CALL_HISTORY_MAX_PAGE_SIZE })
        .withMessage('limit must be between 1 and 100')
        .toInt(),

    query('before')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid cursor')
        .toInt()
];

// Optional message id cursor in the query string
function cursorRule(field) {
    return query(field)
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid cursor')
        .toInt();
}

/**
 * Validation rules for a page of a chat's messages: before (older page), after (newer page)
 * or around (a page centred on a message, used to jump to it). At most one of them.
 */
const validateMessagesQuery = [
    param('chatId')
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('limit must be between 1 and 100')
        .toInt(),

    cursorRule('before'),
    cursorRule('after'),
    cursorRule('around'),

    query('around')
        .custom((value, { req }) => {
            const cursors = ['before', 'after', 'around'].filter(key => req.query[key] !== undefined);
            if (cursors.length > 1) throw new Error('Use only one of before, after and around');
            return true;
        })
];

/**
 * Validation rules for message search (phase 7)
 */
const validateSearchQuery = [
    query('q')
        .optional()
        .isString()
        .withMessage('Invalid search text')
        .isLength({ max: MAX_SEARCH_QUERY_LENGTH })
        .withMessage(`Search text must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`),

    query('chatId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    query('senderId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid sender')
        .toInt(),

    query(['from', 'to'])
        .optional()
        .isISO8601({ strict: true })
        .withMessage('Dates must be ISO 8601 (for example 2026-10-29 or 2026-10-29T00:00:00Z)')
        .toDate(),

    query('to')
        .custom((value, { req }) => {
            if (req.query.from instanceof Date && value instanceof Date && value <= req.query.from) {
                throw new Error('The end date must be after the start date');
            }
            return true;
        }),

    query('has')
        .optional()
        .isIn(Object.keys(HAS_FILTERS))
        .withMessage('has must be one of image, video, file, link'),

    cursorRule('before'),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 50 })
        .withMessage('limit must be between 1 and 50')
        .toInt()
];

/**
 * Validation rules for the shared media panel (phase 7)
 */
const validateSharedMediaQuery = [
    param('chatId')
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    query('type')
        .optional()
        .isIn(Object.keys(MEDIA_TABS))
        .withMessage('type must be one of media, files, links'),

    cursorRule('before'),
    cursorRule('after'),

    query('after')
        .custom((value, { req }) => {
            if (value !== undefined && req.query.before !== undefined) {
                throw new Error('Use only one of before and after');
            }
            return true;
        }),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 60 })
        .withMessage('limit must be between 1 and 60')
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

const chatIdParamRule = param('chatId')
    .isInt({ min: 1 })
    .withMessage('Invalid chat ID')
    .toInt();

/**
 * Validation rules for group routes that only take :chatId
 */
const validateChatIdParam = [
    chatIdParamRule
];

// Optional text field: string (control characters stripped, trimmed) within a length limit
function groupTextRule(field, max, label) {
    return body(field)
        .optional({ values: 'null' })
        .isString()
        .withMessage(`${label} must be text`)
        .bail()
        .customSanitizer(value => stripControlChars(value).trim())
        .isLength({ max })
        .withMessage(`${label} must be at most ${max} characters`);
}

/**
 * Validation rules for changing a group's profile and settings (admins only; send only what changes)
 */
const validateGroupSettings = [
    chatIdParamRule,

    groupTextRule('chatName', GROUP_NAME_MAX_LENGTH, 'Group name')
        .bail()
        .isLength({ min: 1 })
        .withMessage('Group name cannot be empty'),

    groupTextRule('description', GROUP_DESCRIPTION_MAX_LENGTH, 'Description'),

    body(['approveNewMembers', 'announcementOnly'])
        .optional()
        .isBoolean({ strict: true })
        .withMessage('Settings must be true or false'),

    body()
        .custom(value => ['chatName', 'description', 'approveNewMembers', 'announcementOnly'].some(key => value && value[key] !== undefined))
        .withMessage('Nothing to update')
];

/**
 * Validation rules for creating an invite link
 */
const validateCreateInvite = [
    chatIdParamRule,

    body('expiresIn')
        .optional()
        .isIn(INVITE_EXPIRY_OPTIONS)
        .withMessage(`expiresIn must be one of ${INVITE_EXPIRY_OPTIONS.join(', ')}`),

    body('maxUses')
        .optional({ values: 'null' })
        .isInt({ min: 1, max: INVITE_MAX_USES_LIMIT })
        .withMessage(`maxUses must be between 1 and ${INVITE_MAX_USES_LIMIT}`)
        .toInt()
];

/**
 * Validation rules for revoking an invite link
 */
const validateInviteIdParam = [
    chatIdParamRule,

    param('inviteId')
        .isInt({ min: 1 })
        .withMessage('Invalid invite ID')
        .toInt()
];

/**
 * Validation rules for approving or declining a join request
 */
const validateJoinRequestParam = [
    chatIdParamRule,

    param('requestId')
        .isInt({ min: 1 })
        .withMessage('Invalid request ID')
        .toInt()
];

/**
 * Validation rules for setting a member's tag (null or empty clears it)
 */
const validateMemberTag = [
    chatIdParamRule,

    param('userId')
        .isInt({ min: 1 })
        .withMessage('Invalid user ID')
        .toInt(),

    body('tag')
        .exists()
        .withMessage('tag is required (null clears it)'),

    groupTextRule('tag', MEMBER_TAG_MAX_LENGTH, 'Tag')
];

/**
 * Validation rules for leaving a group (newAdminId: who takes over when the last admin leaves)
 */
const validateLeaveGroup = [
    chatIdParamRule,

    body('newAdminId')
        .optional({ values: 'null' })
        .isInt({ min: 1 })
        .withMessage('Invalid new admin')
        .toInt()
];

/**
 * Validation rules for invite-link preview and join. A malformed code gets the same answer as an unknown one.
 */
const validateInviteCode = [
    param('code')
        .matches(TOKEN_PATTERN)
        .withMessage('This invite link is invalid. Check that you copied the whole link.')
];

const userIdParamRule = param('userId')
    .isInt({ min: 1 })
    .withMessage('Invalid user ID')
    .toInt();

/**
 * Validation rules for removing a group member (?ban=true also bans them)
 */
const validateRemoveMember = [
    chatIdParamRule,
    userIdParamRule,

    query('ban')
        .optional()
        .isIn(['true', 'false', '1', '0'])
        .withMessage('ban must be true or false')
];

/**
 * Validation rules for making a member an admin or a regular member
 */
const validateMemberRole = [
    chatIdParamRule,
    userIdParamRule,

    body('role')
        .isIn(['admin', 'member'])
        .withMessage("role must be 'admin' or 'member'")
];

/**
 * Validation rules for adding a member to a group
 */
const validateAddMember = [
    chatIdParamRule,

    body('userId')
        .isInt({ min: 1 })
        .withMessage('Invalid user ID')
        .toInt()
];

/**
 * Validation rules for group routes that take :chatId and :userId (unban)
 */
const validateChatUserParams = [
    chatIdParamRule,
    userIdParamRule
];

/**
 * Validation rules for changing the password while signed in
 */
const validateChangePassword = [
    body('currentPassword')
        .isString()
        .notEmpty()
        .withMessage('Current password is required'),

    body('newPassword')
        .isString()
        .isLength({ min: 6 })
        .withMessage('New password must be at least 6 characters long')
        .bail()
        .custom((value, { req }) => value !== req.body.currentPassword)
        .withMessage('The new password must be different from the current one')
];

/**
 * Validation rules for the email verification link
 */
const validateVerifyEmail = [
    body('token')
        .isString()
        .matches(/^[a-f0-9]{64}$/)
        .withMessage('This verification link is invalid')
];

/**
 * Validation rules for signing out one device
 */
const validateSessionIdParam = [
    param('sessionId')
        .isInt({ min: 1 })
        .withMessage('Invalid session ID')
        .toInt()
];

// The password checked again before a sensitive action; bcrypt compares bytes, so it's left as typed
const passwordConfirmationRule = body('password')
    .isString()
    .notEmpty()
    .isLength({ max: 200 })
    .withMessage('Enter your password');

// A 6-digit code or a recovery code; spaces and dashes are fine
const twoFactorCodeRule = () => body('code')
    .isString()
    .trim()
    .isLength({ min: 6, max: 32 })
    .withMessage('Enter the code from your authenticator app, or a recovery code');

/**
 * Validation rules for the second step of a sign-in
 */
const validateTwoFactorLogin = [
    body('challengeToken')
        .isString()
        .isLength({ min: 1, max: 1000 })
        .withMessage('Please sign in again'),
    twoFactorCodeRule()
];

const validateTwoFactorSetup = [passwordConfirmationRule];

const validateTwoFactorConfirm = [twoFactorCodeRule()];

/**
 * For actions that need the password, and a code when 2FA is on (the handler decides that)
 */
const validateReauthentication = [
    passwordConfirmationRule,
    twoFactorCodeRule().optional({ values: 'falsy' })
];

const validateChangeEmail = [
    ...validateReauthentication,
    body('newEmail')
        .trim()
        .isEmail()
        .withMessage('Enter a valid email address')
        .isLength({ max: 100 })
        .withMessage('That email address is too long')
        .normalizeEmail()
];

const validateSecurityActivityQuery = [
    query('before')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid cursor')
        .toInt()
];

const validateExportIdParam = [
    param('exportId')
        .isInt({ min: 1 })
        .withMessage('Invalid export ID')
        .toInt()
];

const validateExportDownload = [
    ...validateExportIdParam,
    query('token')
        .isString()
        .isLength({ min: 1, max: 1000 })
        .withMessage('This link has expired')
];

/**
 * Validation rules for blocking a user
 */
const validateBlockUser = [
    body('userId')
        .isInt({ min: 1 })
        .withMessage('Invalid user ID')
        .toInt()
];

// --- Reports and the admin console (phase 13) ---

function plainTextRule(field, max, label) {
    return body(field)
        .optional({ values: 'null' })
        .isString()
        .withMessage(`${label} must be text`)
        .bail()
        .customSanitizer(value => stripControlChars(value).trim())
        .isLength({ max })
        .withMessage(`${label} can be up to ${max} characters`);
}

function optionalIdRule(location, field, label) {
    return location(field)
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage(`Invalid ${label}`)
        .toInt();
}

function beforeCursorRule() {
    return optionalIdRule(query, 'before', 'cursor');
}

/**
 * POST /api/reports
 */
const validateReport = [
    body('targetType')
        .isIn(['message', 'user'])
        .withMessage("targetType must be 'message' or 'user'"),

    optionalIdRule(body, 'messageId', 'message ID'),
    optionalIdRule(body, 'userId', 'user ID'),
    optionalIdRule(body, 'chatId', 'chat ID'),

    body('targetType').custom((value, { req }) => {
        if (value === 'message' && !req.body.messageId) throw new Error('messageId is required');
        if (value === 'user' && !req.body.userId) throw new Error('userId is required');
        return true;
    }),

    body('reason')
        .isIn(REPORT_REASONS)
        .withMessage(`reason must be one of: ${REPORT_REASONS.join(', ')}`),

    plainTextRule('note', REPORT_NOTE_MAX_LENGTH, 'The note'),

    body('block')
        .optional({ values: 'null' })
        .isBoolean({ strict: true })
        .withMessage('block must be true or false')
];

const validateWarningIdParam = [
    param('warningId').isInt({ min: 1 }).withMessage('Invalid warning ID').toInt()
];

const reportIdParamRule = param('reportId').isInt({ min: 1 }).withMessage('Invalid report ID').toInt();

const validateReportIdParam = [reportIdParamRule];

const validateEvidenceFileParams = [
    reportIdParamRule,
    param('evidenceId').isInt({ min: 1 }).withMessage('Invalid evidence ID').toInt()
];

const validateAdminReportsQuery = [
    query('status').optional({ values: 'falsy' }).isIn(REPORT_STATUSES).withMessage('Invalid status'),
    beforeCursorRule()
];

const validateAdminWarn = [
    reportIdParamRule,
    body('message')
        .isString()
        .withMessage('Write the warning')
        .bail()
        .customSanitizer(value => stripControlChars(value).trim())
        .isLength({ min: 1, max: WARNING_MAX_LENGTH })
        .withMessage(`A warning is 1-${WARNING_MAX_LENGTH} characters`)
];

const suspendReasonRule = () => plainTextRule('reason', SUSPEND_REASON_MAX_LENGTH, 'The reason');

const validateAdminSuspend = [reportIdParamRule, suspendReasonRule()];

const validateAdminSuspendUser = [userIdParamRule, suspendReasonRule()];

const validateAdminUsersQuery = [
    query('q').optional({ values: 'falsy' }).isString().isLength({ max: 100 }).withMessage('Search is too long'),
    query('status').optional({ values: 'falsy' }).isIn(['active', 'suspended']).withMessage('Invalid status'),
    beforeCursorRule()
];

function isCalendarDate(value) {
    const date = new Date(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const validateAuditQuery = [
    query('event').optional({ values: 'falsy' }).isIn(AUDIT_EVENTS).withMessage('Unknown event'),
    optionalIdRule(query, 'actorId', 'actor ID'),
    query('targetType').optional({ values: 'falsy' }).isIn(['user', 'chat', 'message', 'report', 'session', 'invite', 'file']).withMessage('Unknown target type'),
    optionalIdRule(query, 'targetId', 'target ID'),
    query('ip').optional({ values: 'falsy' }).isIP().withMessage('Invalid IP address'),
    query('q').optional({ values: 'falsy' }).isString().isLength({ max: 100 }).withMessage('Search is too long'),
    query('from').optional({ values: 'falsy' }).custom(isCalendarDate).withMessage('from must be YYYY-MM-DD'),
    query('to').optional({ values: 'falsy' }).custom(isCalendarDate).withMessage('to must be YYYY-MM-DD'),
    beforeCursorRule()
];

/**
 * Validation rules for unblocking a user
 */
const validateUserIdParam = [
    userIdParamRule
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
 * A future time picked by the user: ISO 8601 with an offset, between now and MAX_SCHEDULE_DAYS
 * (the controller converts it to seconds-from-now; see utils/timeSql.js)
 */
function futureTimeRule(field) {
    return body(field)
        .custom((value) => {
            const parsed = secondsFromNow(value);
            if (!parsed.ok) throw new Error(parsed.error);
            return true;
        });
}

/**
 * Phase 8: polls
 */
const validateCreatePoll = [
    body('chatId')
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required')
        .toInt(),

    // Cleaned (control characters, trimming, duplicates) in utils/polls.js
    body('question')
        .isString()
        .withMessage('The question must be text')
        .isLength({ min: 1, max: POLL_QUESTION_MAX_LENGTH + 50 })
        .withMessage(`The question must be at most ${POLL_QUESTION_MAX_LENGTH} characters`),

    body('options')
        .isArray({ min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS })
        .withMessage(`A poll needs ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options`),

    body('options.*')
        .isString()
        .withMessage('Each option must be text')
        .isLength({ max: POLL_OPTION_MAX_LENGTH + 50 })
        .withMessage(`Options must be at most ${POLL_OPTION_MAX_LENGTH} characters`),

    body(['multipleChoice', 'anonymous'])
        .optional()
        .isBoolean({ strict: true })
        .withMessage('Must be true or false'),

    futureTimeRule('closesAt').optional({ values: 'null' })
];

const validatePollIdParam = [
    param('pollId')
        .isInt({ min: 1 })
        .withMessage('Invalid poll ID')
        .toInt()
];

const validatePollVote = [
    ...validatePollIdParam,

    // The whole selection; [] takes the vote back
    body('optionIds')
        .isArray({ max: POLL_MAX_OPTIONS })
        .withMessage('optionIds must be a list'),

    body('optionIds.*')
        .isInt({ min: 1 })
        .withMessage('Invalid option')
        .toInt()
];

/**
 * Phase 8: scheduled messages
 */
const validateScheduledIdParam = [
    param('scheduledId')
        .isInt({ min: 1 })
        .withMessage('Invalid scheduled message ID')
        .toInt()
];

const validateScheduledQuery = [
    query('chatId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt()
];

const validateScheduleMessage = [
    body('chatId')
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required')
        .toInt(),

    // Cleaned with the one message text rule (utils/messageText.js)
    body('content')
        .isString()
        .withMessage('Message content must be text')
        .isLength({ max: MAX_MESSAGE_LENGTH + 100 })
        .withMessage('Message content too long'),

    futureTimeRule('sendAt'),

    body('replyToMessageId')
        .optional({ values: 'null' })
        .isInt({ min: 1 })
        .withMessage('Invalid reply target')
        .toInt()
];

const validateUpdateScheduled = [
    ...validateScheduledIdParam,

    body('content')
        .optional()
        .isString()
        .withMessage('Message content must be text')
        .isLength({ max: MAX_MESSAGE_LENGTH + 100 })
        .withMessage('Message content too long'),

    futureTimeRule('sendAt').optional(),

    body()
        .custom((value) => value && (value.content !== undefined || value.sendAt !== undefined))
        .withMessage('Send new content, a new sendAt, or both')
];

/**
 * Phase 8: reminders
 */
const validateCreateReminder = [
    body('messageId')
        .isInt({ min: 1 })
        .withMessage('Invalid message ID')
        .toInt(),

    futureTimeRule('remindAt')
];

const validateReminderIdParam = [
    param('reminderId')
        .isInt({ min: 1 })
        .withMessage('Invalid reminder ID')
        .toInt()
];

const validateRemindersQuery = [
    query('status')
        .optional()
        .isIn(['pending', 'fired'])
        .withMessage('status must be pending or fired')
];

/**
 * Phase 12: events. Text is cleaned (control characters, one line, trimming) in utils/events.js;
 * these rules check types and rough lengths. Times are ISO 8601 with an offset.
 */
function eventTimeRule(field) {
    return body(field)
        .custom((value) => {
            const parsed = eventSecondsFromNow(value);
            if (!parsed.ok) throw new Error(parsed.error);
            return true;
        });
}

function eventTextRules() {
    return [
        body('description')
            .optional({ values: 'null' })
            .isString()
            .withMessage('The description must be text')
            .isLength({ max: EVENT_DESCRIPTION_MAX_LENGTH + 100 })
            .withMessage(`The description must be at most ${EVENT_DESCRIPTION_MAX_LENGTH} characters`),

        body('location')
            .optional({ values: 'null' })
            .isString()
            .withMessage('The location must be text')
            .isLength({ max: EVENT_LOCATION_MAX_LENGTH + 50 })
            .withMessage(`The location must be at most ${EVENT_LOCATION_MAX_LENGTH} characters`),

        body('timezone')
            .optional()
            .custom(isValidTimezone)
            .withMessage('Unknown timezone'),

        body('reminders')
            .optional()
            .isArray({ max: Object.keys(EVENT_REMINDER_OFFSETS).length })
            .withMessage('reminders must be a list'),

        body('reminders.*')
            .isIn(Object.keys(EVENT_REMINDER_OFFSETS))
            .withMessage(`Reminders must be ${Object.keys(EVENT_REMINDER_OFFSETS).join(', ')}`)
    ];
}

const validateCreateEvent = [
    body('chatId')
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required')
        .toInt(),

    body('title')
        .isString()
        .withMessage('The title must be text')
        .isLength({ min: 1, max: EVENT_TITLE_MAX_LENGTH + 50 })
        .withMessage(`The title must be at most ${EVENT_TITLE_MAX_LENGTH} characters`),

    ...eventTextRules(),
    eventTimeRule('startsAt'),
    eventTimeRule('endsAt')
];

const validateEventIdParam = [
    param('eventId')
        .isInt({ min: 1 })
        .withMessage('Invalid event ID')
        .toInt()
];

// Send only what changes
const validateUpdateEvent = [
    ...validateEventIdParam,

    body('title')
        .optional()
        .isString()
        .withMessage('The title must be text')
        .isLength({ min: 1, max: EVENT_TITLE_MAX_LENGTH + 50 })
        .withMessage(`The title must be at most ${EVENT_TITLE_MAX_LENGTH} characters`),

    ...eventTextRules(),
    eventTimeRule('startsAt').optional(),
    eventTimeRule('endsAt').optional(),

    body()
        .custom((value) => value && ['title', 'description', 'location', 'timezone', 'startsAt', 'endsAt', 'reminders']
            .some(field => value[field] !== undefined))
        .withMessage('Send at least one field to change')
];

const validateRsvp = [
    ...validateEventIdParam,

    // null takes the answer back
    body('response')
        .custom((value) => value === null || RSVP_RESPONSES.includes(value))
        .withMessage(`response must be ${RSVP_RESPONSES.join(', ')} or null`)
];

const validateEventsQuery = [
    query('chatId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    query('scope')
        .optional()
        .isIn(['upcoming', 'past'])
        .withMessage('scope must be upcoming or past')
];

/**
 * Phase 12: shared lists (text cleaned in utils/lists.js, which the socket events use too)
 */
const validateListIdParam = [
    param('listId')
        .isInt({ min: 1 })
        .withMessage('Invalid list ID')
        .toInt()
];

function listNameRule() {
    return body('name')
        .isString()
        .withMessage('The list name must be text')
        .isLength({ min: 1, max: LIST_NAME_MAX_LENGTH + 50 })
        .withMessage(`The list name must be at most ${LIST_NAME_MAX_LENGTH} characters`);
}

const validateCreateList = [
    body('chatId')
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required')
        .toInt(),
    listNameRule()
];

const validateRenameList = [...validateListIdParam, listNameRule()];

const validateListsQuery = [
    query('chatId')
        .isInt({ min: 1 })
        .withMessage('Valid chat ID is required')
        .toInt()
];

function listItemTextRule() {
    return body('text')
        .isString()
        .withMessage('The item must be text')
        .isLength({ min: 1, max: LIST_ITEM_MAX_LENGTH + 50 })
        .withMessage(`The item must be at most ${LIST_ITEM_MAX_LENGTH} characters`);
}

const validateAddListItem = [
    ...validateListIdParam,
    listItemTextRule(),
    // null or missing = no due date
    futureTimeRule('dueAt').optional({ values: 'null' })
];

const validateListItemIdParam = [
    param('itemId')
        .isInt({ min: 1 })
        .withMessage('Invalid item ID')
        .toInt()
];

const validateUpdateListItem = [
    ...validateListItemIdParam,
    listItemTextRule().optional(),
    // null clears the due date
    futureTimeRule('dueAt').optional({ values: 'null' }),
    body('done')
        .optional()
        .isBoolean({ strict: true })
        .withMessage('done must be true or false'),
    body()
        .custom((value) => value && (value.text !== undefined || value.dueAt !== undefined || value.done !== undefined))
        .withMessage('Send text, dueAt or done')
];

/**
 * Phase 12: birthdays
 */
const validateBirthday = [
    body('day')
        .isInt({ min: 1, max: 31 })
        .withMessage('Pick a day')
        .toInt(),

    body('month')
        .isInt({ min: 1, max: 12 })
        .withMessage('Pick a month')
        .toInt(),

    body('year')
        .optional({ values: 'null' })
        .isInt()
        .withMessage('The year must be a number')
        .toInt(),

    body().custom((value, { req }) => {
        const year = req.body.year === undefined || req.body.year === null ? null : req.body.year;
        const error = checkBirthday(req.body.day, req.body.month, year);
        if (error) throw new Error(error);
        return true;
    })
];

const validateBirthdaysQuery = [
    param('chatId')
        .isInt({ min: 1 })
        .withMessage('Invalid chat ID')
        .toInt(),

    // The viewer's local date, so "today" is today where they are
    query('date')
        .matches(/^\d{4}-\d{2}-\d{2}$/)
        .withMessage('date must be YYYY-MM-DD')
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
 * checkValidation for multipart uploads: a refused upload doesn't leave its file on disk
 */
const checkUploadValidation = (req, res, next) => {
    if (!validationResult(req).isEmpty() && req.file && req.file.path) {
        require('fs').unlink(req.file.path, () => {});
    }
    return checkValidation(req, res, next);
};

/**
 * Validation rules for PATCH /api/messages/:messageId/status
 */
const validateMessageStatus = [
    messageIdParamRule,
    body('status')
        .isIn(['delivered', 'read'])
        .withMessage("status must be 'delivered' or 'read'")
];

// One line of profile text: control characters (and newlines) removed, trimmed, length-limited
function profileTextRule(field, max, label) {
    return body(field)
        .optional({ values: 'null' })
        .isString()
        .withMessage(`${label} must be text`)
        .bail()
        .customSanitizer(value => stripControlChars(value).replace(/\n+/g, ' ').trim())
        .isLength({ max })
        .withMessage(`${label} must be at most ${max} characters`);
}

/**
 * Validation rules for PUT /api/users/me/profile and PUT /api/auth/profile (send only what changes)
 */
const validateProfileUpdate = [
    profileTextRule('displayName', DISPLAY_NAME_MAX_LENGTH, 'Display name'),
    profileTextRule('fullName', DISPLAY_NAME_MAX_LENGTH, 'Display name'),
    profileTextRule('bio', BIO_MAX_LENGTH, 'Bio'),
    body('avatarUrl')
        .not().exists()
        .withMessage('Upload a photo with POST /api/users/me/avatar instead')
];

/**
 * A custom status emoji: a few pictographs, no letters, digits, spaces or markup characters
 */
function isStatusEmoji(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if ([...value].length > STATUS_EMOJI_MAX_CHARS) return false;
    if (/[\s\p{Cc}\p{L}\p{N}<>&"'`]/u.test(value)) return false;
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

/**
 * Validation rules for PUT /api/users/me/status Body: { text?, emoji?, duration? } (one of text/emoji)
 */
const validateCustomStatus = [
    profileTextRule('text', STATUS_TEXT_MAX_LENGTH, 'Status'),
    body('emoji')
        .optional({ values: 'falsy' })
        .custom(isStatusEmoji)
        .withMessage('Pick a single emoji for your status'),
    body('duration')
        .optional()
        .isIn(STATUS_DURATION_OPTIONS)
        .withMessage(`duration must be one of ${STATUS_DURATION_OPTIONS.join(', ')}`),
    body().custom((value, { req }) => {
        if (!req.body.text && !req.body.emoji) throw new Error('Add a status text or an emoji');
        return true;
    })
];

/**
 * Validation rules for PUT /api/users/me/privacy (send only what changes)
 */
const validatePrivacySettings = [
    body(['lastSeen', 'photo', 'bio', 'groups', 'birthday'])
        .optional()
        .isIn(AUDIENCES)
        .withMessage(`Audience must be one of ${AUDIENCES.join(', ')}`),
    body(['readReceipts', 'typingIndicators'])
        .optional()
        .isBoolean({ strict: true })
        .withMessage('Must be true or false')
];

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
    validateDisappearingTimer,
    validateCallHistoryQuery,
    checkUploadValidation,
    isWaveform,
    validateMessageIdParam,
    validateReaction,
    validateReactionRemoval,
    validateEditMessage,
    validateForward,
    validateStarredQuery,
    validateMessagesQuery,
    validateSearchQuery,
    validateSharedMediaQuery,
    validateCreateChat,
    validateMentionsOnly,
    validateChatIdParam,
    validateGroupSettings,
    validateCreateInvite,
    validateInviteIdParam,
    validateJoinRequestParam,
    validateMemberTag,
    validateLeaveGroup,
    validateInviteCode,
    validateRemoveMember,
    validateMemberRole,
    validateAddMember,
    validateChatUserParams,
    validateChangePassword,
    validateVerifyEmail,
    validateSessionIdParam,
    validateTwoFactorLogin,
    validateTwoFactorSetup,
    validateTwoFactorConfirm,
    validateReauthentication,
    validateChangeEmail,
    validateSecurityActivityQuery,
    validateExportIdParam,
    validateExportDownload,
    validateBlockUser,
    validateUserIdParam,
    validateReport,
    validateWarningIdParam,
    validateReportIdParam,
    validateEvidenceFileParams,
    validateAdminReportsQuery,
    validateAdminWarn,
    validateAdminSuspend,
    validateAdminSuspendUser,
    validateAdminUsersQuery,
    validateAuditQuery,
    validatePushSubscription,
    validatePushUnsubscribe,
    validateNotificationSettings,
    validateCreatePoll,
    validatePollIdParam,
    validatePollVote,
    validateScheduledIdParam,
    validateScheduledQuery,
    validateScheduleMessage,
    validateUpdateScheduled,
    validateCreateReminder,
    validateReminderIdParam,
    validateRemindersQuery,
    validateMessageStatus,
    validateProfileUpdate,
    validateCustomStatus,
    validatePrivacySettings,
    validateCreateEvent,
    validateEventIdParam,
    validateUpdateEvent,
    validateRsvp,
    validateEventsQuery,
    validateCreateList,
    validateListIdParam,
    validateRenameList,
    validateListsQuery,
    validateAddListItem,
    validateListItemIdParam,
    validateUpdateListItem,
    validateBirthday,
    validateBirthdaysQuery,
    isStatusEmoji,
    checkValidation,
    sanitizeHtml,
    validateFileType
};
