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
let accountEventHandlers = [];
let rateLimitHandlers = [];
let plannerEventHandlers = [];
let lifecycleEventHandlers = [];
let callEventHandlers = [];
let planEventHandlers = [];

// Group profile/settings, members, leaving and join requests (handled in groups.js)
const GROUP_EVENTS = ['group_updated', 'group_members_updated', 'group_left', 'join_request_created', 'join_requests_updated', 'join_request_decided'];
// Email verified, block list changed in another tab (security.js); profiles, privacy and
// message requests (profile.js)
const ACCOUNT_EVENTS = ['email_verified', 'block_updated', 'user_profile_updated', 'privacy_settings_updated', 'message_request_updated', 'account_warning'];
// Polls, scheduled messages and reminders (polls.js, planner.js)
const PLANNER_EVENTS = ['poll_updated', 'scheduled_message_updated', 'reminder_due', 'reminder_updated'];
// Voice notes played, disappearing messages timer changed, expired messages removed (voice.js, disappearing.js)
const LIFECYCLE_EVENTS = ['voice_note_played', 'chat_disappearing_updated', 'messages_expired'];
// 1:1 calls: ringing, answering, WebRTC signaling and the call log (calls.js)
const CALL_EVENTS = ['call_invite', 'call_ringing', 'call_accept', 'call_reject', 'call_busy', 'call_cancel', 'call_timeout',
    'call_offer', 'call_answer', 'call_ice_candidate', 'call_hangup', 'call_peer_reconnected', 'call_sync', 'call_error', 'call_log_updated'];

// Events and shared lists: new answers, reminders, list changes (events.js, lists.js)
const PLAN_EVENTS = ['event_updated', 'event_reminder', 'list_updated', 'list_deleted', 'list_item_due'];

// Handshake refusals the server sends (server.js io.use)
const EXPIRED_TOKEN_ERRORS = ['Invalid or expired token', 'Access token required'];
const MAX_AUTH_RECONNECTS = 3;
let authReconnects = 0;

/**
 * The access token expired (or the server dropped us): get a new one and connect again.
 * If the session itself is gone, auth.js signs the user out.
 */
async function reconnectWithFreshToken() {
    if (!socket || authReconnects >= MAX_AUTH_RECONNECTS) return;
    authReconnects++;
    const result = await refreshAccessToken();
    if (result.ok && socket) {
        socket.connect();
    } else if (result.network && socket) {
        setTimeout(() => { if (socket && !socket.connected) socket.connect(); }, 5000);
    }
}

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
        // Server verifies this access JWT and its session on every handshake (fresh one on each reconnect)
        auth: (cb) => { getAccessToken().then(token => cb({ token })).catch(() => cb({ token: null })); },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5
    });
    
    // Connection events
    socket.on('connect', () => {
        console.log('WebSocket connected');
        authReconnects = 0;
        
        // Go online and join chat rooms (identity comes from the handshake token)
        socket.emit('authenticate');

        // The server pushes notifications only while no visible tab is watching
        sendPresence();

        // A call in progress rebinds to this new socket; otherwise a ringing call is shown again (calls.js)
        callEventHandlers.forEach(handler => handler('connect', {}));
    });
    
    socket.on('disconnect', (reason) => {
        console.log('WebSocket disconnected');
        // The server closed this socket on purpose (e.g. this device was signed out): find out whether
        // the session still exists - refresh succeeds and reconnects, or the user is signed out
        if (reason === 'io server disconnect') reconnectWithFreshToken();
    });

    socket.on('connect_error', (error) => {
        console.error('WebSocket connection error:', error);
        const message = error && error.message;
        if (message === 'Session revoked') {
            handleSessionEnded('revoked');
        } else if (EXPIRED_TOKEN_ERRORS.includes(message)) {
            // A refused handshake isn't retried by Socket.IO itself
            reconnectWithFreshToken();
        }
    });

    // This device was signed out (Settings > Devices elsewhere, password change, token reuse)
    socket.on('session_revoked', (data) => {
        const reason = data && data.reason;
        const pageReasons = { reuse: 'security', suspended: 'suspended', deletion: 'deletion' };
        handleSessionEnded(pageReasons[reason] || 'revoked');
    });

    // An event was dropped because this socket or user sent too many
    socket.on('rate_limited', (data) => {
        rateLimitHandlers.forEach(handler => handler(data || {}));
    });

    ACCOUNT_EVENTS.forEach((event) => {
        socket.on(event, (data) => {
            accountEventHandlers.forEach(handler => handler(event, data || {}));
        });
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

    PLANNER_EVENTS.forEach((event) => {
        socket.on(event, (data) => {
            plannerEventHandlers.forEach(handler => handler(event, data || {}));
        });
    });

    LIFECYCLE_EVENTS.forEach((event) => {
        socket.on(event, (data) => {
            lifecycleEventHandlers.forEach(handler => handler(event, data || {}));
        });
    });

    CALL_EVENTS.forEach((event) => {
        socket.on(event, (data) => {
            callEventHandlers.forEach(handler => handler(event, data || {}));
        });
    });

    PLAN_EVENTS.forEach((event) => {
        socket.on(event, (data) => {
            planEventHandlers.forEach(handler => handler(event, data || {}));
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
 * Set this user's whole selection in a poll ([] takes the vote back); the server answers with poll_updated
 */
function votePollViaSocket(pollId, optionIds) {
    if (!socket || !socket.connected) return false;
    socket.emit('poll_vote', { pollId, optionIds });
    return true;
}

/**
 * This user played someone's voice note (the server tells the sender, if both share read receipts)
 */
function markVoicePlayedViaSocket(messageId) {
    if (!socket || !socket.connected) return false;
    socket.emit('voice_played', { messageId });
    return true;
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
 * Register handler(event, data) for the account events in ACCOUNT_EVENTS
 */
function onAccountEvent(handler) {
    accountEventHandlers.push(handler);
}

/**
 * Register handler(event, data) for the poll, scheduled-message and reminder events in PLANNER_EVENTS
 */
function onPlannerEvent(handler) {
    plannerEventHandlers.push(handler);
}

/**
 * Register handler(event, data) for the events in LIFECYCLE_EVENTS
 */
function onLifecycleEvent(handler) {
    lifecycleEventHandlers.push(handler);
}

/**
 * Register handler(event, data) for the events in CALL_EVENTS (and 'connect' after every (re)connect)
 */
function onCallEvent(handler) {
    callEventHandlers.push(handler);
}

/**
 * Send a call event (calls.js); false when the socket isn't connected
 */
function emitCallEvent(event, data) {
    if (!socket || !socket.connected) return false;
    socket.emit(event, data);
    return true;
}

/**
 * Register handler(event, data) for the events in PLAN_EVENTS
 */
function onPlanEvent(handler) {
    planEventHandlers.push(handler);
}

/**
 * Send an event answer or a list change (events.js, lists.js); false when the socket isn't
 * connected, so the caller uses the REST endpoint instead
 */
function emitPlanEvent(event, data) {
    if (!socket || !socket.connected) return false;
    socket.emit(event, data);
    return true;
}

/**
 * Register handler({ event, retryAfterMs, disconnected }) for rate-limited events
 */
function onRateLimited(handler) {
    rateLimitHandlers.push(handler);
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
        plannerEventHandlers = [];
        lifecycleEventHandlers = [];
        callEventHandlers = [];
        planEventHandlers = [];
    }
}
