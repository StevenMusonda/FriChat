/**
 * Block Controller
 * List, block and unblock users. What a block prevents is enforced where each action happens
 * (utils/blocks.js is used by the chat, message, reaction, push, mention and socket code).
 */

const { queryOne } = require('../config/database');
const blocks = require('../utils/blocks');
const { applyUserPrivacy } = require('../utils/privacy');

/**
 * Presence as the other user should now see it (online status is hidden from people you block)
 */
async function emitPresenceChange(io, blockerId, blockedId, nowBlocked) {
    if (!io) return;
    let status = null;
    if (!nowBlocked) {
        // ...and only if the blocker's "Last seen and online" setting lets the other user see it
        const row = await queryOne('SELECT status FROM users WHERE id = ?', [blockerId]);
        const current = { id: Number(blockerId), status: row && row.status === 'online' ? 'online' : 'offline' };
        const [visible] = await applyUserPrivacy(blockedId, [current], { customStatus: null, avatar: null });
        status = visible.status;
    }
    io.to(`user_${blockedId}`).emit('user_status', { userId: Number(blockerId), status });
}

/**
 * GET /api/blocks
 */
async function listBlocked(req, res) {
    try {
        const list = await blocks.listBlockedUsers(req.user.id);
        await applyUserPrivacy(req.user.id, list, { avatar: 'avatarUrl', status: null, customStatus: null });
        res.json({ success: true, data: list });
    } catch (error) {
        console.error('List blocked users error:', error);
        res.status(500).json({ success: false, message: 'Failed to load blocked users' });
    }
}

/**
 * POST /api/blocks Body: { userId }
 */
async function blockUser(req, res) {
    try {
        const blockerId = req.user.id;
        const blockedId = Number(req.body.userId);

        if (blockedId === Number(blockerId)) {
            return res.status(400).json({ success: false, message: 'You can\'t block yourself' });
        }

        const target = await queryOne('SELECT id, username FROM users WHERE id = ?', [blockedId]);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const created = await blocks.blockUser(blockerId, blockedId);
        if (created) {
            await emitPresenceChange(req.io, blockerId, blockedId, true);
            // The blocker's other tabs update their menus and blocked list
            if (req.io) req.io.to(`user_${blockerId}`).emit('block_updated', { userId: blockedId, blocked: true });
        }

        res.status(created ? 201 : 200).json({
            success: true,
            message: `@${target.username} is blocked`,
            data: { userId: blockedId, blocked: true }
        });
    } catch (error) {
        console.error('Block user error:', error);
        res.status(500).json({ success: false, message: 'Failed to block the user' });
    }
}

/**
 * DELETE /api/blocks/:userId
 */
async function unblockUser(req, res) {
    try {
        const blockerId = req.user.id;
        const blockedId = Number(req.params.userId);

        const removed = await blocks.unblockUser(blockerId, blockedId);
        if (!removed) {
            return res.status(404).json({ success: false, message: 'That user is not blocked' });
        }

        await emitPresenceChange(req.io, blockerId, blockedId, false);
        if (req.io) req.io.to(`user_${blockerId}`).emit('block_updated', { userId: blockedId, blocked: false });

        res.json({ success: true, message: 'User unblocked', data: { userId: blockedId, blocked: false } });
    } catch (error) {
        console.error('Unblock user error:', error);
        res.status(500).json({ success: false, message: 'Failed to unblock the user' });
    }
}

module.exports = { listBlocked, blockUser, unblockUser, emitPresenceChange };
