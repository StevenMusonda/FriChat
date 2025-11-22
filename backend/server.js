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

// Import utilities
const { executeQuery, queryOne } = require('./config/database');
const { startScheduler } = require('./utils/scheduler');

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

// Serve uploaded files with CORS headers
app.use('/uploads', cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    credentials: true
}), express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);

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

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    /**
     * User authentication and online status
     */
    socket.on('authenticate', async (data) => {
        try {
            const { userId } = data;
            
            if (userId) {
                connectedUsers.set(userId, socket.id);
                socket.userId = userId;

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
            const { chatId, userId } = data;

            // Verify user is a member
            const membership = await queryOne(
                'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
                [chatId, userId]
            );

            if (membership) {
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
            const { chatId, senderId, messageType, content, fileData } = data;

            // Verify sender is a member
            const membership = await queryOne(
                'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
                [chatId, senderId]
            );

            if (!membership) {
                socket.emit('error', { message: 'Access denied' });
                return;
            }

            let fileId = null;

            // Handle file if present
            if (fileData) {
                const fileResult = await executeQuery(
                    'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [
                        fileData.originalName,
                        fileData.storedName,
                        fileData.fileType,
                        fileData.fileSize,
                        fileData.mimeType,
                        fileData.uploadPath,
                        senderId
                    ]
                );
                fileId = fileResult.insertId || fileResult[0]?.id;
            }

            // Insert message
            const result = await executeQuery(
                'INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, status) VALUES (?, ?, ?, ?, ?, ?)',
                [chatId, senderId, messageType, content, fileId, 'sent']
            );

            const messageId = result.insertId || result[0]?.id;

            // Update chat timestamp
            await executeQuery(
                'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [chatId]
            );

            // Get complete message data
            const message = await queryOne(`
                SELECT 
                    m.id,
                    m.chat_id,
                    m.sender_id,
                    u.username,
                    u.full_name,
                    u.avatar_url,
                    m.message_type,
                    m.content,
                    m.file_id,
                    f.original_name as file_name,
                    f.file_type,
                    f.file_size,
                    f.upload_path,
                    m.status,
                    m.created_at
                FROM messages m
                JOIN users u ON m.sender_id = u.id
                LEFT JOIN files f ON m.file_id = f.id
                WHERE m.id = ?
            `, [messageId]);

            // Broadcast to all users in the chat
            io.to(`chat_${chatId}`).emit('new_message', message);

        } catch (error) {
            console.error('Send message error:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    /**
     * Update message status (delivered/read)
     */
    socket.on('message_status', async (data) => {
        try {
            const { messageId, status, userId } = data;

            await executeQuery(
                'UPDATE messages SET status = ? WHERE id = ?',
                [status, messageId]
            );

            // Get chat ID to broadcast to room
            const message = await queryOne(
                'SELECT chat_id, sender_id FROM messages WHERE id = ?',
                [messageId]
            );

            if (message) {
                io.to(`chat_${message.chat_id}`).emit('message_status_update', {
                    messageId: messageId,
                    status: status,
                    userId: userId
                });
            }
        } catch (error) {
            console.error('Message status error:', error);
        }
    });

    /**
     * Add reaction to message
     */
    socket.on('add_reaction', async (data) => {
        try {
            const { messageId, userId, emoji } = data;

            // Add reaction
            await executeQuery(
                'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = ?',
                [messageId, userId, emoji, emoji]
            );

            // Get chat ID
            const message = await queryOne(
                'SELECT chat_id FROM messages WHERE id = ?',
                [messageId]
            );

            // Get user info
            const user = await queryOne(
                'SELECT username FROM users WHERE id = ?',
                [userId]
            );

            if (message) {
                io.to(`chat_${message.chat_id}`).emit('reaction_added', {
                    messageId: messageId,
                    userId: userId,
                    username: user.username,
                    emoji: emoji
                });
            }
        } catch (error) {
            console.error('Add reaction error:', error);
        }
    });

    /**
     * Remove reaction from message
     */
    socket.on('remove_reaction', async (data) => {
        try {
            const { messageId, userId, emoji } = data;

            await executeQuery(
                'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
                [messageId, userId, emoji]
            );

            // Get chat ID
            const message = await queryOne(
                'SELECT chat_id FROM messages WHERE id = ?',
                [messageId]
            );

            if (message) {
                io.to(`chat_${message.chat_id}`).emit('reaction_removed', {
                    messageId: messageId,
                    userId: userId,
                    emoji: emoji
                });
            }
        } catch (error) {
            console.error('Remove reaction error:', error);
        }
    });

    /**
     * Typing indicator
     */
    socket.on('typing', (data) => {
        const { chatId, userId, username, isTyping } = data;
        socket.to(`chat_${chatId}`).emit('user_typing', {
            chatId,
            userId,
            username,
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
