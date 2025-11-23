/**
 * Message Controller
 * Handles message retrieval, sending, and reactions
 */

const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');
const path = require('path');

/**
 * Get messages for a chat
 */
async function getMessages(req, res) {
    try {
        const { chatId } = req.params;
        const userId = req.user.id;
        const { limit = 50, offset = 0 } = req.query;

        // Check if user is a member of this chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Get messages (exclude deleted messages)
        const messages = await executeQuery(`
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
                m.created_at,
                m.deleted_at,
                m.deleted_for_everyone,
                CASE 
                    WHEN m.deleted_for_everyone = TRUE THEN TRUE
                    WHEN dm.id IS NOT NULL THEN TRUE
                    ELSE FALSE
                END as is_deleted
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            LEFT JOIN files f ON m.file_id = f.id
            LEFT JOIN deleted_messages dm ON m.id = dm.message_id AND dm.user_id = ?
            WHERE m.chat_id = ?
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
        `, [userId, chatId, parseInt(limit), parseInt(offset)]);

        // Get reactions for each message
        for (let message of messages) {
            const reactions = await executeQuery(`
                SELECT 
                    mr.user_id as userId,
                    ru.username,
                    mr.emoji
                FROM message_reactions mr
                JOIN users ru ON mr.user_id = ru.id
                WHERE mr.message_id = ?
            `, [message.id]);
            
            message.reactions = reactions.length > 0 ? JSON.stringify(reactions) : null;
        }

        res.json({
            success: true,
            data: messages.reverse() // Reverse to show oldest first
        });
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve messages',
            error: error.message
        });
    }
}

/**
 * Send a text message
 */
async function sendMessage(req, res) {
    try {
        const { chatId, content, messageType = 'text' } = req.body;
        const userId = req.user.id;

        // Check if user is a member of this chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Insert message
        const result = await executeQuery(
            'INSERT INTO messages (chat_id, sender_id, message_type, content, status) VALUES (?, ?, ?, ?, ?)',
            [chatId, userId, messageType, sanitizeHtml(content), 'sent']
        );

        const messageId = result.insertId || result[0]?.id;

        // Update chat updated_at
        await executeQuery(
            'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [chatId]
        );

        // Get the created message
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
                m.status,
                m.created_at
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.id = ?
        `, [messageId]);

        res.status(201).json({
            success: true,
            message: 'Message sent successfully',
            data: message
        });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message
        });
    }
}

/**
 * Upload and send a file/image/video message
 */
async function uploadFile(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const { chatId } = req.body;
        const userId = req.user.id;

        // Check if user is a member of this chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Determine message type based on file mimetype
        let messageType = 'file';
        if (req.file.mimetype.startsWith('image/')) {
            messageType = 'image';
        } else if (req.file.mimetype.startsWith('video/')) {
            messageType = 'video';
        }

        // Save file metadata to database
        let fileId;
        if (process.env.DB_TYPE === 'postgresql') {
            const fileResult = await executeQuery(
                'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
                [
                    req.file.originalname,
                    req.file.filename,
                    path.extname(req.file.originalname),
                    req.file.size,
                    req.file.mimetype,
                    req.file.path,
                    userId
                ]
            );
            fileId = fileResult[0]?.id;
        } else {
            const fileResult = await executeQuery(
                'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    req.file.originalname,
                    req.file.filename,
                    path.extname(req.file.originalname),
                    req.file.size,
                    req.file.mimetype,
                    req.file.path,
                    userId
                ]
            );
            fileId = fileResult.insertId;
        }

        // Create message with file reference
        let messageId;
        if (process.env.DB_TYPE === 'postgresql') {
            const messageResult = await executeQuery(
                'INSERT INTO messages (chat_id, sender_id, message_type, file_id, status) VALUES (?, ?, ?, ?, ?) RETURNING id',
                [chatId, userId, messageType, fileId, 'sent']
            );
            messageId = messageResult[0]?.id;
        } else {
            const messageResult = await executeQuery(
                'INSERT INTO messages (chat_id, sender_id, message_type, file_id, status) VALUES (?, ?, ?, ?, ?)',
                [chatId, userId, messageType, fileId, 'sent']
            );
            messageId = messageResult.insertId;
        }

        // Update chat updated_at
        await executeQuery(
            'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [chatId]
        );

        // Get the created message
        const message = await queryOne(`
            SELECT 
                m.id,
                m.chat_id,
                m.sender_id,
                u.username,
                u.full_name,
                u.avatar_url,
                m.message_type,
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

        // Emit message via WebSocket to all chat members
        if (req.io && message) {
            req.io.to(`chat_${chatId}`).emit('new_message', message);
        }

        res.status(201).json({
            success: true,
            message: 'File uploaded successfully',
            data: message
        });
    } catch (error) {
        console.error('Upload file error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload file',
            error: error.message
        });
    }
}

