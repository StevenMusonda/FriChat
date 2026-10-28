/**
 * Group Controller
 * Group profile and settings, invite links, join requests, member tags and leaving.
 * Every handler checks membership (and the admin role where needed) itself, so a direct
 * API call gets the same answer as the UI.
 */

const { executeQuery, queryOne } = require('../config/database');
const { inviteLinksEnabled } = require('../config/groups');
const groups = require('../utils/groups');
const invites = require('../utils/invites');
const { saveGroupAvatar, deleteGroupAvatar } = require('../utils/groupAvatar');

function sendError(res, error) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error);
    return res.status(500).json({ success: false, message, error: error.message });
}

const invitesDisabled = (res) => sendError(res, invites.INVITE_ERRORS.DISABLED);

/**
 * PATCH /api/chats/:chatId/settings (admins)
 * Body (any of): chatName, description, approveNewMembers, announcementOnly
 */
async function updateGroupSettings(req, res) {
    try {
        const { chatId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const { chatName, description, approveNewMembers, announcementOnly } = req.body;
        const sets = [];
        const params = [];

        if (typeof chatName === 'string') {
            sets.push('chat_name = ?');
            params.push(chatName);
        }
        if (description !== undefined) {
            sets.push('description = ?');
            params.push(description ? description : null);
        }
        if (approveNewMembers !== undefined) {
            sets.push('approve_new_members = ?');
            params.push(approveNewMembers);
        }
        if (announcementOnly !== undefined) {
            sets.push('announcement_only = ?');
            params.push(announcementOnly);
        }

        if (sets.length === 0) {
            return res.status(400).json({ success: false, message: 'Nothing to update' });
        }

        await executeQuery(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`, [...params, chatId]);
        const profile = await groups.emitGroupUpdated(req.io, chatId);

        res.json({ success: true, data: profile });
    } catch (error) {
        serverError(res, 'Update group settings', error, 'Failed to update group settings');
    }
}

/**
 * POST /api/chats/:chatId/avatar (admins, multipart field "avatar")
 */
async function uploadAvatar(req, res) {
    try {
        const { chatId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image uploaded' });
        }

        const saved = await saveGroupAvatar(req.file.buffer);
        if (saved.error) {
            return res.status(400).json({ success: false, message: saved.error });
        }

        const previous = await queryOne('SELECT avatar_url FROM chats WHERE id = ?', [chatId]);
        await executeQuery('UPDATE chats SET avatar_url = ? WHERE id = ?', [saved.avatarUrl, chatId]);
        if (previous && previous.avatar_url) {
            await deleteGroupAvatar(previous.avatar_url);
        }

        const profile = await groups.emitGroupUpdated(req.io, chatId);
        res.json({ success: true, data: { ...profile, resized: saved.resized } });
    } catch (error) {
        serverError(res, 'Upload group avatar', error, 'Failed to update the group avatar');
    }
}

/**
 * DELETE /api/chats/:chatId/avatar (admins)
 */
async function removeAvatar(req, res) {
    try {
        const { chatId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const previous = await queryOne('SELECT avatar_url FROM chats WHERE id = ?', [chatId]);
        await executeQuery('UPDATE chats SET avatar_url = NULL WHERE id = ?', [chatId]);
        if (previous && previous.avatar_url) {
            await deleteGroupAvatar(previous.avatar_url);
        }

        const profile = await groups.emitGroupUpdated(req.io, chatId);
        res.json({ success: true, data: profile });
    } catch (error) {
        serverError(res, 'Remove group avatar', error, 'Failed to remove the group avatar');
    }
}

/**
 * POST /api/chats/:chatId/invites (admins) Body: { expiresIn?: '1h'|'1d'|'7d'|'never', maxUses?: 1-1000 }
 * The response is the only time the full link is available.
 */
async function createInvite(req, res) {
    try {
        if (!inviteLinksEnabled()) return invitesDisabled(res);

        const { chatId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const { token, invite } = await invites.createInvite(chatId, req.user.id, req.body.expiresIn || 'never', req.body.maxUses || null);

        res.status(201).json({
            success: true,
            data: { ...invite, code: token, url: invites.buildInviteUrl(token) }
        });
    } catch (error) {
        serverError(res, 'Create invite', error, 'Failed to create the invite link');
    }
}

/**
 * GET /api/chats/:chatId/invites (admins)
 */
async function listInvites(req, res) {
    try {
        if (!inviteLinksEnabled()) return invitesDisabled(res);

        const { chatId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        res.json({ success: true, data: await invites.listInvites(chatId) });
    } catch (error) {
        serverError(res, 'List invites', error, 'Failed to load invite links');
    }
}

/**
 * DELETE /api/chats/:chatId/invites/:inviteId (admins)
 * Works while invite links are switched off too, so admins can still clean up.
 */
async function revokeInvite(req, res) {
    try {
        const { chatId, inviteId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const revoked = await invites.revokeInvite(chatId, inviteId);
        if (!revoked) {
            const existing = await invites.getInviteById(chatId, inviteId);
            return existing
                ? res.status(409).json({ success: false, message: 'This link was already revoked' })
                : res.status(404).json({ success: false, message: 'Invite link not found' });
        }

        res.json({ success: true, data: await invites.getInviteById(chatId, inviteId) });
    } catch (error) {
        serverError(res, 'Revoke invite', error, 'Failed to revoke the invite link');
    }
}

/**
 * GET /api/chats/:chatId/join-requests (admins) - pending requests, oldest first
 */
async function listJoinRequests(req, res) {
    try {
        const { chatId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const rows = await executeQuery(`
            SELECT r.id, r.user_id, r.created_at, u.username, u.full_name, u.avatar_url
            FROM chat_join_requests r
            JOIN users u ON u.id = r.user_id
            WHERE r.chat_id = ? AND r.status = 'pending'
            ORDER BY r.created_at ASC, r.id ASC
        `, [chatId]);

        res.json({
            success: true,
            data: rows.map(row => ({
                id: row.id,
                userId: row.user_id,
                username: row.username,
                fullName: row.full_name,
                avatarUrl: row.avatar_url,
                createdAt: row.created_at
            }))
        });
    } catch (error) {
        serverError(res, 'List join requests', error, 'Failed to load join requests');
    }
}

/**
 * Approve or decline a pending request. The status change is one conditional UPDATE,
 * so two admins deciding at once can't both act on it.
 */
async function decideJoinRequest(req, res, decision) {
    try {
        const { chatId, requestId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const request = await queryOne(
            'SELECT id, user_id, status FROM chat_join_requests WHERE id = ? AND chat_id = ?',
            [requestId, chatId]
        );
        if (!request) {
            return res.status(404).json({ success: false, message: 'Join request not found' });
        }

        const updateSql = "UPDATE chat_join_requests SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'";
        let updated;
        if (process.env.DB_TYPE === 'postgresql') {
            updated = (await executeQuery(`${updateSql} RETURNING id`, [decision, req.user.id, requestId])).length === 1;
        } else {
            updated = (await executeQuery(updateSql, [decision, req.user.id, requestId])).affectedRows === 1;
        }
        if (!updated) {
            return res.status(409).json({ success: false, message: 'This request was already handled' });
        }

        if (decision === 'approved') {
            await groups.addGroupMember(chatId, request.user_id);
            groups.joinUserToChatRoom(req.io, request.user_id, chatId);
            groups.emitMembersUpdated(req.io, chatId);
        }

        const chat = await queryOne('SELECT chat_name FROM chats WHERE id = ?', [chatId]);
        if (req.io) {
            req.io.to(`user_${request.user_id}`).emit('join_request_decided', {
                chatId: Number(chatId),
                chatName: chat ? chat.chat_name : null,
                status: decision
            });
        }

        const pendingCount = await groups.countPendingRequests(chatId);
        await groups.emitToAdmins(req.io, chatId, 'join_requests_updated', { chatId: Number(chatId), pendingCount });

        res.json({ success: true, data: { requestId: Number(requestId), userId: request.user_id, status: decision, pendingCount } });
    } catch (error) {
        serverError(res, 'Decide join request', error, 'Failed to update the join request');
    }
}

const approveJoinRequest = (req, res) => decideJoinRequest(req, res, 'approved');
const declineJoinRequest = (req, res) => decideJoinRequest(req, res, 'declined');

/**
 * PUT /api/chats/:chatId/members/:userId/tag (admins) Body: { tag: string | null }
 */
async function setMemberTag(req, res) {
    try {
        const { chatId, userId } = req.params;
        const check = await groups.requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const target = await queryOne('SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
        if (!target) {
            return res.status(404).json({ success: false, message: 'That user is not a member of this group' });
        }

        const tag = req.body.tag ? req.body.tag : null;
        await executeQuery('UPDATE group_members SET member_tag = ? WHERE chat_id = ? AND user_id = ?', [tag, chatId, userId]);
        groups.emitMembersUpdated(req.io, chatId);

        res.json({ success: true, data: { userId, tag } });
    } catch (error) {
        serverError(res, 'Set member tag', error, 'Failed to update the member tag');
    }
}

/**
 * POST /api/chats/:chatId/leave Body: { newAdminId? }
 * The last admin hands admin to newAdminId, or to the longest-standing member when none is picked.
 */
async function leaveGroup(req, res) {
    try {
        const { chatId } = req.params;
        const userId = req.user.id;

        const result = await groups.leaveGroup(chatId, userId, req.body.newAdminId || null);
        if (result.error) return sendError(res, result.error);

        groups.removeUserFromChatRoom(req.io, userId, chatId);
        groups.emitMembersUpdated(req.io, chatId);
        if (req.io) {
            // The user's other tabs drop the chat
            req.io.to(`user_${userId}`).emit('group_left', { chatId: Number(chatId) });
        }

        res.json({ success: true, data: { chatId: Number(chatId), newAdmin: result.newAdmin } });
    } catch (error) {
        serverError(res, 'Leave group', error, 'Failed to leave the group');
    }
}

/**
 * Extra fields for GET /api/chats/:chatId on group chats
 */
async function getGroupDetailsForMember(chatId, membership) {
    const isAdmin = membership.role === 'admin';
    return {
        my_role: membership.role,
        can_post: !groups.postingError(membership),
        invite_links_enabled: inviteLinksEnabled(),
        pending_request_count: isAdmin ? await groups.countPendingRequests(chatId) : 0
    };
}

module.exports = {
    updateGroupSettings,
    uploadAvatar,
    removeAvatar,
    createInvite,
    listInvites,
    revokeInvite,
    listJoinRequests,
    approveJoinRequest,
    declineJoinRequest,
    setMemberTag,
    leaveGroup,
    getGroupDetailsForMember
};
