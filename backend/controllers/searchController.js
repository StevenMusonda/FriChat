/**
 * Search Controller
 * Message search (one chat or every chat the user is in) and the shared media panel.
 * Both only ever read chats the user is a member of, and leave out messages deleted
 * for everyone or deleted "for me".
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const {
    HAS_FILTERS,
    MEDIA_TABS,
    parseSearchTerms,
    buildTextCondition,
    buildSnippet,
    extractUrls,
    chatDisplayName
} = require('../utils/messageSearch');

const SEARCH_PAGE_SIZE = 20;
const MEDIA_PAGE_SIZE = 30;

// The joins that make a message visible to the user (the first two placeholders are both the user id)
const VISIBLE_MESSAGE_JOINS = `
    JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
    LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?`;

const VISIBLE_MESSAGE_CONDITIONS = `
    dm.id IS NULL
    AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)`;

async function isChatMember(chatId, userId) {
    const membership = await queryOne(
        'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
        [chatId, userId]
    );
    return !!membership;
}

/**
 * GET /api/messages/search
 * Query: q (text), chatId (only this chat; omit for every chat), senderId, from, to (ISO dates;
 * `to` is exclusive), has (image | video | file | link), before (message id cursor), limit (max 50).
 * Results are newest first; pagination.nextCursor goes back as `before`.
 */
async function searchMessages(req, res) {
    try {
        const userId = req.user.id;
        const { chatId, senderId, from, to, has, before } = req.query;
        const limit = req.query.limit || SEARCH_PAGE_SIZE;
        const terms = parseSearchTerms(req.query.q || '');

        if (terms.length === 0 && !senderId && !from && !to && !has) {
            return res.status(400).json({
                success: false,
                message: 'Type a word to search for, or choose a filter'
            });
        }

        if (chatId && !(await isChatMember(chatId, userId))) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        const params = [userId, userId];
        const conditions = [VISIBLE_MESSAGE_CONDITIONS];
        let hiddenChatsJoin = '';

        if (chatId) {
            conditions.push('m.chat_id = ?');
            params.push(chatId);
        } else {
            // Chats the user removed from their list stay out of global results
            hiddenChatsJoin = 'LEFT JOIN deleted_chats dc ON dc.chat_id = m.chat_id AND dc.user_id = ?';
            params.push(userId);
            conditions.push('dc.id IS NULL');
        }

        const textCondition = buildTextCondition(terms, dbType);
        if (textCondition) {
            conditions.push(textCondition.sql);
            params.push(...textCondition.params);
        }
        if (senderId) {
            conditions.push('m.sender_id = ?');
            params.push(senderId);
        }
        if (from) {
            conditions.push('m.created_at >= ?');
            params.push(from);
        }
        if (to) {
            conditions.push('m.created_at < ?');
            params.push(to);
        }
        if (has) {
            conditions.push(HAS_FILTERS[has]);
        }
        if (before) {
            conditions.push('m.id < ?');
            params.push(before);
        }

        // limit is a validated integer, inlined like getMessages (mysql2 rejects a bound LIMIT on some servers)
        const rows = await executeQuery(`
            SELECT
                m.id,
                m.chat_id,
                m.sender_id,
                u.username,
                u.full_name,
                m.message_type,
                m.content,
                m.created_at,
                f.original_name as file_name,
                c.chat_type,
                c.chat_name,
                (
                    SELECT COALESCE(ou.full_name, ou.username)
                    FROM group_members ogm
                    JOIN users ou ON ou.id = ogm.user_id
                    WHERE ogm.chat_id = c.id AND ogm.user_id <> gm.user_id
                    ORDER BY ogm.id
                    LIMIT 1
                ) as direct_partner_name
            FROM messages m
            ${VISIBLE_MESSAGE_JOINS}
            ${hiddenChatsJoin}
            JOIN chats c ON c.id = m.chat_id
            JOIN users u ON u.id = m.sender_id
            LEFT JOIN files f ON f.id = m.file_id
            WHERE ${conditions.join('\n            AND ')}
            ORDER BY m.id DESC
            LIMIT ${parseInt(limit) + 1}
        `, params);

        const hasMore = rows.length > limit;
        const results = rows.slice(0, limit).map(row => ({
            id: row.id,
            chat_id: row.chat_id,
            chat_type: row.chat_type,
            chat_display_name: chatDisplayName(row),
            sender_id: row.sender_id,
            sender_name: row.full_name || row.username,
            message_type: row.message_type,
            file_name: row.file_name || null,
            created_at: row.created_at,
            snippet: row.message_type === 'text' ? buildSnippet(row.content, terms) : null
        }));

        res.json({
            success: true,
            data: results,
            terms,
            pagination: {
                hasMore,
                nextCursor: hasMore ? results[results.length - 1].id : null
            }
        });
    } catch (error) {
        console.error('Search messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Search failed'
        });
    }
}

/**
 * GET /api/chats/:chatId/media
 * Query: type (media | files | links), before or after (message id cursor), limit (max 60).
 * `before` (or no cursor) pages newest first; `after` pages oldest first (the lightbox uses it
 * to walk forward from a message).
 */
async function getSharedMedia(req, res) {
    try {
        const userId = req.user.id;
        const { chatId } = req.params;
        const type = req.query.type || 'media';
        const limit = req.query.limit || MEDIA_PAGE_SIZE;
        const { before, after } = req.query;

        if (!(await isChatMember(chatId, userId))) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        const params = [userId, userId, chatId];
        let cursorClause = '';
        if (after) {
            cursorClause = 'AND m.id > ?';
            params.push(after);
        } else if (before) {
            cursorClause = 'AND m.id < ?';
            params.push(before);
        }

        const rows = await executeQuery(`
            SELECT
                m.id,
                m.chat_id,
                m.sender_id,
                u.username,
                u.full_name,
                m.message_type,
                m.content,
                m.created_at,
                f.original_name as file_name,
                f.file_size,
                f.mime_type,
                f.upload_path
            FROM messages m
            ${VISIBLE_MESSAGE_JOINS}
            JOIN users u ON u.id = m.sender_id
            LEFT JOIN files f ON f.id = m.file_id
            WHERE m.chat_id = ?
            ${cursorClause}
            AND ${VISIBLE_MESSAGE_CONDITIONS}
            AND ${MEDIA_TABS[type]}
            ORDER BY m.id ${after ? 'ASC' : 'DESC'}
            LIMIT ${parseInt(limit) + 1}
        `, params);

        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const items = [];
        for (const row of page) {
            const item = {
                message_id: row.id,
                chat_id: row.chat_id,
                sender_id: row.sender_id,
                sender_name: row.full_name || row.username,
                message_type: row.message_type,
                created_at: row.created_at
            };
            if (type === 'links') {
                item.urls = extractUrls(row.content);
                // Links only inside `code` don't count
                if (item.urls.length === 0) continue;
                item.snippet = buildSnippet(row.content, []).text;
            } else {
                item.file_name = row.file_name;
                item.file_size = row.file_size;
                item.mime_type = row.mime_type;
                item.upload_path = row.upload_path;
            }
            items.push(item);
        }

        res.json({
            success: true,
            data: items,
            pagination: {
                hasMore,
                // Cursor from the raw page, so skipped rows aren't fetched again
                nextCursor: hasMore ? page[page.length - 1].id : null
            }
        });
    } catch (error) {
        console.error('Shared media error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load shared media'
        });
    }
}

module.exports = {
    searchMessages,
    getSharedMedia
};
