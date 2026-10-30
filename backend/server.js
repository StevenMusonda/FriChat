/**
 * FriChat Backend Server
 * Real-time chat application with WebSocket support
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chats');
const messageRoutes = require('./routes/messages');
const notificationRoutes = require('./routes/notifications');
const inviteRoutes = require('./routes/invites');
const blockRoutes = require('./routes/blocks');
const pollRoutes = require('./routes/polls');
const userRoutes = require('./routes/users');
const { scheduledRouter, remindersRouter } = require('./routes/schedule');
const callRoutes = require('./routes/calls');
const eventRoutes = require('./routes/events');
const listRoutes = require('./routes/lists');
const reportRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');

// Import utilities
const { executeQuery, queryOne, insertAndGetId } = require('./config/database');
const { startScheduler } = require('./utils/scheduler');
const { markChatRead, recordNewMessage, updateMessageStatus } = require('./utils/chatState');
const { notifyNewMessage } = require('./utils/push');
const { getMessageById, checkReplyTarget } = require('./utils/messageQueries');
const { cleanMessageText } = require('./utils/messageText');
const { claimUploadedFile, releaseUploadedFile, guardStaticPath, setUploadHeaders, nameDownloads } = require('./utils/uploads');
const { saveMentions } = require('./utils/mentions');
const { attachLinkPreview } = require('./utils/linkPreview');
const reactionRules = require('./utils/reactions');
const { checkCanPost } = require('./utils/groups');
const { verifyAccessToken, findSessionUser, touchSession, normalizeIp } = require('./utils/sessions');
const { getBlockRelations } = require('./utils/blocks');
const { createSocketRateLimiter, limitSocketEvents } = require('./utils/socketRateLimit');
const pollRules = require('./utils/polls');
const { emitPresence, typingIndicatorsEnabled } = require('./utils/privacy');
const { isAwaitingAcceptance } = require('./utils/messageRequests');
const { chatExpiresAtSql } = require('./utils/timeSql');
const { markVoicePlayed } = require('./utils/voiceNotes');
const { createCallManager } = require('./utils/calls');
const callPush = require('./utils/callPush');
const eventRules = require('./utils/events');
const listRules = require('./utils/lists');

// What clients may ask for; a file's real type comes from its upload record ('voice' = audio)
const MESSAGE_TYPES = ['text', 'image', 'video', 'file', 'voice'];

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Behind a reverse proxy (Render, nginx): TRUST_PROXY=1 (number of proxies) so req.ip, rate limits
// and the IPs shown under Settings > Devices are the client's, not the proxy's
if (process.env.TRUST_PROXY) {
    const hops = parseInt(process.env.TRUST_PROXY, 10);
    app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// Initialize Socket.IO
const io = socketIo(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make io available to routes
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Serve uploaded files with CORS headers; never anything that resolves outside the uploads folder.
// Media is shown; anything else is a download (.html or .svg included), see setUploadHeaders.
const UPLOADS_STATIC_ROOT = path.join(__dirname, 'uploads');
app.use('/uploads', cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    credentials: true
}), guardStaticPath(UPLOADS_STATIC_ROOT), nameDownloads, express.static(UPLOADS_STATIC_ROOT, {
    index: false,
    redirect: false,
    dotfiles: 'ignore',
    setHeaders: setUploadHeaders
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/blocks', blockRoutes);
app.use('/api/polls', pollRoutes);
app.use('/api/users', userRoutes);
app.use('/api/scheduled-messages', scheduledRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/calls', callRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/lists', listRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'FriChat server is running',
        timestamp: new Date().toISOString()
    });
});

// Socket.IO connection handling
const connectedUsers = new Map(); // userId -> socketId

// Token buckets for send_message, typing, reactions and joins (limits in config/socketLimits.js)
const socketLimiter = createSocketRateLimiter();
setInterval(socketLimiter.sweep, 60 * 1000).unref();

// 1:1 voice/video calls: signaling, ringing, busy/timeout and history (utils/calls.js)
const callManager = createCallManager({ io, push: callPush });

/**
 * Socket.IO's view of the client IP (X-Forwarded-For only when TRUST_PROXY is set)
 */
