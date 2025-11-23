/**
 * Chat Controller
 * Handles chat creation, retrieval, and management
 */

const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');

/**
 * Get all chats for current user
 */
async function getUserChats(req, res) {
    try {
        const userId = req.user.id;
        
        console.log('Getting chats for user:', userId);

        // Get basic chat information first (exclude deleted chats)
        const chats = await executeQuery(`
            SELECT DISTINCT
                c.id,
                c.chat_type,
                c.chat_name,
                c.created_at,
                c.updated_at
            FROM chats c
            JOIN group_members gm ON c.id = gm.chat_id
            LEFT JOIN deleted_chats dc ON c.id = dc.chat_id AND dc.user_id = ?
            WHERE gm.user_id = ? AND dc.id IS NULL
            ORDER BY c.updated_at DESC
        `, [userId, userId]);
        
        console.log('Found chats:', chats.length);

        // For each chat, get participants and last message
        for (let chat of chats) {
            // Get participants
            const participants = await executeQuery(`
                SELECT 
                    u.id as userId,
                    u.username,
                    u.full_name as fullName,
                    u.avatar_url as avatarUrl,
                    u.status,
                    gm.role
                FROM group_members gm
                JOIN users u ON gm.user_id = u.id
                WHERE gm.chat_id = ?
            `, [chat.id]);
            
            chat.participants = JSON.stringify(participants);

            // Get last message
            const lastMessage = await executeQuery(`
                SELECT 
                    m.id,
                    m.content,
                    m.message_type as messageType,
                    m.sender_id as senderId,
                    sender.username as senderName,
                    m.status,
                    m.created_at as createdAt,
                    f.original_name as fileName
                FROM messages m
                JOIN users sender ON m.sender_id = sender.id
                LEFT JOIN files f ON m.file_id = f.id
                WHERE m.chat_id = ?
                ORDER BY m.created_at DESC
                LIMIT 1
            `, [chat.id]);
            
            chat.lastMessage = lastMessage.length > 0 ? JSON.stringify(lastMessage[0]) : null;
            
            // Get unread count for current user
            const unreadCountResult = await executeQuery(`
                SELECT COUNT(*) as count
                FROM messages
                WHERE chat_id = ?
                AND sender_id != ?
                AND status != 'read'
            `, [chat.id, userId]);
            
            const unreadCountValue = unreadCountResult.length > 0 ? unreadCountResult[0].count : 0;
            chat.unread_count = parseInt(unreadCountValue) || 0;
        }

        res.json({
            success: true,
            data: chats
        });
    } catch (error) {
        console.error('Get user chats error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve chats',
            error: error.message
        });
    }
}

/**
 * Get chat by ID
 */
async function getChatById(req, res) {
    try {
        const { chatId } = req.params;
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

        // Get chat details
        const chat = await queryOne(
            'SELECT * FROM chats WHERE id = ?',
            [chatId]
        );

        if (!chat) {
            return res.status(404).json({
                success: false,
                message: 'Chat not found'
            });
        }

        // Get participants
        const participants = await executeQuery(`
            SELECT 
                u.id,
                u.username,
                u.full_name,
                u.avatar_url,
                u.status,
                gm.role
            FROM group_members gm
            JOIN users u ON gm.user_id = u.id
            WHERE gm.chat_id = ?
        `, [chatId]);

        chat.participants = participants;

        res.json({
            success: true,
            data: chat
        });
    } catch (error) {
        console.error('Get chat error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve chat',
            error: error.message
        });
    }
}

/**
 * Create a new chat (direct or group)
 */
