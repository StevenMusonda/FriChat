/**
 * Call Controller (phase 11)
 * ICE servers (with short-lived TURN credentials), the signed-in user's call history and a group
 * chat's running call. Calls themselves are Socket.IO events (utils/calls.js, utils/groupCalls.js).
 */

const { executeQuery, queryOne } = require('../config/database');
const { buildIceServers } = require('../utils/turn');
const { applyUserPrivacy } = require('../utils/privacy');
const { HISTORY_PAGE_SIZE } = require('../config/calls');

/**
 * GET /api/calls/ice-servers
 */
async function getIceServers(req, res) {
    try {
        const { iceServers, ttl, turn } = buildIceServers(req.user.id);
        // Credentials are per user and short-lived: never cache them
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: { iceServers, ttl, turn } });
    } catch (error) {
        console.error('ICE servers error:', error);
        res.status(500).json({ success: false, message: 'Failed to load call settings' });
    }
}

/**
 * GET /api/calls/active?chatId=  the group chat's running call (the banner), or null
 */
async function getActiveCall(req, res) {
    try {
        const chatId = req.query.chatId;
        const member = await queryOne('SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, req.user.id]);
        if (!member) return res.status(403).json({ success: false, message: 'Access denied to this chat' });

        const manager = req.io && req.io.callManager;
        const call = manager ? await manager.activeCallForChat(chatId, req.user.id) : null;
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: call });
    } catch (error) {
        console.error('Active call error:', error);
        res.status(500).json({ success: false, message: 'Failed to load the call' });
    }
}

function placeholders(values) {
    return values.map(() => '?').join(', ');
}

/**
 * Group calls in a page of history: the group's name and photo, who joined, and whether it's running
 */
async function addGroupDetails(req, page) {
    const groupCalls = page.filter(call => call.group);
    if (groupCalls.length === 0) return;

    const chatIds = [...new Set(groupCalls.map(call => call.chatId))];
    const chats = await executeQuery(`SELECT id, chat_name, avatar_url FROM chats WHERE id IN (${placeholders(chatIds)})`, chatIds);
    const chatById = new Map(chats.map(chat => [Number(chat.id), chat]));

    const callIds = groupCalls.map(call => call.id);
    const joined = await executeQuery(`SELECT call_id, user_id FROM call_participants WHERE call_id IN (${placeholders(callIds)})`, callIds);

    const manager = req.io && req.io.callManager;
    for (const call of groupCalls) {
        const chat = chatById.get(call.chatId);
        const people = joined.filter(row => Number(row.call_id) === call.id).map(row => Number(row.user_id));
        call.groupName = chat ? chat.chat_name : null;
        call.groupAvatarUrl = chat ? chat.avatar_url || null : null;
        call.participantCount = people.length;
        call.joined = people.includes(Number(req.user.id));
        call.live = !!manager && manager.isLive(call.id);
    }
}

function toIso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return isNaN(date) ? null : date.toISOString();
}

/**
 * GET /api/calls?limit=&before=  (before: a call id, for the next page)
 */
async function listCalls(req, res) {
    try {
        const userId = req.user.id;
        const limit = req.query.limit || HISTORY_PAGE_SIZE;
        const before = req.query.before || null;

        const params = [userId, userId, userId, userId];
        let cursor = '';
        if (before) {
            cursor = 'AND c.id < ?';
            params.push(before);
        }

        const rows = await executeQuery(`
            SELECT c.id, c.chat_id, c.caller_id, c.callee_id, c.call_type, c.status, c.end_reason,
                   c.started_at, c.answered_at, c.ended_at,
                   u.id AS other_id, u.username AS other_username, u.full_name AS other_full_name, u.avatar_url AS other_avatar_url
            FROM calls c
            JOIN users u ON u.id = CASE WHEN c.caller_id = ? AND c.callee_id IS NOT NULL THEN c.callee_id ELSE c.caller_id END
            WHERE (c.caller_id = ? OR c.callee_id = ? OR c.callee_id IS NULL)
              AND c.chat_id IN (SELECT gm.chat_id FROM group_members gm WHERE gm.user_id = ?)
              ${cursor}
            ORDER BY c.id DESC
            LIMIT ${parseInt(limit, 10) + 1}
        `, params);

        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit).map(row => {
            const answeredAt = toIso(row.answered_at);
            const endedAt = toIso(row.ended_at);
            return {
                id: Number(row.id),
                chatId: Number(row.chat_id),
                type: row.call_type,
                status: row.status,
                endReason: row.end_reason || null,
                group: row.callee_id === null || row.callee_id === undefined,
                direction: Number(row.caller_id) === Number(userId) ? 'outgoing' : 'incoming',
                startedAt: toIso(row.started_at),
                answeredAt,
                endedAt,
                durationSeconds: answeredAt && endedAt
                    ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(answeredAt)) / 1000))
                    : 0,
                otherUser: {
                    id: Number(row.other_id),
                    username: row.other_username,
                    fullName: row.other_full_name || null,
                    avatarUrl: row.other_avatar_url || null
                }
            };
        });

        // Profile photos only where the other person's privacy setting allows
        await addGroupDetails(req, page);

        const people = page.map(call => call.otherUser);
        await applyUserPrivacy(userId, people, { avatar: 'avatarUrl', status: null, customStatus: null });

        res.json({
            success: true,
            data: page,
            pagination: { hasMore, nextBefore: hasMore && page.length > 0 ? page[page.length - 1].id : null }
        });
    } catch (error) {
        console.error('List calls error:', error);
        res.status(500).json({ success: false, message: 'Failed to load calls' });
    }
}

module.exports = { getIceServers, getActiveCall, listCalls };
