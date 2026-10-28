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
const jwt = require('jsonwebtoken');

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chats');
const messageRoutes = require('./routes/messages');
const notificationRoutes = require('./routes/notifications');

// Import utilities
const { executeQuery, queryOne, insertAndGetId } = require('./config/database');
const { startScheduler } = require('./utils/scheduler');
const { markChatRead, recordNewMessage } = require('./utils/chatState');
const { notifyNewMessage } = require('./utils/push');
const { getMessageById, checkReplyTarget } = require('./utils/messageQueries');
const { cleanMessageText } = require('./utils/messageText');
const { claimUploadedFile, releaseUploadedFile, guardStaticPath } = require('./utils/uploads');
const { saveMentions } = require('./utils/mentions');
const { attachLinkPreview } = require('./utils/linkPreview');
const reactionRules = require('./utils/reactions');

const MESSAGE_TYPES = ['text', 'image', 'video', 'file'];

// Initialize Express app
const app = express();
const server = http.createServer(app);

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

// Serve uploaded files with CORS headers; never anything that resolves outside the uploads folder
const UPLOADS_STATIC_ROOT = path.join(__dirname, 'uploads');
app.use('/uploads', cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    credentials: true
}), guardStaticPath(UPLOADS_STATIC_ROOT), express.static(UPLOADS_STATIC_ROOT));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);

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

/**
 * Verify JWT on handshake - the socket's identity comes from the token,
 * never from client-supplied userId/senderId fields
 */
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Access token required'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await queryOne(
            'SELECT id, username FROM users WHERE id = ?',
            [decoded.userId]
        );

        if (!user) {
            return next(new Error('User not found'));
        }

        socket.userId = user.id;
        socket.username = user.username;
        next();
    } catch (error) {
        next(new Error('Invalid or expired token'));
    }
});

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
    socket.on('authenticate', async () => {
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

                // Broadcast user online status
                socket.broadcast.emit('user_status', {
                    userId: userId,
                    status: 'online'
                });

                console.log(`User ${userId} authenticated and joined chats`);
            }
        } catch (error) {
            console.error('Authentication error:', error);
        }
    });

    /**
     * Join a specific chat room
     */
    socket.on('join_chat', async (data) => {
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
    socket.on('send_message', async (data) => {
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

            // Verify sender is a member
            if (!(await isChatMember(chatId, senderId))) {
                socket.emit('error', { event: 'send_message', message: 'Access denied' });
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
                messageId = await insertAndGetId(
                    'INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, reply_to_message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [chatId, senderId, messageType, content, fileId, replyToMessageId, 'sent']
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
     * Update message status (delivered/read)
     */
    socket.on('message_status', async (data) => {
        try {
            const { messageId, status } = data;
            const userId = socket.userId;

            // Get chat ID and verify the user can see this message
            const message = await queryOne(
                'SELECT chat_id, sender_id FROM messages WHERE id = ?',
                [messageId]
            );

            if (!message || !(await isChatMember(message.chat_id, userId))) {
                return;
            }

            await executeQuery(
                'UPDATE messages SET status = ? WHERE id = ?',
                [status, messageId]
            );

            io.to(`chat_${message.chat_id}`).emit('message_status_update', {
                messageId: messageId,
                status: status,
                userId: userId
            });
        } catch (error) {
            console.error('Message status error:', error);
        }
    });

    /**
     * React to a message: adds, replaces this user's other emoji, or removes the same emoji (toggle)
     */
    socket.on('add_reaction', async (data) => {
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
    socket.on('remove_reaction', async (data) => {
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
     * Typing indicator
     */
    socket.on('typing', (data) => {
        const { chatId, isTyping } = data;

        // Only members (who were joined to the room) can broadcast typing
        if (!socket.rooms.has(`chat_${chatId}`)) {
            return;
        }

        socket.to(`chat_${chatId}`).emit('user_typing', {
            chatId,
            userId: socket.userId,
            username: socket.username,
            isTyping
        });
    });

    /**
     * Disconnect handling
     */
    socket.on('disconnect', async () => {
        console.log('Client disconnected:', socket.id);

        if (socket.userId) {
            connectedUsers.delete(socket.userId);

            // Update user status to offline
            await executeQuery(
                'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
                ['offline', socket.userId]
            );

            // Broadcast user offline status
            socket.broadcast.emit('user_status', {
                userId: socket.userId,
                status: 'offline'
            });
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
    
    // Start the message pin scheduler
    startScheduler();
});

module.exports = { app, io };
