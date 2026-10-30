/**
 * Chat Controller
 * Handles chat creation, retrieval, and management
 */

const { executeQuery, queryOne } = require('../config/database');
const { stripControlChars } = require('../utils/messageText');
const {
    MUTE_DURATIONS,
    markChatRead,
    getChatSettings,
    setMute,
    setArchived,
    setMentionsOnly
} = require('../utils/chatState');
const { getMembership, leaveGroup, removeUserFromChatRoom, emitMembersUpdated, isBanned, banUser } = require('../utils/groups');
const { getGroupDetailsForMember } = require('./groupController');
const { toBool } = require('../utils/messageQueries');
const { checkUnverifiedContact } = require('../utils/emailVerification');
const { checkBlockBetween, checkDirectChatBlock, findBlockersAmong } = require('../utils/blocks');
const privacy = require('../utils/privacy');
const messageRequests = require('../utils/messageRequests');
const disappearing = require('../utils/disappearing');

// Names each participant field for utils/privacy.js
const LIST_PARTICIPANT_KEYS = { id: 'userId', avatar: 'avatarUrl', status: 'status', customStatus: 'customStatus' };
const CHAT_PARTICIPANT_KEYS = { id: 'id', avatar: 'avatar_url', status: 'status', lastSeen: 'last_seen', customStatus: 'custom_status' };

/**
 * 403 when one of userIds doesn't allow adderId to put them in a group, else null
 */
async function checkGroupAddPrivacy(adderId, userIds) {
    const refused = await privacy.findGroupAddRefusals(adderId, userIds);
    return refused.length > 0 ? { ...privacy.GROUP_ADD_REFUSED, refusedUserIds: refused } : null;
}

