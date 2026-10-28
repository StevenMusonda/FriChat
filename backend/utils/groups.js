/**
 * Group rules shared by the REST controllers and the socket handlers:
 * who may post (announcement-only mode), who may manage a group, joining and leaving.
 */

const { executeQuery, queryOne } = require('../config/database');
const { toBool } = require('./messageQueries');

const ANNOUNCEMENT_ONLY_MESSAGE = 'Only admins can send messages in this group';

/**
 * The user's membership plus the chat fields the rules need, or null for a non-member
 */
async function getMembership(chatId, userId) {
    return queryOne(`
        SELECT gm.id, gm.role, c.chat_type, c.announcement_only
        FROM group_members gm
        JOIN chats c ON c.id = gm.chat_id
        WHERE gm.chat_id = ? AND gm.user_id = ?
    `, [chatId, userId]);
}

/**
 * Why this membership can't post a new message, or null if it can
 * @returns {null | { status: number, code: string, message: string }}
 */
function postingError(membership) {
    if (!membership) {
        return { status: 403, code: 'NOT_A_MEMBER', message: 'Access denied to this chat' };
    }
    if (membership.chat_type === 'group' && toBool(membership.announcement_only) && membership.role !== 'admin') {
        return { status: 403, code: 'ANNOUNCEMENT_ONLY', message: ANNOUNCEMENT_ONLY_MESSAGE };
    }
    return null;
}

/**
 * Every send path (REST send, file upload into a chat, forward, socket send_message) goes through this
 */
async function checkCanPost(chatId, userId) {
    return postingError(await getMembership(chatId, userId));
}

/**
 * Membership check for group-management endpoints
 * @param {Object} options - { admin: true when only admins may do this }
 * @returns {{ membership } | { error: { status, message } }}
 */
async function requireGroupMember(chatId, userId, { admin = false } = {}) {
    const membership = await getMembership(chatId, userId);
    if (!membership) {
        return { error: { status: 403, message: 'Access denied to this chat' } };
    }
    if (membership.chat_type !== 'group') {
        return { error: { status: 400, message: 'This is not a group chat' } };
    }
    if (admin && membership.role !== 'admin') {
        return { error: { status: 403, message: 'Only group admins can do this' } };
    }
    return { membership };
}

function isDuplicateKeyError(error) {
    return !!error && (error.code === 'ER_DUP_ENTRY' || error.code === '23505');
}

/**
 * Add a user to a group as a member (invite link or approved request).
 * Earlier history starts out read, and the chat comes back if the user had deleted it from their list.
 * @returns {Promise<boolean>} false if they were already a member
 */
