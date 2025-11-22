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

        // Get messages
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
                m.created_at
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            LEFT JOIN files f ON m.file_id = f.id
            WHERE m.chat_id = ?
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
        `, [chatId, parseInt(limit), parseInt(offset)]);

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

        const fileId = fileResult.insertId || fileResult[0]?.id;

        // Create message with file reference
        const messageResult = await executeQuery(
            'INSERT INTO messages (chat_id, sender_id, message_type, file_id, status) VALUES (?, ?, ?, ?, ?)',
            [chatId, userId, messageType, fileId, 'sent']
        );

        const messageId = messageResult.insertId || messageResult[0]?.id;

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

        // Add or update reaction
        await executeQuery(
            'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = ?',
            [messageId, userId, emoji, emoji]
        );

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

module.exports = {
    getMessages,
    sendMessage,
    uploadFile,
    updateMessageStatus,
    addReaction,
    removeReaction
};
