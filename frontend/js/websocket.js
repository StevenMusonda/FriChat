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
let readPositionHandlers = [];
let messagesReadHandlers = [];
let chatSettingsHandlers = [];
let notificationSettingsHandlers = [];
let messageEditedHandlers = [];
let starHandlers = [];
let messageDeletedHandlers = [];
let linkPreviewHandlers = [];
let socketErrorHandlers = [];
let groupEventHandlers = [];

// Group profile/settings, members, leaving and join requests (handled in groups.js)
const GROUP_EVENTS = ['group_updated', 'group_members_updated', 'group_left', 'join_request_created', 'join_requests_updated', 'join_request_decided'];

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
        // Server verifies this JWT on handshake (re-read on each reconnect)
        auth: (cb) => cb({ token: localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN) }),
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5
    });
    
    // Connection events
    socket.on('connect', () => {
        console.log('WebSocket connected');
        
        // Go online and join chat rooms (identity comes from the handshake token)
        socket.emit('authenticate');

        // The server pushes notifications only while no visible tab is watching
        sendPresence();
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

    // Read position changed (this tab or another tab of the same user)
    socket.on('read_position_updated', (data) => {
        readPositionHandlers.forEach(handler => handler(data));
    });

    // Someone in a chat read up to a message (drives read receipts)
    socket.on('messages_read', (data) => {
        messagesReadHandlers.forEach(handler => handler(data));
    });

    // Mute/archive changed in another tab
    socket.on('chat_settings_updated', (data) => {
        chatSettingsHandlers.forEach(handler => handler(data));
    });

    // Do-not-disturb changed in another tab
    socket.on('notification_settings_updated', (data) => {
        notificationSettingsHandlers.forEach(handler => handler(data));
    });

    // Someone in a chat edited a message
    socket.on('message_edited', (data) => {
        messageEditedHandlers.forEach(handler => handler(data));
    });

    // Star added/removed (this tab or another tab of the same user)
    socket.on('message_star_updated', (data) => {
        starHandlers.forEach(handler => handler(data));
    });

    // Someone in a chat deleted a message for everyone
    socket.on('message_deleted', (data) => {
        messageDeletedHandlers.forEach(handler => handler(data));
    });

    // A message's link preview arrived (server fetched it) or its sender removed it
    socket.on('message_link_preview', (data) => {
        linkPreviewHandlers.forEach(handler => handler(data));
    });

    GROUP_EVENTS.forEach((event) => {
        socket.on(event, (data) => {
            groupEventHandlers.forEach(handler => handler(event, data));
        });
    });

    // A request this socket made was refused (e.g. send_message: not a member, bad reply target)
    socket.on('error', (data) => {
        console.error('Socket error:', data);
        socketErrorHandlers.forEach(handler => handler(data || {}));
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
 * fileId: the id POST /messages/upload (without chatId) returned; the server never accepts file details
 */
function sendMessageViaSocket(chatId, messageType, content, fileId = null, replyToMessageId = null) {
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
        fileId: fileId,
        replyToMessageId: replyToMessageId
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
 * Move the read position for a chat forward to messageId
 */
function markReadViaSocket(chatId, messageId) {
    if (!socket) {
        console.error('WebSocket not initialized');
        return;
    }

    socket.emit('mark_read', {
        chatId: chatId,
        messageId: messageId
    });
}

/**
 * Tell the server whether this tab is on screen (hidden tabs still get push notifications)
 */
function sendPresence() {
    if (!socket) return;

    socket.emit('presence', {
        visible: !document.hidden
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
 * Register read position handler
 */
function onReadPosition(handler) {
    readPositionHandlers.push(handler);
}

/**
 * Register messages-read (receipt) handler
 */
function onMessagesRead(handler) {
    messagesReadHandlers.push(handler);
}

/**
 * Register mute/archive settings handler
 */
function onChatSettings(handler) {
    chatSettingsHandlers.push(handler);
}

/**
 * Register do-not-disturb settings handler
 */
function onNotificationSettings(handler) {
    notificationSettingsHandlers.push(handler);
}

/**
 * Register message edited handler
 */
function onMessageEdited(handler) {
    messageEditedHandlers.push(handler);
}

/**
 * Register star changed handler
 */
function onStarUpdate(handler) {
    starHandlers.push(handler);
}

/**
 * Register message deleted (for everyone) handler
 */
function onMessageDeleted(handler) {
    messageDeletedHandlers.push(handler);
}

/**
 * Register handler for errors the server reports on this socket
 */
function onLinkPreview(handler) {
    linkPreviewHandlers.push(handler);
}

function onSocketError(handler) {
    socketErrorHandlers.push(handler);
}

/**
 * Register handler(event, data) for the group events in GROUP_EVENTS
 */
function onGroupEvent(handler) {
    groupEventHandlers.push(handler);
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
        readPositionHandlers = [];
        messagesReadHandlers = [];
        chatSettingsHandlers = [];
        notificationSettingsHandlers = [];
        messageEditedHandlers = [];
        starHandlers = [];
        messageDeletedHandlers = [];
        socketErrorHandlers = [];
    }
}
