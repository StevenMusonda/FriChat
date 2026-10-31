/**
 * Configuration File
 * API endpoints and settings
 */

const CONFIG = {
    API_BASE_URL: 'http://localhost:3000/api',
    SOCKET_URL: 'http://localhost:3000',


    //uncomment for render
    //API_BASE_URL: 'https://frichat-vfr1.onrender.com/api',
    //SOCKET_URL: 'https://frichat-vfr1.onrender.com',
    
    // API Endpoints
    ENDPOINTS: {
        // 1:1 calls (calls.js)
        CALL_ICE_SERVERS: '/calls/ice-servers',
        CALLS: '/calls',
        // Auth
        REGISTER: '/auth/register',
        LOGIN: '/auth/login',
        LOGOUT: '/auth/logout',
        PROFILE: '/auth/profile',
        FORGOT_PASSWORD: '/auth/forgot-password',
        RESET_PASSWORD: '/auth/reset-password',
        REFRESH: '/auth/refresh',
        VERIFY_EMAIL: '/auth/verify-email',
        RESEND_VERIFICATION: '/auth/resend-verification',
        CHANGE_PASSWORD: '/auth/password',
        SESSIONS: '/auth/sessions',
        SESSION: (sessionId) => `/auth/sessions/${sessionId}`,
        REVOKE_OTHER_SESSIONS: '/auth/sessions/revoke-others',
        LOGIN_2FA: '/auth/login/2fa',
        CHANGE_EMAIL: '/auth/email',
        SECURITY_ACTIVITY: '/auth/security-activity',
        TWO_FACTOR: '/auth/2fa',
        TWO_FACTOR_SETUP: '/auth/2fa/setup',
        TWO_FACTOR_CONFIRM: '/auth/2fa/confirm',
        TWO_FACTOR_DISABLE: '/auth/2fa/disable',
        TWO_FACTOR_RECOVERY_CODES: '/auth/2fa/recovery-codes',

        // Data rights (phase 14)
        ACCOUNT_EXPORTS: '/account/exports',
        ACCOUNT_EXPORT_LINK: (exportId) => `/account/exports/${exportId}/link`,
        ACCOUNT_DELETE: '/account/delete',

        // Blocking
        BLOCKS: '/blocks',
        BLOCK: (userId) => `/blocks/${userId}`,
        
        // Chats
        CHATS: '/chats',
        CHAT_BY_ID: (id) => `/chats/${id}`,
        CREATE_CHAT: '/chats',
        ADD_MEMBER: (chatId) => `/chats/${chatId}/members`,
        REMOVE_MEMBER: (chatId, userId, ban = false) => `/chats/${chatId}/members/${userId}${ban ? '?ban=true' : ''}`,
        MEMBER_ROLE: (chatId, userId) => `/chats/${chatId}/members/${userId}/role`,
        GROUP_BANS: (chatId) => `/chats/${chatId}/bans`,
        GROUP_BAN: (chatId, userId) => `/chats/${chatId}/bans/${userId}`,
        SEARCH_USERS: '/chats/search/users',
        MARK_READ: (chatId) => `/chats/${chatId}/read`,
        MUTE_CHAT: (chatId) => `/chats/${chatId}/mute`,
        ARCHIVE_CHAT: (chatId) => `/chats/${chatId}/archive`,
        MENTIONS_ONLY: (chatId) => `/chats/${chatId}/mentions-only`,
        SHARED_MEDIA: (chatId) => `/chats/${chatId}/media`,
        DISAPPEARING: (chatId) => `/chats/${chatId}/disappearing`,

        // Groups
        GROUP_SETTINGS: (chatId) => `/chats/${chatId}/settings`,
        GROUP_AVATAR: (chatId) => `/chats/${chatId}/avatar`,
        GROUP_INVITES: (chatId) => `/chats/${chatId}/invites`,
        GROUP_INVITE: (chatId, inviteId) => `/chats/${chatId}/invites/${inviteId}`,
        JOIN_REQUESTS: (chatId) => `/chats/${chatId}/join-requests`,
        JOIN_REQUEST_DECISION: (chatId, requestId, decision) => `/chats/${chatId}/join-requests/${requestId}/${decision}`,
        MEMBER_TAG: (chatId, userId) => `/chats/${chatId}/members/${userId}/tag`,
        LEAVE_GROUP: (chatId) => `/chats/${chatId}/leave`,
        INVITE_PREVIEW: (code) => `/invites/${encodeURIComponent(code)}`,
        INVITE_JOIN: (code) => `/invites/${encodeURIComponent(code)}/join`,

        // Messages
        MESSAGES: (chatId) => `/messages/chat/${chatId}`,
        SEND_MESSAGE: '/messages',
        UPLOAD_FILE: '/messages/upload',
        UPDATE_STATUS: (messageId) => `/messages/${messageId}/status`,
        ADD_REACTION: (messageId) => `/messages/${messageId}/reactions`,
        REMOVE_REACTION: (messageId) => `/messages/${messageId}/reactions`,
        EDIT_MESSAGE: (messageId) => `/messages/${messageId}`,
        STAR_MESSAGE: (messageId) => `/messages/${messageId}/star`,
        STARRED_MESSAGES: '/messages/starred',
        FORWARD_MESSAGES: '/messages/forward',
        LINK_PREVIEW: (messageId) => `/messages/${messageId}/link-preview`,
        SEARCH_MESSAGES: '/messages/search',
        UPLOAD_LIMITS: '/messages/upload-limits',

        // Notifications
        PUSH_CONFIG: '/notifications/push-config',
        PUSH_SUBSCRIPTIONS: '/notifications/subscriptions',
        NOTIFICATION_SETTINGS: '/notifications/settings',

        // Polls, scheduled messages and reminders (phase 8)
        POLLS: '/polls',
        POLL: (pollId) => `/polls/${pollId}`,
        POLL_VOTES: (pollId) => `/polls/${pollId}/votes`,
        POLL_CLOSE: (pollId) => `/polls/${pollId}/close`,
        SCHEDULED_MESSAGES: '/scheduled-messages',
        SCHEDULED_MESSAGE: (id) => `/scheduled-messages/${id}`,
        REMINDERS: '/reminders',
        REMINDER: (id) => `/reminders/${id}`,

        // Profile, privacy and message requests (phase 9)
        ME: '/users/me',
        MY_PROFILE: '/users/me/profile',
        MY_AVATAR: '/users/me/avatar',
        MY_STATUS: '/users/me/status',
        MY_PRIVACY: '/users/me/privacy',
        USER_PROFILE: (userId) => `/users/${userId}`,
        MESSAGE_REQUEST: (chatId, action) => `/chats/${chatId}/request/${action}`,

        // Events, shared lists and birthdays (phase 12)
        EVENTS: '/events',
        EVENT: (eventId) => `/events/${eventId}`,
        EVENT_RSVP: (eventId) => `/events/${eventId}/rsvp`,
        EVENT_CANCEL: (eventId) => `/events/${eventId}/cancel`,
        EVENT_ICS: (eventId) => `/events/${eventId}/ics`,
        LISTS: '/lists',
        LIST: (listId) => `/lists/${listId}`,
        LIST_ITEMS: (listId) => `/lists/${listId}/items`,
        LIST_ITEM: (itemId) => `/lists/items/${itemId}`,
        MY_BIRTHDAY: '/users/me/birthday',
        CHAT_BIRTHDAYS: (chatId) => `/chats/${chatId}/birthdays`,

        // Reports and the admin console (phase 13)
        REPORTS: '/reports',
        REPORT_WARNINGS: '/reports/warnings',
        REPORT_WARNING_ACK: (warningId) => `/reports/warnings/${warningId}/acknowledge`,
        ADMIN_CONFIG: '/admin/config',
        ADMIN_REPORTS: '/admin/reports',
        ADMIN_REPORT: (reportId) => `/admin/reports/${reportId}`,
        ADMIN_REPORT_ACTION: (reportId, action) => `/admin/reports/${reportId}/${action}`,
        ADMIN_EVIDENCE_FILE: (reportId, evidenceId) => `/admin/reports/${reportId}/evidence/${evidenceId}/file`,
        ADMIN_USERS: '/admin/users',
        ADMIN_USER_ACTION: (userId, action) => `/admin/users/${userId}/${action}`,
        ADMIN_AUDIT: '/admin/audit',
    },
    
    // Messages fetched per page when opening a chat or scrolling up
    MESSAGE_PAGE_SIZE: 30,

    // Mirrors EDIT_WINDOW_MINUTES / MAX_FORWARD_* in backend/config/messages.js (the server enforces them)
    MESSAGE_EDIT_WINDOW_MINUTES: 15,
    MAX_FORWARD_MESSAGES: 5,
    MAX_FORWARD_CHATS: 10,

    // Files waiting in the composer's upload tray at once (each is its own upload request)
    MAX_TRAY_FILES: 10,

    // Voice notes (the server enforces the same limits: backend/config/messages.js)
    VOICE_MAX_SECONDS: 300,
    VOICE_WAVEFORM_BARS: 48,
    // Pressing the mic longer than this records while held; a shorter click starts a recording you send with a button
    VOICE_HOLD_MS: 300,

    // Disappearing messages timers in seconds (backend/config/messages.js DISAPPEARING_DURATIONS)
    DISAPPEARING_OPTIONS: [
        { seconds: 0, label: 'Off' },
        { seconds: 24 * 60 * 60, label: '24 hours' },
        { seconds: 7 * 24 * 60 * 60, label: '7 days' },
        { seconds: 90 * 24 * 60 * 60, label: '90 days' }
    ],

    // Search results and shared media items per request
    SEARCH_PAGE_SIZE: 20,
    MEDIA_PAGE_SIZE: 30,

    // Mirrors backend/config/scheduling.js (the server enforces them)
    POLL_MIN_OPTIONS: 2,
    POLL_MAX_OPTIONS: 12,
    POLL_QUESTION_MAX_LENGTH: 300,
    POLL_OPTION_MAX_LENGTH: 100,

    // Mirrors backend/config/planning.js (the server enforces them)
    EVENT_TITLE_MAX_LENGTH: 150,
    EVENT_DESCRIPTION_MAX_LENGTH: 2000,
    EVENT_LOCATION_MAX_LENGTH: 200,
    LIST_NAME_MAX_LENGTH: 100,
    LIST_ITEM_MAX_LENGTH: 300,

    // Calls (backend/config/calls.js RING_TIMEOUT_MS decides; this is only the page's safety net)
    CALL_RING_TIMEOUT_MS: 30 * 1000,
    // Waiting for the camera/microphone (an unanswered permission prompt) before giving up
    CALL_MEDIA_TIMEOUT_MS: 20 * 1000,
    // Waiting for the connection to come back after an ICE restart before ending the call
    CALL_RECONNECT_TIMEOUT_MS: 12 * 1000,
    CALLS_PAGE_SIZE: 30,

    // Storage Keys
    STORAGE_KEYS: {
        // Legacy: tokens are no longer stored; auth.js deletes this key if an old version left it
        AUTH_TOKEN: 'authToken',
        USER_DATA: 'userData',
        THEME: 'theme',
        CURRENT_CHAT: 'currentChat',
        ARCHIVED_EXPANDED: 'archivedExpanded',
        // '0' = Enter adds a new line and Shift+Enter sends (default: Enter sends)
        ENTER_TO_SEND: 'enterToSend',
        // Unsent composer text, per user and chat: draft:<userId>:<chatId>
        DRAFT_PREFIX: 'draft:',
        // Invite code to come back to after signing in (sessionStorage)
        PENDING_INVITE: 'pendingInvite',
        // Something to say once the app has opened after signing in (sessionStorage)
        ACCOUNT_NOTICE: 'accountNotice'
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