/**
 * Update message status (delivered/read)
 */
async function updateMessageStatus(req, res) {
    try {
        const { messageId } = req.params;
        const { status } = req.body;
        const userId = req.user.id;

        // Verify message exists and user has access
        const message = await queryOne(`
            SELECT m.id, m.chat_id
            FROM messages m
            JOIN group_members gm ON m.chat_id = gm.chat_id
            WHERE m.id = ? AND gm.user_id = ?
        `, [messageId, userId]);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or access denied'
            });
        }

        // Update status
        await executeQuery(
            'UPDATE messages SET status = ? WHERE id = ?',
            [status, messageId]
        );

        res.json({
            success: true,
            message: 'Message status updated'
        });
    } catch (error) {
        console.error('Update message status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update message status',
            error: error.message
        });
    }
}

/**
 * Add reaction to a message
 */
async function addReaction(req, res) {
    try {
        const { messageId } = req.params;
        const { emoji } = req.body;
        const userId = req.user.id;

        // Verify message exists and user has access
        const message = await queryOne(`
            SELECT m.id, m.chat_id
            FROM messages m
            JOIN group_members gm ON m.chat_id = gm.chat_id
            WHERE m.id = ? AND gm.user_id = ?
        `, [messageId, userId]);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or access denied'
            });
        }

        // Add or update reaction (PostgreSQL compatible)
        if (process.env.DB_TYPE === 'postgresql') {
            await executeQuery(
                'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT (message_id, user_id, emoji) DO UPDATE SET emoji = ?',
                [messageId, userId, emoji, emoji]
            );
        } else {
            await executeQuery(
                'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = ?',
                [messageId, userId, emoji, emoji]
            );
        }

        res.json({
            success: true,
            message: 'Reaction added successfully'
        });
    } catch (error) {
        console.error('Add reaction error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add reaction',
            error: error.message
        });
    }
}

/**
 * Remove reaction from a message
 */
async function removeReaction(req, res) {
    try {
        const { messageId } = req.params;
        const { emoji } = req.body;
        const userId = req.user.id;

        await executeQuery(
            'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
            [messageId, userId, emoji]
        );

        res.json({
            success: true,
            message: 'Reaction removed successfully'
        });
    } catch (error) {
        console.error('Remove reaction error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove reaction',
            error: error.message
        });
    }
}

/**
 * Delete message (for everyone if within 1 minute, otherwise for self only)
 */
async function deleteMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        // Get message details
        const message = await queryOne(
            'SELECT * FROM messages WHERE id = ?',
            [messageId]
        );

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        // Check if user is the sender
        if (message.sender_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You can only delete your own messages'
            });
        }

        // Calculate time difference
        const messageTime = new Date(message.created_at);
        const currentTime = new Date();
        const timeDiff = (currentTime - messageTime) / 1000; // in seconds

        // If within 60 seconds, delete for everyone
        if (timeDiff <= 60) {
            await executeQuery(
                'UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, deleted_for_everyone = TRUE WHERE id = ?',
                [userId, messageId]
            );

            return res.json({
                success: true,
                message: 'Message deleted for everyone',
                deletedForEveryone: true
            });
        }

        // Otherwise, delete for self only
        if (process.env.DB_TYPE === 'postgresql') {
            await executeQuery(
                'INSERT INTO deleted_messages (message_id, user_id) VALUES (?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET deleted_at = CURRENT_TIMESTAMP',
                [messageId, userId]
            );
        } else {
            await executeQuery(
                'INSERT INTO deleted_messages (message_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at = CURRENT_TIMESTAMP',
                [messageId, userId]
            );
        }

        res.json({
            success: true,
            message: 'Message deleted for you',
            deletedForEveryone: false
        });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete message',
            error: error.message
        });
    }
}