function socketIp(socket) {
    const forwarded = socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
    if (process.env.TRUST_PROXY && forwarded) return normalizeIp(String(forwarded).split(',')[0].trim());
    return normalizeIp(socket.handshake.address);
}

/**
 * Verify the access JWT on every handshake (first connect and each reconnect) - the socket's identity
 * comes from the token, never from client-supplied userId/senderId fields. The token's session must
 * still be active; revoking a session disconnects its sockets (room session_<id>).
 * Error messages are what the client acts on: 'Invalid or expired token' -> refresh and reconnect,
 * 'Session revoked' -> sign out.
 */
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Access token required'));
        }

        const decoded = verifyAccessToken(token);
        if (!decoded) {
            return next(new Error('Invalid or expired token'));
        }

        const user = await findSessionUser(decoded.userId, decoded.sid);
        if (!user) {
            return next(new Error('Session revoked'));
        }

        socket.userId = user.id;
        socket.username = user.username;
        socket.sessionId = decoded.sid;
        touchSession(decoded.sid, socketIp(socket));
        next();
    } catch (error) {
        next(new Error('Invalid or expired token'));
    }
});

/**
 * Rooms of the users who must not see this user's presence or typing:
 * people they blocked (presence and typing) plus, for typing, people who blocked them
 */
async function hiddenFromRooms(userId, { includeBlockers = false } = {}) {
    const { blocked, blockedBy } = await getBlockRelations(userId);
    const ids = includeBlockers ? [...blocked, ...blockedBy] : blocked;
    return ids.map(id => `user_${id}`);
}

/**
 * Send this socket's user status to the people their "Last seen and online" setting allows
 * (everyone / contacts / nobody), never to people they blocked
 */
async function broadcastStatus(socket, status) {
    await emitPresence(io, socket.userId, status, socket);
}

/**
 * Check that a user belongs to a chat
 */