async function addGroupMember(chatId, userId) {
    const existing = await queryOne(
        'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
        [chatId, userId]
    );
    if (existing) return false;

    try {
        await executeQuery(
            'INSERT INTO group_members (chat_id, user_id, role, last_read_message_id) VALUES (?, ?, ?, (SELECT MAX(id) FROM messages WHERE chat_id = ?))',
            [chatId, userId, 'member', chatId]
        );
    } catch (error) {
        // A second click or tab got there first
        if (isDuplicateKeyError(error)) return false;
        throw error;
    }

    await executeQuery('DELETE FROM deleted_chats WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    return true;
}

/**
 * The member who has been in the group longest (earliest joined_at, then lowest id), other than exceptUserId
 */
async function findLongestStandingMember(chatId, exceptUserId) {
    return queryOne(`
        SELECT gm.user_id, u.username
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.chat_id = ? AND gm.user_id <> ?
        ORDER BY gm.joined_at ASC, gm.id ASC
        LIMIT 1
    `, [chatId, exceptUserId]);
}

async function countAdmins(chatId, exceptUserId = 0) {
    const row = await queryOne(
        "SELECT COUNT(*) AS count FROM group_members WHERE chat_id = ? AND role = 'admin' AND user_id <> ?",
        [chatId, exceptUserId]
    );
    return row ? parseInt(row.count) || 0 : 0;
}

async function promoteToAdmin(chatId, userId) {
    await executeQuery(
        "UPDATE group_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?",
        [chatId, userId]
    );
}

/**
 * Leave a group. When the last admin leaves, admin goes to newAdminId (if given and a member)
 * or else to the longest-standing member.
 * @returns {{ error } | { newAdmin: { userId, username } | null }}
 */
async function leaveGroup(chatId, userId, newAdminId = null) {
    const check = await requireGroupMember(chatId, userId);
    if (check.error) return check;

    let successor = null;
    if (check.membership.role === 'admin' && (await countAdmins(chatId, userId)) === 0) {
        if (newAdminId) {
            if (Number(newAdminId) === Number(userId)) {
                return { error: { status: 400, message: 'Pick another member to become admin' } };
            }
            successor = await queryOne(`
                SELECT gm.user_id, u.username
                FROM group_members gm
                JOIN users u ON u.id = gm.user_id
                WHERE gm.chat_id = ? AND gm.user_id = ?
            `, [chatId, newAdminId]);
            if (!successor) {
                return { error: { status: 400, message: 'The new admin must be a member of this group' } };
            }
        } else {
            successor = await findLongestStandingMember(chatId, userId);
        }

        if (successor) {
            await promoteToAdmin(chatId, successor.user_id);
        }
    }

    await executeQuery('DELETE FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);

    // Two admins leaving at the same moment can each see the other as "the remaining admin"
    if (!successor && (await countAdmins(chatId)) === 0) {
        successor = await findLongestStandingMember(chatId, userId);
        if (successor) await promoteToAdmin(chatId, successor.user_id);
    }

    return { newAdmin: successor ? { userId: successor.user_id, username: successor.username } : null };
}

/**
 * Socket room changes for every open tab of a user (no-op for test doubles without io.in)
 */
function joinUserToChatRoom(io, userId, chatId) {
    if (io && typeof io.in === 'function') {
        io.in(`user_${userId}`).socketsJoin(`chat_${chatId}`);
    }
}

function removeUserFromChatRoom(io, userId, chatId) {
    if (io && typeof io.in === 'function') {
        io.in(`user_${userId}`).socketsLeave(`chat_${chatId}`);
    }
}

/**
 * Public group profile and settings, as sent to members
 */
async function getGroupProfile(chatId) {
    const chat = await queryOne(
        'SELECT id, chat_type, chat_name, description, avatar_url, approve_new_members, announcement_only FROM chats WHERE id = ?',
        [chatId]
    );
    if (!chat) return null;
    return {
        chatId: chat.id,
        chatName: chat.chat_name,
        description: chat.description || null,
        avatarUrl: chat.avatar_url || null,
        approveNewMembers: toBool(chat.approve_new_members),
        announcementOnly: toBool(chat.announcement_only)
    };
}

/**
 * Tell everyone in the group that its name, description, avatar or settings changed
 */
async function emitGroupUpdated(io, chatId) {
    const profile = await getGroupProfile(chatId);
    if (io && profile) {
        io.to(`chat_${chatId}`).emit('group_updated', profile);
    }
    return profile;
}

/**
 * Members, roles or tags changed; clients with the group open refetch it
 */
function emitMembersUpdated(io, chatId) {
    if (io) {
        io.to(`chat_${chatId}`).emit('group_members_updated', { chatId: Number(chatId) });
    }
}

async function getAdminIds(chatId) {
    const rows = await executeQuery(
        "SELECT user_id FROM group_members WHERE chat_id = ? AND role = 'admin'",
        [chatId]
    );
    return rows.map(row => row.user_id);
}

async function countPendingRequests(chatId) {
    const row = await queryOne(
        "SELECT COUNT(*) AS count FROM chat_join_requests WHERE chat_id = ? AND status = 'pending'",
        [chatId]
    );
    return row ? parseInt(row.count) || 0 : 0;
}

/**
 * Send an event to the personal room of every admin of the group
 */
async function emitToAdmins(io, chatId, event, data) {
    if (!io) return;
    for (const adminId of await getAdminIds(chatId)) {
        io.to(`user_${adminId}`).emit(event, data);
    }
}

module.exports = {
    ANNOUNCEMENT_ONLY_MESSAGE,
    getMembership,
    postingError,
    checkCanPost,
    requireGroupMember,
    isDuplicateKeyError,
    addGroupMember,
    findLongestStandingMember,
    leaveGroup,
    joinUserToChatRoom,
    removeUserFromChatRoom,
    getGroupProfile,
    emitGroupUpdated,
    emitMembersUpdated,
    countPendingRequests,
    emitToAdmins
};
