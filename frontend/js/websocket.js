/**
 * WebSocket Module
 * Handles real-time communication via Socket.IO
 */

let socket = null;
let messageHandlers = [];
let statusHandlers = [];
let reactionHandlers = [];
let typingHandlers = [];
let userStatusHandlers = [];

/**
 * Initialize WebSocket connection
 */
function initializeWebSocket() {
    if (socket && socket.connected) {
        return socket;
    }
    
    const user = getCurrentUser();
    if (!user) {
        console.error('No user data found');
        return null;
    }
    
    // Connect to Socket.IO server
    socket = io(CONFIG.SOCKET_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5
    });
    
    // Connection events
    socket.on('connect', () => {
        console.log('WebSocket connected');
        
        // Authenticate with server
        socket.emit('authenticate', {
            userId: user.userId
        });
    });
    
    socket.on('disconnect', () => {
        console.log('WebSocket disconnected');
    });
    
    socket.on('connect_error', (error) => {
        console.error('WebSocket connection error:', error);
    });
    
    // Message events
    socket.on('new_message', (message) => {
        console.log('New message received:', message);
        messageHandlers.forEach(handler => handler(message));
    });
    
    socket.on('message_status_update', (data) => {
        console.log('Message status updated:', data);
        statusHandlers.forEach(handler => handler(data));
    });
    
    // Reaction events
    socket.on('reaction_added', (data) => {
        console.log('Reaction added:', data);
        reactionHandlers.forEach(handler => handler(data, 'add'));
    });
    
    socket.on('reaction_removed', (data) => {
        console.log('Reaction removed:', data);
        reactionHandlers.forEach(handler => handler(data, 'remove'));
    });
    
    // Typing events
    socket.on('user_typing', (data) => {
        console.log('User typing:', data);
        typingHandlers.forEach(handler => handler(data));
    });
    
    // User status events
    socket.on('user_status', (data) => {
        console.log('User status changed:', data);
        userStatusHandlers.forEach(handler => handler(data));
    });
    
    return socket;
}

/**
 * Join a chat room
 */
function joinChat(chatId) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }
    
    const user = getCurrentUser();
    socket.emit('join_chat', {
        chatId: chatId,
        userId: user.userId
    });
}

/**
 * Send a message via WebSocket
 */
function sendMessageViaSocket(chatId, messageType, content, fileData = null) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }
    
    const user = getCurrentUser();
    socket.emit('send_message', {
        chatId: chatId,
        senderId: user.userId,
        messageType: messageType,
        content: content,
        fileData: fileData
    });
}

/**
 * Update message status
 */
function updateMessageStatusViaSocket(messageId, status) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }
    
    const user = getCurrentUser();
    socket.emit('message_status', {
        messageId: messageId,
        status: status,
        userId: user.userId
    });
}

/**
 * Add reaction to message
 */
function addReactionViaSocket(messageId, emoji) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }
    
    const user = getCurrentUser();
    socket.emit('add_reaction', {
        messageId: messageId,
        userId: user.userId,
        emoji: emoji
    });
}

/**
 * Remove reaction from message
 */
function removeReactionViaSocket(messageId, emoji) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }
    
    const user = getCurrentUser();
    socket.emit('remove_reaction', {
        messageId: messageId,
        userId: user.userId,
        emoji: emoji
    });
}

/**
 * Send typing indicator
 */
function sendTypingIndicator(chatId, isTyping) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }
    
    const user = getCurrentUser();
    socket.emit('typing', {
        chatId: chatId,
        userId: user.userId,
        username: user.username,
        isTyping: isTyping
    });
}

/**
 * Register message handler
 */
function onNewMessage(handler) {
    messageHandlers.push(handler);
}

/**
 * Register status update handler
 */
function onMessageStatus(handler) {
    statusHandlers.push(handler);
}

/**
 * Register reaction handler
 */
function onReaction(handler) {
    reactionHandlers.push(handler);
}

/**
 * Register typing handler
 */
function onTyping(handler) {
    typingHandlers.push(handler);
}

/**
 * Register user status handler
 */
function onUserStatus(handler) {
    userStatusHandlers.push(handler);
}

/**
 * Disconnect WebSocket
 */
function disconnectWebSocket() {
    if (socket) {
        socket.disconnect();
        socket = null;
        
        // Clear handlers
        messageHandlers = [];
        statusHandlers = [];
        reactionHandlers = [];
        typingHandlers = [];
        userStatusHandlers = [];
    }
}
