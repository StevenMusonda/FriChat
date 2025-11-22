/**
 * Configuration File
 * API endpoints and settings
 */

const CONFIG = {
    API_BASE_URL: 'https://frichat-vfr1.onrender.com',
    SOCKET_URL: 'wss://frichat-vfr1.onrender.com/socket.io',
    
    // API Endpoints
    ENDPOINTS: {
        // Auth
        REGISTER: '/auth/register',
        LOGIN: '/auth/login',
        LOGOUT: '/auth/logout',
        PROFILE: '/auth/profile',
        
        // Chats
        CHATS: '/chats',
        CHAT_BY_ID: (id) => `/chats/${id}`,
        CREATE_CHAT: '/chats',
        ADD_MEMBER: (chatId) => `/chats/${chatId}/members`,
        REMOVE_MEMBER: (chatId, userId) => `/chats/${chatId}/members/${userId}`,
        SEARCH_USERS: '/chats/search/users',
        
        // Messages
        MESSAGES: (chatId) => `/messages/chat/${chatId}`,
        SEND_MESSAGE: '/messages',
        UPLOAD_FILE: '/messages/upload',
        UPDATE_STATUS: (messageId) => `/messages/${messageId}/status`,
        ADD_REACTION: (messageId) => `/messages/${messageId}/reactions`,
        REMOVE_REACTION: (messageId) => `/messages/${messageId}/reactions`,
    },
    
    // Storage Keys
    STORAGE_KEYS: {
        AUTH_TOKEN: 'authToken',
        USER_DATA: 'userData',
        THEME: 'theme',
        CURRENT_CHAT: 'currentChat'
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
