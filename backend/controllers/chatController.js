/**
 * Chat Controller
 * Handles chat creation, retrieval, and management
 */

const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');
const {
    MUTE_DURATIONS,
    markChatRead,
    getChatSettings,
    setMute,
    setArchived
} = require('../utils/chatState');

/**
 * Get all chats for current user
 */
async function getUserChats(req, res) {
    try {
        const userId = req.user.id;
        
        console.log('Getting chats for user:', userId);

        // Chat info plus this user's read/mute/archive state (exclude deleted chats)
        const chats = await executeQuery(`
            SELECT
                c.id,
                c.chat_type,
                c.chat_name,
                c.created_at,
                c.updated_at,
                gm.last_read_message_id,
                gm.muted_until,
                CASE WHEN gm.muted_until IS NOT NULL AND gm.muted_until > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_muted,
                gm.archived_at,
                (
                    SELECT COUNT(*)
                    FROM messages um
                    WHERE um.chat_id = c.id
                    AND um.id > COALESCE(gm.last_read_message_id, 0)
                    AND um.sender_id <> ?
                    AND (um.deleted_for_everyone IS NULL OR um.deleted_for_everyone = FALSE)
                ) AS unread_count
            FROM chats c
            JOIN group_members gm ON c.id = gm.chat_id AND gm.user_id = ?
            LEFT JOIN deleted_chats dc ON c.id = dc.chat_id AND dc.user_id = ?
            WHERE dc.id IS NULL
            ORDER BY c.updated_at DESC
        `, [userId, userId, userId]);

        console.log('Found chats:', chats.length);

        // Participants and last message for every chat in one query each
        const participantsByChat = {};
        const lastMessageByChat = {};

        if (chats.length > 0) {
            const chatIds = chats.map(chat => chat.id);
            const placeholders = chatIds.map(() => '?').join(', ');

            const participantRows = await executeQuery(`
                SELECT
                    gm.chat_id,
                    u.id as userId,
                    u.username,
                    u.full_name as fullName,
                    u.avatar_url as avatarUrl,
                    u.status,
                    gm.role
                FROM group_members gm
                JOIN users u ON gm.user_id = u.id
                WHERE gm.chat_id IN (${placeholders})
                ORDER BY gm.chat_id, gm.id
            `, chatIds);

            for (const row of participantRows) {
                const chatId = row.chat_id;
                delete row.chat_id; // Grouping key only - not part of the response
                (participantsByChat[chatId] = participantsByChat[chatId] || []).push(row);
            }

            // Newest message per chat (id breaks created_at ties)
            const lastMessageRows = await executeQuery(`
                SELECT
                    c.id as chat_id,
                    m.id,
                    m.content,
                    m.message_type as messageType,
                    m.sender_id as senderId,
                    sender.username as senderName,
                    m.status,
                    m.created_at as createdAt,
                    f.original_name as fileName
                FROM chats c
                JOIN messages m ON m.id = (
                    SELECT m2.id
                    FROM messages m2
                    WHERE m2.chat_id = c.id
                    ORDER BY m2.created_at DESC, m2.id DESC
                    LIMIT 1
                )
                JOIN users sender ON m.sender_id = sender.id
                LEFT JOIN files f ON m.file_id = f.id
                WHERE c.id IN (${placeholders})
            `, chatIds);

            for (const row of lastMessageRows) {
                const chatId = row.chat_id;
                delete row.chat_id;
                lastMessageByChat[chatId] = row;
            }
        }

        for (const chat of chats) {
            chat.unread_count = parseInt(chat.unread_count) || 0;
            chat.is_muted = !!parseInt(chat.is_muted);
            chat.participants = JSON.stringify(participantsByChat[chat.id] || []);
            chat.lastMessage = lastMessageByChat[chat.id] ? JSON.stringify(lastMessageByChat[chat.id]) : null;
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

        // Add member; earlier history starts out read so they don't join to a wall of unread
        await executeQuery(
            'INSERT INTO group_members (chat_id, user_id, role, last_read_message_id) VALUES (?, ?, ?, (SELECT MAX(id) FROM messages WHERE chat_id = ?))',
            [chatId, newUserId, 'member', chatId]
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

/**
 * Move the current user's read position forward
 * Body: { messageId } (optional - defaults to the newest message)
 */
async function markRead(req, res) {
    try {
        const { chatId } = req.params;
        const messageId = parseInt(req.body && req.body.messageId) || null;

        const state = await markChatRead(req.io, chatId, req.user.id, messageId);

        if (!state) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        res.json({
            success: true,
            data: state
        });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update read position',
            error: error.message
        });
    }
}

/**
 * Mute or unmute a chat for the current user
 * Body: { duration: '8h' | '1w' | 'always' | 'off' }
 */
async function updateMute(req, res) {
    try {
        const { chatId } = req.params;
        const { duration } = req.body || {};
        const userId = req.user.id;

        if (!MUTE_DURATIONS[duration] && duration !== 'always' && duration !== 'off') {
            return res.status(400).json({
                success: false,
                message: "duration must be one of '8h', '1w', 'always', 'off'"
            });
        }

        if (!(await getChatSettings(chatId, userId))) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        await setMute(chatId, userId, duration);
        const settings = await getChatSettings(chatId, userId);

        // Keep the user's other tabs in sync
        req.io.to(`user_${userId}`).emit('chat_settings_updated', settings);

        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        console.error('Update mute error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update mute setting',
            error: error.message
        });
    }
}

/**
 * Archive or unarchive a chat for the current user
 * Body: { archived: true | false }
 */
async function updateArchive(req, res) {
    try {
        const { chatId } = req.params;
        const { archived } = req.body || {};
        const userId = req.user.id;

        if (typeof archived !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'archived must be true or false'
            });
        }

        if (!(await getChatSettings(chatId, userId))) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        await setArchived(chatId, userId, archived);
        const settings = await getChatSettings(chatId, userId);

        req.io.to(`user_${userId}`).emit('chat_settings_updated', settings);

        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        console.error('Update archive error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update archive setting',
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
    deleteChat,
    markRead,
    updateMute,
    updateArchive
};
