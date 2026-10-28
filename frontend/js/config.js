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
        // Auth
        REGISTER: '/auth/register',
        LOGIN: '/auth/login',
        LOGOUT: '/auth/logout',
        PROFILE: '/auth/profile',
        FORGOT_PASSWORD: '/auth/forgot-password',
        RESET_PASSWORD: '/auth/reset-password',
        
        // Chats
        CHATS: '/chats',
        CHAT_BY_ID: (id) => `/chats/${id}`,
        CREATE_CHAT: '/chats',
        ADD_MEMBER: (chatId) => `/chats/${chatId}/members`,
        REMOVE_MEMBER: (chatId, userId) => `/chats/${chatId}/members/${userId}`,
        SEARCH_USERS: '/chats/search/users',
        MARK_READ: (chatId) => `/chats/${chatId}/read`,
        MUTE_CHAT: (chatId) => `/chats/${chatId}/mute`,
        ARCHIVE_CHAT: (chatId) => `/chats/${chatId}/archive`,
        MENTIONS_ONLY: (chatId) => `/chats/${chatId}/mentions-only`,

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

        // Notifications
        PUSH_CONFIG: '/notifications/push-config',
        PUSH_SUBSCRIPTIONS: '/notifications/subscriptions',
        NOTIFICATION_SETTINGS: '/notifications/settings',
    },
    
    // Messages fetched per page when opening a chat or scrolling up
    MESSAGE_PAGE_SIZE: 30,

    // Mirrors EDIT_WINDOW_MINUTES / MAX_FORWARD_* in backend/config/messages.js (the server enforces them)
    MESSAGE_EDIT_WINDOW_MINUTES: 15,
    MAX_FORWARD_MESSAGES: 5,
    MAX_FORWARD_CHATS: 10,

    // Storage Keys
    STORAGE_KEYS: {
        AUTH_TOKEN: 'authToken',
        USER_DATA: 'userData',
        THEME: 'theme',
        CURRENT_CHAT: 'currentChat',
        ARCHIVED_EXPANDED: 'archivedExpanded'
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