function sendError(res, error) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

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
                c.avatar_url,
                c.disappearing_seconds,
                c.created_at,
                c.updated_at,
                gm.last_read_message_id,
                gm.muted_until,
                CASE WHEN gm.muted_until IS NOT NULL AND gm.muted_until > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_muted,
                gm.archived_at,
                gm.mentions_only,
                (
                    SELECT COUNT(*)
                    FROM message_mentions mm
                    JOIN messages mmsg ON mmsg.id = mm.message_id
                    WHERE mm.user_id = ?
                    AND mmsg.chat_id = c.id
                    AND mmsg.id > COALESCE(gm.last_read_message_id, 0)
                    AND (mmsg.deleted_for_everyone IS NULL OR mmsg.deleted_for_everyone = FALSE)
                ) AS unread_mention_count,
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
        `, [userId, userId, userId, userId]);

        console.log('Found chats:', chats.length);

        // Participants and last message for every chat in one query each
        const participantsByChat = {};
        const lastMessageByChat = {};

        if (chats.length > 0) {
            const chatIds = chats.map(chat => chat.id);
            const placeholders = chatIds.map(() => '?').join(', ');

            const rawParticipantRows = await executeQuery(`
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

            // PostgreSQL lowercases unquoted aliases (userid, avatarurl): key them here so the privacy
            // filter below sees, and clears, the same fields on both databases
            const participantRows = rawParticipantRows.map(row => ({
                chat_id: row.chat_id,
                userId: row.userId !== undefined ? row.userId : row.userid,
                username: row.username,
                fullName: row.fullName !== undefined ? row.fullName : row.fullname,
                avatarUrl: row.avatarUrl !== undefined ? row.avatarUrl : row.avatarurl,
                status: row.status,
                role: row.role
            }));

            // Photos, presence and custom status only as each participant's privacy settings allow
            // (people who blocked this user show nothing)
            await privacy.applyUserPrivacy(userId, participantRows, LIST_PARTICIPANT_KEYS);

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
                    CASE WHEN m.deleted_for_everyone = TRUE THEN NULL ELSE m.content END as content,
                    m.deleted_for_everyone as deleted,
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
                    AND (m2.expires_at IS NULL OR m2.expires_at > CURRENT_TIMESTAMP)
                    ORDER BY m2.created_at DESC, m2.id DESC
                    LIMIT 1
                )
                JOIN users sender ON m.sender_id = sender.id
                LEFT JOIN files f ON m.file_id = f.id
                WHERE c.id IN (${placeholders})
            `, chatIds);

            // With read receipts off you don't see other people's reads either
            privacy.maskReadStatus(lastMessageRows, await privacy.readReceiptsEnabled(userId));

            for (const row of lastMessageRows) {
                const chatId = row.chat_id;
                delete row.chat_id;
                lastMessageByChat[chatId] = row;
            }
        }

        // Direct chats that are still a message request: incoming ones go to the Requests section
        const pendingRequests = await messageRequests.getPendingRequests(chats.map(chat => chat.id));

        for (const chat of chats) {
            chat.unread_count = parseInt(chat.unread_count) || 0;
            chat.is_muted = !!parseInt(chat.is_muted);
            chat.unread_mention_count = parseInt(chat.unread_mention_count) || 0;
            chat.mentions_only = chat.mentions_only === true || chat.mentions_only === 1 || chat.mentions_only === '1';
            chat.disappearing_seconds = parseInt(chat.disappearing_seconds) || 0;
            chat.participants = JSON.stringify(participantsByChat[chat.id] || []);
            chat.lastMessage = lastMessageByChat[chat.id] ? JSON.stringify(lastMessageByChat[chat.id]) : null;
            chat.message_request = messageRequests.describeRequest(pendingRequests.get(Number(chat.id)) || null, userId);
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
 * Turn disappearing messages on/off for new messages in a chat. Body: { seconds }.
 * Direct chats: either person; groups: admins. Announced in the chat as a system message.
 */
async function setDisappearingTimer(req, res) {
    try {
        const result = await disappearing.setTimer(req.io, req.params.chatId, req.user.id, req.body.seconds);
        if (result.error) return sendError(res, result.error);

        res.json({
            success: true,
            message: result.seconds > 0 ? 'Disappearing messages turned on' : 'Disappearing messages turned off',
            data: { chatId: Number(req.params.chatId), seconds: result.seconds, changed: result.changed }
        });
    } catch (error) {
        console.error('Set disappearing timer error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to change disappearing messages',
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

        // Check if user is a member of this chat (role and announcement mode come with it)
        const membership = await getMembership(chatId, userId);

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

        // Get participants (longest-standing first, the order admin passes down in)
        const participants = await executeQuery(`
            SELECT 
                u.id,
                u.username,
                u.full_name,
                u.avatar_url,
                u.status,
                gm.role,
                gm.member_tag,
                gm.joined_at
            FROM group_members gm
            JOIN users u ON gm.user_id = u.id
            WHERE gm.chat_id = ?
            ORDER BY gm.joined_at ASC, gm.id ASC
        `, [chatId]);

        chat.participants = await privacy.applyUserPrivacy(userId, participants, CHAT_PARTICIPANT_KEYS);
        chat.approve_new_members = toBool(chat.approve_new_members);
        chat.announcement_only = toBool(chat.announcement_only);
        chat.disappearing_seconds = parseInt(chat.disappearing_seconds) || 0;
        // Disappearing messages: either person in a direct chat, admins in a group
        chat.can_change_disappearing = !(await disappearing.checkCanChangeTimer(chatId, userId));

        // Your role, whether you can post, invite links on/off and (admins) pending join requests
        if (chat.chat_type === 'group') {
            Object.assign(chat, await getGroupDetailsForMember(chatId, membership));
        } else {
            chat.my_role = membership.role;
            chat.message_request = messageRequests.describeRequest(await messageRequests.getRequest(chatId), userId);
            // A block either way, or a request not accepted yet, locks the composer (worded for this user)
            const blockError = (await checkDirectChatBlock(chatId, userId)) || (await messageRequests.checkRequestReply(chatId, userId));
            chat.can_post = !blockError;
            chat.post_blocked_message = blockError ? blockError.message : null;
        }

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
        const { chatType } = req.body;
        let { participants } = req.body;
        const userId = req.user.id;

        // Stored raw like message text (validated to 100 chars); clients escape on render
        const chatName = chatType === 'group' && typeof req.body.chatName === 'string'
            ? (stripControlChars(req.body.chatName).trim() || null)
            : null;

        // Numeric ids of the other people, without duplicates or the creator
        const participantIds = [...new Set(participants.map(Number))];
        if (participantIds.some(id => !Number.isInteger(id) || id < 1)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid participant'
            });
        }
        participants = participantIds.filter(id => id !== Number(userId));
        if (participants.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one other participant is required'
            });
        }

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
                // The recipient of a request writing to the requester themselves accepts it
                if (await messageRequests.acceptByRecipientContact(existingChat.id, userId) && req.io) {
                    req.io.to(`user_${userId}`).emit('message_request_updated', { chatId: Number(existingChat.id), status: 'accepted' });
                    req.io.to(`user_${otherUserId}`).emit('message_request_updated', { chatId: Number(existingChat.id), status: 'accepted' });
                }
                return res.json({
                    success: true,
                    message: 'Chat already exists',
                    data: { chatId: existingChat.id }
                });
            }

            // No new direct chat while either of them has blocked the other
            const blockError = await checkBlockBetween(userId, otherUserId);
            if (blockError) return sendError(res, blockError);
        } else {
            // People who blocked the creator can't be put in a group by them
            if ((await findBlockersAmong(userId, participants)).length > 0) {
                return res.status(403).json({
                    success: false,
                    message: 'You can\'t add one or more of these people to a group.',
                    code: 'BLOCKED'
                });
            }

            // "Who can add me to groups"
            const privacyError = await checkGroupAddPrivacy(userId, participants);
            if (privacyError) return sendError(res, privacyError);
        }

        // Someone the other person shares no chat with lands in their Requests
        const isMessageRequest = chatType === 'direct' && !(await privacy.isContact(userId, participants[0]));

        // Unverified accounts only reach people they already share a chat with
        const contactError = await checkUnverifiedContact(req.user, participants);
        if (contactError) return sendError(res, contactError);

        // Create chat
        let chatId;
        if (process.env.DB_TYPE === 'postgresql') {
            const result = await executeQuery(
                'INSERT INTO chats (chat_type, chat_name, created_by) VALUES (?, ?, ?) RETURNING id',
                [chatType, chatName, userId]
            );
            chatId = result[0]?.id;
        } else {
            const result = await executeQuery(
                'INSERT INTO chats (chat_type, chat_name, created_by) VALUES (?, ?, ?)',
                [chatType, chatName, userId]
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

        if (isMessageRequest) {
            await messageRequests.createRequest(chatId, userId, participants[0]);
        }

        res.status(201).json({
            success: true,
            message: isMessageRequest ? 'Message request created' : 'Chat created successfully',
            data: { chatId: chatId, messageRequest: isMessageRequest }
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

        if (await isBanned(chatId, newUserId)) {
            return res.status(403).json({
                success: false,
                message: 'This user is banned from the group. Unban them first.',
                code: 'BANNED'
            });
        }

        // Someone who blocked this admin can't be added by them
        if ((await findBlockersAmong(currentUserId, [newUserId])).length > 0) {
            return res.status(403).json({
                success: false,
                message: 'You can\'t add this user to the group.',
                code: 'BLOCKED'
            });
        }

        const contactError = await checkUnverifiedContact(req.user, [newUserId]);
        if (contactError) return sendError(res, contactError);

        // "Who can add me to groups"
        const privacyError = await checkGroupAddPrivacy(currentUserId, [newUserId]);
        if (privacyError) {
            return res.status(403).json({
                success: false,
                message: 'This user doesn\'t allow you to add them to groups.',
                code: privacyError.code
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
        // ?ban=true: "Remove and ban" - no rejoining by link or by an admin until unbanned
        const ban = req.query && (req.query.ban === 'true' || req.query.ban === '1');

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

        if (ban && Number(removeUserId) === Number(currentUserId)) {
            return res.status(400).json({
                success: false,
                message: 'You can\'t ban yourself'
            });
        }

        // Removing yourself is leaving, so the last admin still hands admin on
        if (Number(removeUserId) === Number(currentUserId)) {
            const result = await leaveGroup(chatId, currentUserId);
            if (result.error) {
                return res.status(result.error.status).json({ success: false, message: result.error.message });
            }
        } else {
            // Remove member
            await executeQuery(
                'DELETE FROM group_members WHERE chat_id = ? AND user_id = ?',
                [chatId, removeUserId]
            );

            if (ban) {
                await banUser(chatId, removeUserId, currentUserId);
            }
        }

        // Their open tabs stop receiving the chat's live events
        removeUserFromChatRoom(req.io, removeUserId, chatId);
        emitMembersUpdated(req.io, chatId);
        if (req.io) {
            req.io.to(`user_${removeUserId}`).emit('group_left', { chatId: Number(chatId) });
        }

        res.json({
            success: true,
            message: ban ? 'Member removed and banned' : 'Member removed successfully',
            data: { userId: Number(removeUserId), banned: !!ban }
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
            data: await privacy.applyUserPrivacy(userId, users, { customStatus: null })
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

/**
 * Notify only on @mentions in this chat (mentions also get through a mute)
 * Body: { enabled: true | false } (validated by validateMentionsOnly)
 */
async function updateMentionsOnly(req, res) {
    try {
        const { chatId } = req.params;
        const userId = req.user.id;

        if (!(await getChatSettings(chatId, userId))) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        await setMentionsOnly(chatId, userId, req.body.enabled);
        const settings = await getChatSettings(chatId, userId);

        // Keep the user's other tabs in sync
        req.io.to(`user_${userId}`).emit('chat_settings_updated', settings);

        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        console.error('Update mentions-only error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update notification setting',
            error: error.message
        });
    }
}

module.exports = {
    setDisappearingTimer,
    updateMentionsOnly,
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