async function isChatMember(chatId, userId) {
    const membership = await queryOne(
        'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
        [chatId, userId]
    );
    return !!membership;
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Every tab of this user joins one room, so read/mute/archive changes reach all of them
    socket.join(`user_${socket.userId}`);

    // One room per signed-in device, so revoking that session disconnects exactly its sockets
    if (socket.sessionId) socket.join(`session_${socket.sessionId}`);

    // Rate-limited events are registered through this (dropped + `rate_limited` when over the limit)
    const onLimited = limitSocketEvents(socket, socketLimiter);

    // Until the tab reports otherwise it counts as visible (no push while it might be on screen)
    socket.data.visible = true;

    /**
     * Tab visibility, so pushes go out while the tab is hidden. Only describes this socket.
     */
    socket.on('presence', (data) => {
        socket.data.visible = !(data && data.visible === false);
    });

    /**
     * User authentication and online status
     */
    onLimited('authenticate', async () => {
        try {
            const userId = socket.userId;

            if (userId) {
                connectedUsers.set(userId, socket.id);

                // Update user status to online
                await executeQuery(
                    'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
                    ['online', userId]
                );

                // Join user to their chat rooms
                const userChats = await executeQuery(
                    'SELECT chat_id FROM group_members WHERE user_id = ?',
                    [userId]
                );

                userChats.forEach(chat => {
                    socket.join(`chat_${chat.chat_id}`);
                });

                // Broadcast user online status (not to people this user blocked)
                await broadcastStatus(socket, 'online');

                console.log(`User ${userId} authenticated and joined chats`);
            }
        } catch (error) {
            console.error('Authentication error:', error);
        }
    });

    /**
     * Join a specific chat room
     */
    onLimited('join_chat', async (data) => {
        try {
            const { chatId } = data;
            const userId = socket.userId;

            // Verify user is a member
            if (await isChatMember(chatId, userId)) {
                socket.join(`chat_${chatId}`);
                console.log(`User ${userId} joined chat ${chatId}`);
            }
        } catch (error) {
            console.error('Join chat error:', error);
        }
    });

    /**
     * Send message in real-time
     */
    onLimited('send_message', async (data) => {
        try {
            data = data || {};
            const { chatId } = data;
            let { messageType } = data;
            const senderId = socket.userId;

            if (!MESSAGE_TYPES.includes(messageType)) {
                socket.emit('error', { event: 'send_message', message: 'Invalid message type' });
                return;
            }

            // Files are referenced only by the id POST /api/messages/upload returned; no client-side file records
            if (data.fileData !== undefined && data.fileData !== null) {
                socket.emit('error', { event: 'send_message', message: 'Attach files by fileId from the upload endpoint' });
                return;
            }
            const hasFile = data.fileId !== undefined && data.fileId !== null;
            if (!hasFile && messageType !== 'text') {
                socket.emit('error', { event: 'send_message', message: 'A file is required for this message type' });
                return;
            }

            // Stored raw (clients escape on render), same rule as every other send path
            const cleaned = cleanMessageText(data.content, { required: !hasFile });
            if (!cleaned.ok) {
                socket.emit('error', { event: 'send_message', message: cleaned.error });
                return;
            }
            const content = cleaned.text;

            // Optional quote; must be a positive integer id in this same chat
            let replyToMessageId = null;
            if (data.replyToMessageId !== undefined && data.replyToMessageId !== null) {
                replyToMessageId = Number(data.replyToMessageId);
                if (!Number.isInteger(replyToMessageId) || replyToMessageId < 1) {
                    socket.emit('error', { event: 'send_message', message: 'Invalid reply target' });
                    return;
                }
            }

            // Verify sender is a member, and an admin if the group is announcement-only
            const postError = await checkCanPost(chatId, senderId);
            if (postError) {
                socket.emit('error', postError.code === 'NOT_A_MEMBER'
                    ? { event: 'send_message', message: 'Access denied' }
                    : { event: 'send_message', message: postError.message, code: postError.code });
                return;
            }

            if (replyToMessageId) {
                const replyError = await checkReplyTarget(chatId, replyToMessageId);
                if (replyError) {
                    socket.emit('error', { event: 'send_message', message: replyError });
                    return;
                }
            }

            // Claimed last, so a send that fails a check above leaves the upload usable
            let fileId = null;
            if (hasFile) {
                const claim = await claimUploadedFile(data.fileId, senderId);
                if (claim.error) {
                    socket.emit('error', { event: 'send_message', message: claim.error });
                    return;
                }
                fileId = claim.file.id;
                messageType = claim.file.messageType; // from the server's upload record, not the client
            }

            // Insert message
            let messageId;
            try {
                // expires_at follows the chat's disappearing-messages timer
                messageId = await insertAndGetId(
                    `INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, reply_to_message_id, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${chatExpiresAtSql()})`,
                    [chatId, senderId, messageType, content, fileId, replyToMessageId, 'sent', chatId]
                );
            } catch (error) {
                if (fileId) await releaseUploadedFile(fileId);
                throw error;
            }

            // @mentions of group members (before reading the message back, so it carries them)
            await saveMentions(chatId, messageId, senderId, content);

            // Update chat timestamp
            await executeQuery(
                'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [chatId]
            );

            // Un-archive for members who haven't muted it; sender has now read up to here
            await recordNewMessage(io, chatId, senderId, messageId);

            // Get complete message data (with the quoted original for replies)
            const message = await getMessageById(messageId);

            if (!message) {
                console.error('Failed to retrieve message after insert:', messageId);
                socket.emit('error', { event: 'send_message', message: 'Message created but could not be retrieved' });
                return;
            }

            // Broadcast to all users in the chat
            io.to(`chat_${chatId}`).emit('new_message', message);

            // Push to members who aren't watching (not awaited - never delays or fails the send)
            notifyNewMessage(io, message);

            // Preview card for the first link, broadcast as message_link_preview when ready (not awaited)
            attachLinkPreview(io, message);

        } catch (error) {
            console.error('Send message error:', error);
            socket.emit('error', { event: 'send_message', message: 'Failed to send message' });
        }
    });

    /**
     * Move this user's read position forward (sent while a chat is open and scrolled to new messages)
     */
    socket.on('mark_read', async (data) => {
        try {
            const chatId = parseInt(data && data.chatId);
            const messageId = parseInt(data && data.messageId) || null;
            if (!chatId) return;

            await markChatRead(io, chatId, socket.userId, messageId);
        } catch (error) {
            console.error('Mark read error:', error);
        }
    });

    /**
     * Update message status (delivered/read). Members only, other people's messages only, forwards
     * only; 'read' is stored and sent only when this user shares read receipts in the chat.
     */
    onLimited('message_status', async (data) => {
        try {
            const messageId = parseInt(data && data.messageId);
            if (!messageId) return;
            await updateMessageStatus(io, messageId, socket.userId, data.status);
        } catch (error) {
            console.error('Message status error:', error);
        }
    });

    /**
     * React to a message: adds, replaces this user's other emoji, or removes the same emoji (toggle)
     */
    onLimited('add_reaction', async (data) => {
        try {
            const result = await reactionRules.toggleReaction(data && data.messageId, socket.userId, data && data.emoji);
            if (result.error) {
                socket.emit('error', { event: 'add_reaction', message: result.error });
                return;
            }
            reactionRules.broadcastReaction(io, result, socket.username);
        } catch (error) {
            console.error('Add reaction error:', error);
            socket.emit('error', { event: 'add_reaction', message: 'Failed to add reaction' });
        }
    });

    /**
     * Remove this user's reaction from a message
     */
    onLimited('remove_reaction', async (data) => {
        try {
            const result = await reactionRules.removeReaction(data && data.messageId, socket.userId, data && data.emoji);
            if (result.error) {
                socket.emit('error', { event: 'remove_reaction', message: result.error });
                return;
            }
            reactionRules.broadcastReaction(io, result);
        } catch (error) {
            console.error('Remove reaction error:', error);
            socket.emit('error', { event: 'remove_reaction', message: 'Failed to remove reaction' });
        }
    });

    /**
     * Vote in a poll: optionIds is the user's whole selection ([] takes the vote back), so a repeated
     * event changes nothing. setVotes checks membership, closed polls and the single-choice rule,
     * and the database's unique keys hold the rule even if events race.
     */
    onLimited('poll_vote', async (data) => {
        try {
            const result = await pollRules.setVotes(io, socket.userId, data && data.pollId, data && data.optionIds);
            if (result.error) {
                socket.emit('error', { event: 'poll_vote', message: result.error.message, pollId: data && data.pollId });
            }
        } catch (error) {
            console.error('Poll vote error:', error);
            socket.emit('error', { event: 'poll_vote', message: 'Failed to save your vote' });
        }
    });

    /**
     * Answer an event: response 'going' | 'maybe' | 'declined', or null to take it back. setRsvp
     * checks membership and that the event is still on; the (event, user) primary key keeps one answer
     * per member however events race. The chat gets event_updated with the new counts and names.
     */
    onLimited('event_rsvp', async (data) => {
        try {
            const response = data && data.response !== undefined ? data.response : undefined;
            const result = response === undefined
                ? { error: { message: 'Answer going, maybe or declined' } }
                : await eventRules.setRsvp(io, socket.userId, data.eventId, response);
            if (result.error) {
                socket.emit('error', { event: 'event_rsvp', message: result.error.message, eventId: data && data.eventId });
            }
        } catch (error) {
            console.error('Event RSVP error:', error);
            socket.emit('error', { event: 'event_rsvp', message: 'Failed to save your answer' });
        }
    });

    /**
     * Shared lists: add, edit/tick and remove items. Each function checks that this user is a member
     * of the list's chat and the item's rules; the chat gets the whole list back (list_updated).
     */
    const listSocketEvents = {
        list_item_add: (data) => listRules.addItem(io, socket.userId, data.listId, { text: data.text, dueAt: data.dueAt }),
        list_item_update: (data) => listRules.updateItem(io, socket.userId, data.itemId, { text: data.text, dueAt: data.dueAt, done: data.done }),
        list_item_remove: (data) => listRules.removeItem(io, socket.userId, data.itemId)
    };
    for (const [eventName, run] of Object.entries(listSocketEvents)) {
        onLimited(eventName, async (data) => {
            try {
                if (!data || typeof data !== 'object') {
                    socket.emit('error', { event: eventName, message: 'Invalid request' });
                    return;
                }
                const result = await run(data);
                if (result.error) {
                    socket.emit('error', { event: eventName, message: result.error.message, listId: data.listId, itemId: data.itemId });
                }
            } catch (error) {
                console.error(`List event ${eventName} error:`, error);
                socket.emit('error', { event: eventName, message: 'Failed to update the list' });
            }
        });
    }

    /**
     * A voice note was played. markVoicePlayed checks membership and the message type, and tells the
     * sender (voice_note_played) only the first time and only when both share read receipts.
     */
    onLimited('voice_played', async (data) => {
        try {
            const result = await markVoicePlayed(io, data && data.messageId, socket.userId);
            if (result.error) {
                socket.emit('error', { event: 'voice_played', message: result.error });
            }
        } catch (error) {
            console.error('Voice played error:', error);
        }
    });

    /**
     * Calls: call_invite, call_accept, call_reject, call_cancel, call_offer, call_answer,
     * call_ice_candidate, call_hangup and call_sync. Each handler checks that this socket's user is
     * the caller or callee (invites: both share the direct chat, no block, request accepted).
     */
    callManager.register(socket, onLimited);

    /**
     * Typing indicator
     */
    onLimited('typing', async (data) => {
        try {
            const { chatId, isTyping } = data || {};

            // Only members (who were joined to the room) can broadcast typing
            if (!socket.rooms.has(`chat_${chatId}`)) {
                return;
            }

            // Typing indicators switched off, or a message request not accepted yet: nothing goes out
            if (!(await typingIndicatorsEnabled(socket.userId)) || (await isAwaitingAcceptance(chatId, socket.userId))) {
                return;
            }

            // Not shown to anyone on either side of a block
            const hidden = await hiddenFromRooms(socket.userId, { includeBlockers: true });
            let target = socket.to(`chat_${chatId}`);
            if (hidden.length > 0) target = target.except(hidden);

            target.emit('user_typing', {
                chatId,
                userId: socket.userId,
                username: socket.username,
                isTyping: !!isTyping
            });
        } catch (error) {
            console.error('Typing error:', error);
        }
    });

    /**
     * Disconnect handling
     */
    socket.on('disconnect', async () => {
        console.log('Client disconnected:', socket.id);

        try {
            if (socket.userId) {
                connectedUsers.delete(socket.userId);

                // Update user status to offline
                await executeQuery(
                    'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
                    ['offline', socket.userId]
                );

                // Broadcast user offline status
                await broadcastStatus(socket, 'offline');
            }
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║         FriChat Server Started        ║
╠═══════════════════════════════════════╣
║  Port: ${PORT}                         ║
║  Environment: ${process.env.NODE_ENV || 'development'}          ║
║  Database: ${process.env.DB_TYPE || 'mysql'}                  ║
╚═══════════════════════════════════════╝
    `);
    
    // Pins, auth cleanup, scheduled messages, reminders and timed poll closing
    startScheduler(io);
});

module.exports = { app, io };
