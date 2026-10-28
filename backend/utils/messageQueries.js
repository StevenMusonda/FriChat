/**
 * Shared message SELECT: the columns every client-facing message carries,
 * including the quoted original for replies, plus the reply checks used by every send path
 */

const { queryOne, dbType } = require('../config/database');
const { EDIT_WINDOW_MINUTES, REPLY_SNIPPET_LENGTH } = require('../config/messages');
const { attachMentions } = require('./mentions');

// Select list for `FROM messages m ${MESSAGE_JOINS}`
const MESSAGE_COLUMNS = `
    m.id,
    m.chat_id,
    m.sender_id,
    u.username,
    u.full_name,
    u.avatar_url,
    m.message_type,
    m.content,
    m.file_id,
    f.original_name as file_name,
    f.file_type,
    f.file_size,
    f.mime_type,
    f.upload_path,
    m.status,
    m.created_at,
    m.edited_at,
    m.is_forwarded,
    m.reply_to_message_id,
    rm.sender_id as reply_sender_id,
    ru.username as reply_username,
    ru.full_name as reply_full_name,
    rm.message_type as reply_message_type,
    rm.content as reply_content,
    rf.original_name as reply_file_name,
    rm.deleted_for_everyone as reply_deleted,
    lp.url as link_preview_url,
    lp.title as link_preview_title,
    lp.description as link_preview_description,
    lp.image_url as link_preview_image_url,
    lp.site_name as link_preview_site_name`;

const MESSAGE_JOINS = `
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN files f ON m.file_id = f.id
    LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = rm.sender_id
    LEFT JOIN files rf ON rf.id = rm.file_id
    LEFT JOIN link_previews lp ON lp.id = m.link_preview_id AND lp.status = 'ok'`;

// MySQL returns 0/1 (sometimes as strings), PostgreSQL true/false
function toBool(value) {
    return value === true || value === 1 || value === '1';
}

/**
 * Turn the flat reply_* columns into `reply_to` (null for non-replies) and normalize flags.
 * A deleted original keeps the quote block but drops its content.
 */
function shapeMessage(row) {
    if (!row) return row;

    if (row.reply_to_message_id) {
        const deleted = toBool(row.reply_deleted) || !row.reply_message_type;
        let snippet = null;
        if (!deleted && row.reply_message_type === 'text' && row.reply_content) {
            const text = String(row.reply_content).replace(/\s+/g, ' ').trim();
            snippet = text.length > REPLY_SNIPPET_LENGTH ? `${text.slice(0, REPLY_SNIPPET_LENGTH - 1)}…` : text;
        }

        row.reply_to = {
            id: row.reply_to_message_id,
            deleted: deleted,
            sender_id: deleted ? null : row.reply_sender_id,
            sender_name: deleted ? null : (row.reply_full_name || row.reply_username),
            message_type: deleted ? null : row.reply_message_type,
            snippet: snippet,
            file_name: deleted ? null : (row.reply_file_name || null)
        };
    } else {
        row.reply_to = null;
    }

    for (const key of ['reply_sender_id', 'reply_username', 'reply_full_name', 'reply_message_type', 'reply_content', 'reply_file_name', 'reply_deleted']) {
        delete row[key];
    }

    // Server-fetched preview card (utils/linkPreview.js); null when none or dismissed
    row.link_preview = row.link_preview_url ? {
        url: row.link_preview_url,
        title: row.link_preview_title || null,
        description: row.link_preview_description || null,
        image_url: row.link_preview_image_url || null,
        site_name: row.link_preview_site_name || null
    } : null;
    for (const key of ['link_preview_url', 'link_preview_title', 'link_preview_description', 'link_preview_image_url', 'link_preview_site_name']) {
        delete row[key];
    }

    row.is_forwarded = toBool(row.is_forwarded);
    if ('is_starred' in row) row.is_starred = toBool(row.is_starred);
    return row;
}

/**
 * One message in the shape clients render (used after every insert/forward)
 */
async function getMessageById(messageId) {
    const row = await queryOne(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        ${MESSAGE_JOINS}
        WHERE m.id = ?
    `, [messageId]);
    if (!row) return row;
    const message = shapeMessage(row);
    await attachMentions([message]);
    return message;
}

/**
 * Check that a reply target exists in the same chat and wasn't deleted for everyone.
 * Returns an error message, or null when it's fine.
 */
async function checkReplyTarget(chatId, replyToMessageId) {
    const target = await queryOne(
        'SELECT id, deleted_for_everyone FROM messages WHERE id = ? AND chat_id = ?',
        [replyToMessageId, chatId]
    );
    if (!target) return 'The message you replied to is not in this chat';
    if (toBool(target.deleted_for_everyone)) return 'You cannot reply to a deleted message';
    return null;
}

/**
 * SQL for "sent within the edit window" (the minutes are a constant, never user input)
 */
function editWindowCondition(column = 'm.created_at') {
    const minutes = parseInt(EDIT_WINDOW_MINUTES);
    return dbType === 'postgresql'
        ? `${column} > CURRENT_TIMESTAMP - INTERVAL '${minutes} minutes'`
        : `${column} > CURRENT_TIMESTAMP - INTERVAL ${minutes} MINUTE`;
}

module.exports = {
    MESSAGE_COLUMNS,
    MESSAGE_JOINS,
    toBool,
    shapeMessage,
    getMessageById,
    checkReplyTarget,
    editWindowCondition
};
