/**
 * Invite Controller
 * Preview and join a group through an invite link (/join.html?code=<token>).
 * Both need a signed-in user; a link that can't be used reveals nothing about the group.
 */

const { executeQuery, queryOne, insertAndGetId } = require('../config/database');
const { inviteLinksEnabled } = require('../config/groups');
const { toBool } = require('../utils/messageQueries');
const groups = require('../utils/groups');
const invites = require('../utils/invites');

function sendError(res, error) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

/**
 * Where the signed-in user stands with the group: 'member' | 'pending' | 'declined' | 'none'
 */
async function getJoinState(chatId, userId) {
    const member = await queryOne('SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    if (member) return 'member';

    const request = await queryOne('SELECT status FROM chat_join_requests WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    if (request && (request.status === 'pending' || request.status === 'declined')) return request.status;
    return 'none';
}

/**
 * GET /api/invites/:code
 */
async function previewInvite(req, res) {
    try {
        if (!inviteLinksEnabled()) return sendError(res, invites.INVITE_ERRORS.DISABLED);

        const resolved = await invites.resolveInvite(req.params.code);
        if (resolved.error) return sendError(res, resolved.error);

        const chatId = resolved.invite.chat_id;
        const chat = await queryOne(
            'SELECT id, chat_name, description, avatar_url, approve_new_members FROM chats WHERE id = ?',
            [chatId]
        );
        const count = await queryOne('SELECT COUNT(*) AS count FROM group_members WHERE chat_id = ?', [chatId]);

        res.json({
            success: true,
            data: {
                chatId: chat.id,
                chatName: chat.chat_name,
                description: chat.description || null,
                avatarUrl: chat.avatar_url || null,
                memberCount: parseInt(count && count.count) || 0,
                approvalRequired: toBool(chat.approve_new_members),
                joinState: await getJoinState(chatId, req.user.id)
            }
        });
    } catch (error) {
        console.error('Preview invite error:', error);
        res.status(500).json({ success: false, message: 'Failed to load the invite link' });
    }
}

/**
 * POST /api/invites/:code/join
 * Joins straight away, or files a pending request when the group approves new members.
 * Response data.status: 'joined' | 'already_member' | 'pending'
 */
async function joinWithInvite(req, res) {
    try {
        if (!inviteLinksEnabled()) return sendError(res, invites.INVITE_ERRORS.DISABLED);

        const userId = req.user.id;
        const resolved = await invites.resolveInvite(req.params.code);
        if (resolved.error) return sendError(res, resolved.error);

        const invite = resolved.invite;
        const chatId = invite.chat_id;

        // Neither of these uses up the link
        const state = await getJoinState(chatId, userId);
        if (state === 'member') {
            return res.json({ success: true, data: { status: 'already_member', chatId } });
        }
        if (state === 'pending') {
            return res.json({ success: true, data: { status: 'pending', chatId } });
        }

        // Counted before anything is written; if someone else took the last use, say why
        if (!(await invites.consumeInviteUse(invite.id))) {
            const again = await invites.resolveInvite(req.params.code);
            return sendError(res, again.error || invites.INVITE_ERRORS.USED_UP);
        }

        const chat = await queryOne('SELECT chat_name, approve_new_members FROM chats WHERE id = ?', [chatId]);

        if (toBool(chat.approve_new_members)) {
            const requestId = await saveJoinRequest(chatId, userId, invite.id);
            const pendingCount = await groups.countPendingRequests(chatId);
            await groups.emitToAdmins(req.io, chatId, 'join_request_created', {
                chatId,
                chatName: chat.chat_name,
                requestId,
                user: { id: userId, username: req.user.username, fullName: req.user.full_name || null },
                pendingCount
            });
            return res.status(202).json({ success: true, data: { status: 'pending', chatId } });
        }

        let added;
        try {
            added = await groups.addGroupMember(chatId, userId);
        } catch (error) {
            await invites.releaseInviteUse(invite.id);
            throw error;
        }
        if (!added) {
            await invites.releaseInviteUse(invite.id);
            return res.json({ success: true, data: { status: 'already_member', chatId } });
        }

        groups.joinUserToChatRoom(req.io, userId, chatId);
        groups.emitMembersUpdated(req.io, chatId);

        res.status(201).json({ success: true, data: { status: 'joined', chatId } });
    } catch (error) {
        console.error('Join with invite error:', error);
        res.status(500).json({ success: false, message: 'Failed to join the group' });
    }
}

/**
 * New pending request, or a declined one asked again (one row per user and group)
 * @returns {Promise<number>} request id
 */
async function saveJoinRequest(chatId, userId, inviteId) {
    const existing = await queryOne('SELECT id FROM chat_join_requests WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    if (existing) {
        await executeQuery(
            "UPDATE chat_join_requests SET status = 'pending', invite_id = ?, decided_by = NULL, decided_at = NULL, created_at = CURRENT_TIMESTAMP WHERE id = ?",
            [inviteId, existing.id]
        );
        return existing.id;
    }

    try {
        return await insertAndGetId(
            "INSERT INTO chat_join_requests (chat_id, user_id, invite_id, status) VALUES (?, ?, ?, 'pending')",
            [chatId, userId, inviteId]
        );
    } catch (error) {
        if (!groups.isDuplicateKeyError(error)) throw error;
        const row = await queryOne('SELECT id FROM chat_join_requests WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
        return row.id;
    }
}

module.exports = {
    previewInvite,
    joinWithInvite
};
