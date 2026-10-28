/**
 * Invite Controller
 * Preview and join a group through an invite link (/join.html?code=<token>).
 * Both need a signed-in user; a link that can't be used reveals nothing about the group.
 */

const { executeQuery, queryOne, insertAndGetId } = require('../config/database');
const { inviteLinksEnabled, MAX_PENDING_JOIN_REQUESTS, JOIN_REQUEST_COOLDOWN_HOURS } = require('../config/groups');
const { toBool } = require('../utils/messageQueries');
const groups = require('../utils/groups');
const invites = require('../utils/invites');
const { requireVerifiedEmail } = require('../utils/emailVerification');
const { findBlockersAmong } = require('../utils/blocks');

const TOO_MANY_PENDING = {
    status: 429,
    code: 'TOO_MANY_PENDING',
    message: `You already have ${MAX_PENDING_JOIN_REQUESTS} join requests waiting for an admin. Wait for one to be answered before asking to join another group.`
};
const DECLINED_RECENTLY = {
    status: 429,
    code: 'DECLINED_RECENTLY',
    message: `An admin declined your request to join this group. You can ask again ${JOIN_REQUEST_COOLDOWN_HOURS} hours after it was declined.`
};

// Fixed SQL snippet; the number of hours is a parameter
function cooldownStartSql() {
    return process.env.DB_TYPE === 'postgresql'
        ? "CURRENT_TIMESTAMP - CAST(? AS INTEGER) * INTERVAL '1 hour'"
        : 'DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? HOUR)';
}

function sendError(res, error) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

/**
 * Where the signed-in user stands with the group.
 * @returns {{ state: 'member' | 'banned' | 'pending' | 'declined' | 'none', inCooldown: boolean }}
 * inCooldown: declined less than JOIN_REQUEST_COOLDOWN_HOURS ago
 */
async function getJoinState(chatId, userId) {
    const member = await queryOne('SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    if (member) return { state: 'member', inCooldown: false };

    if (await groups.isBanned(chatId, userId)) return { state: 'banned', inCooldown: false };

    const request = await queryOne(
        `SELECT status, CASE WHEN decided_at IS NOT NULL AND decided_at > ${cooldownStartSql()} THEN 1 ELSE 0 END AS in_cooldown
         FROM chat_join_requests WHERE chat_id = ? AND user_id = ?`,
        [JOIN_REQUEST_COOLDOWN_HOURS, chatId, userId]
    );
    if (request && (request.status === 'pending' || request.status === 'declined')) {
        return { state: request.status, inCooldown: request.status === 'declined' && toBool(request.in_cooldown) };
    }
    return { state: 'none', inCooldown: false };
}

async function countPendingRequestsByUser(userId) {
    const row = await queryOne(
        "SELECT COUNT(*) AS count FROM chat_join_requests WHERE user_id = ? AND status = 'pending'",
        [userId]
    );
    return row ? parseInt(row.count) || 0 : 0;
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
        const joinState = await getJoinState(chatId, req.user.id);

        res.json({
            success: true,
            data: {
                chatId: chat.id,
                chatName: chat.chat_name,
                description: chat.description || null,
                avatarUrl: chat.avatar_url || null,
                memberCount: parseInt(count && count.count) || 0,
                approvalRequired: toBool(chat.approve_new_members),
                joinState: joinState.state,
                canRequestAgain: joinState.state !== 'declined' || !joinState.inCooldown,
                emailVerified: !requireVerifiedEmail(req.user)
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

        // Strangers reach members through links, so only verified accounts can use them
        const notVerified = requireVerifiedEmail(req.user, 'join groups by link');
        if (notVerified) return sendError(res, notVerified);

        const userId = req.user.id;
        const resolved = await invites.resolveInvite(req.params.code);
        if (resolved.error) return sendError(res, resolved.error);

        const invite = resolved.invite;
        const chatId = invite.chat_id;

        // None of these use up the link
        const { state, inCooldown } = await getJoinState(chatId, userId);
        if (state === 'member') {
            return res.json({ success: true, data: { status: 'already_member', chatId } });
        }
        if (state === 'banned') {
            return sendError(res, groups.BANNED_ERROR);
        }
        if (state === 'pending') {
            return res.json({ success: true, data: { status: 'pending', chatId } });
        }

        const chat = await queryOne('SELECT chat_name, approve_new_members FROM chats WHERE id = ?', [chatId]);
        const approvalRequired = toBool(chat.approve_new_members);

        if (approvalRequired) {
            if (state === 'declined' && inCooldown) return sendError(res, DECLINED_RECENTLY);
            if ((await countPendingRequestsByUser(userId)) >= MAX_PENDING_JOIN_REQUESTS) return sendError(res, TOO_MANY_PENDING);
        }

        // Counted before anything is written; if someone else took the last use, say why
        if (!(await invites.consumeInviteUse(invite.id))) {
            const again = await invites.resolveInvite(req.params.code);
            return sendError(res, again.error || invites.INVITE_ERRORS.USED_UP);
        }

        if (approvalRequired) {
            const requestId = await saveJoinRequest(chatId, userId, invite.id);
            const pendingCount = await groups.countPendingRequests(chatId);
            // Admins who blocked the requester aren't told about them
            const blockers = await findBlockersAmong(userId, await groups.getAdminIds(chatId));
            await groups.emitToAdmins(req.io, chatId, 'join_request_created', {
                chatId,
                chatName: chat.chat_name,
                requestId,
                user: { id: userId, username: req.user.username, fullName: req.user.full_name || null },
                pendingCount
            }, blockers);
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