async function createChat(req, res) {
    try {
        const { chatType, chatName, participants } = req.body;
        const userId = req.user.id;

        // For direct chats, check if chat already exists
        if (chatType === 'direct') {
            if (participants.length !== 1) {
                return res.status(400).json({
                    success: false,
                    message: 'Direct chat requires exactly one other participant'
                });
            }

            const otherUserId = participants[0];

            // Check if direct chat already exists
            const existingChat = await queryOne(`
                SELECT c.id
                FROM chats c
                JOIN group_members gm1 ON c.id = gm1.chat_id
                JOIN group_members gm2 ON c.id = gm2.chat_id
                WHERE c.chat_type = 'direct'
                AND gm1.user_id = ?
                AND gm2.user_id = ?
            `, [userId, otherUserId]);

            if (existingChat) {
                return res.json({
                    success: true,
                    message: 'Chat already exists',
                    data: { chatId: existingChat.id }
                });
            }
        }

        // Create chat
        let chatId;
        if (process.env.DB_TYPE === 'postgresql') {
            const result = await executeQuery(
                'INSERT INTO chats (chat_type, chat_name, created_by) VALUES (?, ?, ?) RETURNING id',
                [chatType, chatType === 'group' ? sanitizeHtml(chatName) : null, userId]
            );
            chatId = result[0]?.id;
        } else {
            const result = await executeQuery(
                'INSERT INTO chats (chat_type, chat_name, created_by) VALUES (?, ?, ?)',
                [chatType, chatType === 'group' ? sanitizeHtml(chatName) : null, userId]
            );
            chatId = result.insertId;
        }

        // Add creator as admin (for group) or member (for direct)
        const creatorRole = chatType === 'group' ? 'admin' : 'member';
        await executeQuery(
            'INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, ?)',
            [chatId, userId, creatorRole]
        );

        // Add other participants
        for (const participantId of participants) {
            await executeQuery(
                'INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, ?)',
                [chatId, participantId, 'member']
            );
        }

        res.status(201).json({
            success: true,
            message: 'Chat created successfully',
            data: { chatId: chatId }
        });
    } catch (error) {
        console.error('Create chat error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create chat',
            error: error.message
        });
    }
}

/**
 * Add member to group chat
 */
async function addMember(req, res) {
    try {
        const { chatId } = req.params;
        const { userId: newUserId } = req.body;
        const currentUserId = req.user.id;

        // Check if current user is admin
        const membership = await queryOne(
            'SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, currentUserId]
        );

        if (!membership || membership.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Only admins can add members'
            });
        }

        // Check if user is already a member
        const existingMember = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, newUserId]
        );

        if (existingMember) {
            return res.status(400).json({
                success: false,
                message: 'User is already a member'
            });
        }

        // Add member
        await executeQuery(
            'INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, ?)',
            [chatId, newUserId, 'member']
        );

        res.json({
            success: true,
            message: 'Member added successfully'
        });
    } catch (error) {
        console.error('Add member error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add member',
            error: error.message
        });
    }
}

/**
 * Remove member from group chat
 */
async function removeMember(req, res) {
    try {
        const { chatId, userId: removeUserId } = req.params;
        const currentUserId = req.user.id;

        // Check if current user is admin
        const membership = await queryOne(
            'SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, currentUserId]
        );

        if (!membership || membership.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Only admins can remove members'
            });
        }

        // Remove member
        await executeQuery(
            'DELETE FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, removeUserId]
        );

        res.json({
            success: true,
            message: 'Member removed successfully'
        });
    } catch (error) {
        console.error('Remove member error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove member',
            error: error.message
        });
    }
}

/**
 * Search for users
 */
async function searchUsers(req, res) {
    try {
        const { query } = req.query;
        const userId = req.user.id;

        if (!query || query.length < 2) {
            return res.status(400).json({
                success: false,
                message: 'Search query must be at least 2 characters'
            });
        }

        const users = await executeQuery(`
            SELECT id, username, full_name, avatar_url, status
            FROM users
            WHERE (username LIKE ? OR full_name LIKE ?)
            AND id != ?
            LIMIT 20
        `, [`%${query}%`, `%${query}%`, userId]);

        res.json({
            success: true,
            data: users
        });
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search users',
            error: error.message
        });
    }
}

/**
 * Delete chat (soft delete - removes from user's chat list)
 */
async function deleteChat(req, res) {
    try {
        const { chatId } = req.params;
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

        // Add to deleted_chats table
        if (process.env.DB_TYPE === 'postgresql') {
            await executeQuery(
                'INSERT INTO deleted_chats (chat_id, user_id) VALUES (?, ?) ON CONFLICT (chat_id, user_id) DO UPDATE SET deleted_at = CURRENT_TIMESTAMP',
                [chatId, userId]
            );
        } else {
            await executeQuery(
                'INSERT INTO deleted_chats (chat_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at = CURRENT_TIMESTAMP',
                [chatId, userId]
            );
        }

        res.json({
            success: true,
            message: 'Chat deleted successfully'
        });
    } catch (error) {
        console.error('Delete chat error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete chat',
            error: error.message
        });
    }
}

module.exports = {
    getUserChats,
    getChatById,
    createChat,
    addMember,
    removeMember,
    searchUsers,
    deleteChat
};