/**
 * Pin a message
 */
async function pinMessage(req, res) {
    try {
        const { messageId } = req.params;
        const { duration } = req.body; // '24h', '7d', '30d'
        const userId = req.user.id;

        console.log('Pin message request:', { messageId, duration, userId });

        // Get message details
        const message = await queryOne(
            'SELECT chat_id FROM messages WHERE id = ?',
            [messageId]
        );

        if (!message) {
            console.log('Message not found:', messageId);
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        console.log('Message found, chat_id:', message.chat_id);

        // Check if user is a member of the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [message.chat_id, userId]
        );

        if (!membership) {
            console.log('User not member of chat');
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Calculate pinned_until based on duration
        let hours = 24; // default 24 hours
        if (duration === '7d') hours = 24 * 7;
        else if (duration === '30d') hours = 24 * 30;

        const pinnedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
        console.log('Pinned until:', pinnedUntil);

        // Check if message is already pinned
        const existingPin = await queryOne(
            'SELECT id FROM pinned_messages WHERE message_id = ?',
            [messageId]
        );

        if (existingPin) {
            console.log('Updating existing pin');
            // Update existing pin
            await executeQuery(
                'UPDATE pinned_messages SET pinned_by = ?, pinned_until = ?, created_at = CURRENT_TIMESTAMP WHERE message_id = ?',
                [userId, pinnedUntil, messageId]
            );
        } else {
            console.log('Creating new pin');
            // Create new pin
            await executeQuery(
                'INSERT INTO pinned_messages (message_id, chat_id, pinned_by, pinned_until) VALUES (?, ?, ?, ?)',
                [messageId, message.chat_id, userId, pinnedUntil]
            );
        }

        // Get pinned message details
        const pinnedMessage = await queryOne(`
            SELECT 
                pm.*,
                m.content,
                m.message_type,
                u.username as pinned_by_username
            FROM pinned_messages pm
            JOIN messages m ON pm.message_id = m.id
            JOIN users u ON pm.pinned_by = u.id
            WHERE pm.message_id = ?
        `, [messageId]);

        res.json({
            success: true,
            message: 'Message pinned successfully',
            data: pinnedMessage
        });
    } catch (error) {
        console.error('Pin message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to pin message',
            error: error.message
        });
    }
}

/**
 * Unpin a message
 */
async function unpinMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        // Get pin details
        const pin = await queryOne(
            'SELECT chat_id FROM pinned_messages WHERE message_id = ?',
            [messageId]
        );

        if (!pin) {
            return res.status(404).json({
                success: false,
                message: 'Message is not pinned'
            });
        }

        // Check if user is a member of the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [pin.chat_id, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Delete pin
        await executeQuery(
            'DELETE FROM pinned_messages WHERE message_id = ?',
            [messageId]
        );

        res.json({
            success: true,
            message: 'Message unpinned successfully'
        });
    } catch (error) {
        console.error('Unpin message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unpin message',
            error: error.message
        });
    }
}

/**
 * Get pinned messages for a chat
 */
async function getPinnedMessages(req, res) {
    try {
        const { chatId } = req.params;
        const userId = req.user.id;

        // Check if user is a member of the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Get pinned messages that haven't expired
        const pinnedMessages = await executeQuery(`
            SELECT 
                pm.*,
                m.content,
                m.message_type,
                m.sender_id,
                sender.username as sender_username,
                sender.full_name as sender_full_name,
                pinner.username as pinned_by_username
            FROM pinned_messages pm
            JOIN messages m ON pm.message_id = m.id
            JOIN users sender ON m.sender_id = sender.id
            JOIN users pinner ON pm.pinned_by = pinner.id
            WHERE pm.chat_id = ? AND pm.pinned_until > CURRENT_TIMESTAMP
            ORDER BY pm.created_at DESC
        `, [chatId]);

        res.json({
            success: true,
            data: pinnedMessages
        });
    } catch (error) {
        console.error('Get pinned messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve pinned messages',
            error: error.message
        });
    }
}

module.exports = {
    getMessages,
    sendMessage,
    uploadFile,
    updateMessageStatus,
    addReaction,
    removeReaction,
    deleteMessage,
    pinMessage,
    unpinMessage,
    getPinnedMessages
};
