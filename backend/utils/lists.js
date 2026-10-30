/**
 * Shared lists (phase 12): named checklists in a chat (chat_lists) and their items (chat_list_items).
 * Shared by the REST controller and the list_item_* socket events, which take the same raw input,
 * so every rule (members only, lengths, limits, due times) is checked here.
 *
 * Every member can add, tick, edit and remove items; renaming or deleting a whole list is for the
 * person who made it (and group admins). Each change sends the whole list to the chat room
 * (list_updated), so open clients just replace what they show. Ticking records who did it; ticking
 * an item that's already ticked keeps the first person's name.
 *
 * Due dates: whoever sets one gets a reminder when it comes due (if the item isn't done by then).
 * The scheduler claims the item (pending -> fired) before sending, so it fires once.
 */

const { executeQuery, queryOne, insertAndGetId, updateAndCount } = require('../config/database');
const { stripControlChars } = require('./messageText');
const { toBool } = require('./messageQueries');
const { checkCanPost, getMembership } = require('./groups');
const { deliverNewMessage } = require('./messageDelivery');
const { notifyUser } = require('./push');
const { plusSecondsSql, secondsUntilSql, isoFromSecondsUntil, secondsFromNow } = require('./timeSql');
const {
    LIST_NAME_MAX_LENGTH,
    LIST_ITEM_MAX_LENGTH,
    MAX_LISTS_PER_CHAT,
    MAX_ITEMS_PER_LIST,
    PLAN_BATCH_SIZE
} = require('../config/planning');

const NOTICE_CREATED = 'list_created:';
const NOTICE_PATTERN = /^list_created:(\d+)$/;

// ===== Input =====

/**
 * One line of text, required, at most `max` characters
 * @returns {{ ok: true, text } | { ok: false, error }}
 */
function cleanLine(value, max, label) {
    if (typeof value !== 'string') return { ok: false, error: `${label} must be text` };
    const text = stripControlChars(value).replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, error: `${label} cannot be empty` };
    if (text.length > max) return { ok: false, error: `${label} must be at most ${max} characters` };
    return { ok: true, text };
}

/**
 * dueAt from a client: undefined = unchanged, null/'' = no due date, else a future ISO time
 * @returns {{ ok: true, seconds: number|null|undefined } | { ok: false, error }}
 */
function parseDue(dueAt) {
    if (dueAt === undefined) return { ok: true, seconds: undefined };
    if (dueAt === null || dueAt === '') return { ok: true, seconds: null };
    const parsed = secondsFromNow(dueAt);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, seconds: parsed.seconds };
}

function toId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

// ===== Reading =====

/**
 * The list, if the user is a member of its chat (with their role and the chat type)
 */
async function findListForMember(listId, userId) {
    return queryOne(`
        SELECT l.id, l.chat_id, l.created_by, l.name, gm.role, c.chat_type
        FROM chat_lists l
        JOIN group_members gm ON gm.chat_id = l.chat_id AND gm.user_id = ?
        JOIN chats c ON c.id = l.chat_id
        WHERE l.id = ?
    `, [userId, listId]);
}

/**
 * The item, if the user is a member of its chat
 */
async function findItemForMember(itemId, userId) {
    return queryOne(`
        SELECT i.id, i.list_id, i.chat_id, i.done
        FROM chat_list_items i
        JOIN group_members gm ON gm.chat_id = i.chat_id AND gm.user_id = ?
        WHERE i.id = ?
    `, [userId, itemId]);
}

function personName(username, fullName) {
    return fullName || username || null;
}

function shapeItem(row, now = Date.now()) {
    const done = toBool(row.done);
    return {
        id: Number(row.id),
        listId: Number(row.list_id),
        text: row.text,
        done,
        doneBy: done && row.done_by ? { userId: Number(row.done_by), name: personName(row.done_username, row.done_full_name) } : null,
        doneAt: done ? isoFromSecondsUntil(row.done_in, now) : null,
        dueAt: isoFromSecondsUntil(row.due_in, now),
        createdBy: row.created_by ? { userId: Number(row.created_by), name: personName(row.creator_username, row.creator_full_name) } : null
    };
}

function shapeListSummary(row) {
    return {
        id: Number(row.id),
        chatId: Number(row.chat_id),
        name: row.name,
        createdBy: Number(row.created_by),
        createdByName: personName(row.creator_username, row.creator_full_name),
        counts: {
            total: parseInt(row.item_count) || 0,
            done: parseInt(row.done_count) || 0
        }
    };
}

/**
 * The whole list with its items (oldest first; clients split them into open and completed)
 */
async function loadList(listId) {
    const list = await queryOne(`
        SELECT l.id, l.chat_id, l.created_by, l.name, u.username AS creator_username, u.full_name AS creator_full_name
        FROM chat_lists l
        JOIN users u ON u.id = l.created_by
        WHERE l.id = ?
    `, [listId]);
    if (!list) return null;

    const rows = await executeQuery(`
        SELECT i.id, i.list_id, i.text, i.done, i.created_by, i.done_by,
               ${secondsUntilSql('i.done_at')} AS done_in,
               ${secondsUntilSql('i.due_at')} AS due_in,
               cu.username AS creator_username, cu.full_name AS creator_full_name,
               du.username AS done_username, du.full_name AS done_full_name
        FROM chat_list_items i
        LEFT JOIN users cu ON cu.id = i.created_by
        LEFT JOIN users du ON du.id = i.done_by
        WHERE i.list_id = ?
        ORDER BY i.id
    `, [listId]);

    const now = Date.now();
    const items = rows.map(row => shapeItem(row, now));
    return {
        ...shapeListSummary({ ...list, item_count: items.length, done_count: items.filter(i => i.done).length }),
        items
    };
}

/**
 * The chat's lists with counts (no items; GET /api/lists/:id has those)
 */
async function listChatLists(userId, chatId) {
    const membership = await getMembership(chatId, userId);
    if (!membership) return { error: { status: 403, message: 'Access denied to this chat' } };
    const rows = await executeQuery(`
        SELECT l.id, l.chat_id, l.created_by, l.name, u.username AS creator_username, u.full_name AS creator_full_name,
               (SELECT COUNT(*) FROM chat_list_items ci WHERE ci.list_id = l.id) AS item_count,
               (SELECT COUNT(*) FROM chat_list_items cd WHERE cd.list_id = l.id AND cd.done = TRUE) AS done_count
        FROM chat_lists l
        JOIN users u ON u.id = l.created_by
        WHERE l.chat_id = ?
        ORDER BY l.id
    `, [chatId]);
    return { lists: rows.map(shapeListSummary) };
}

async function getListForMember(userId, listId) {
    const found = await findListForMember(listId, userId);
    if (!found) return { error: { status: 404, message: 'List not found' } };
    return { list: await loadList(listId) };
}

/**
 * Put `list_ref` ({ id, name }) on "list created" notices; null once the list is deleted
 */
async function attachListRefs(messages) {
    const notices = messages.filter(m => m && m.message_type === 'system' && NOTICE_PATTERN.test(String(m.content || '')));
    if (notices.length === 0) return messages;
    const ids = [...new Set(notices.map(m => Number(NOTICE_PATTERN.exec(m.content)[1])))];
    const rows = await executeQuery(
        `SELECT id, chat_id, name FROM chat_lists WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids
    );
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    for (const message of notices) {
        const row = byId.get(Number(NOTICE_PATTERN.exec(message.content)[1]));
        message.list_ref = row && Number(row.chat_id) === Number(message.chat_id) ? { id: Number(row.id), name: row.name } : null;
    }
    return messages;
}

/**
 * Send the list's new state to everyone in the chat
 */
async function broadcastList(io, listId) {
    const list = await loadList(listId);
    if (list && io) io.to(`chat_${list.chatId}`).emit('list_updated', list);
    return list;
}

// ===== Lists =====

/**
 * Who may rename or delete a list: the person who made it, or an admin of the group
 */
function canManage(found, userId) {
    return Number(found.created_by) === Number(userId) || (found.chat_type === 'group' && found.role === 'admin');
}

async function createList(io, userId, input) {
    const chatId = toId(input && input.chatId);
    if (!chatId) return { error: { status: 400, message: 'Invalid chat' } };
    const name = cleanLine(input.name, LIST_NAME_MAX_LENGTH, 'The list name');
    if (!name.ok) return { error: { status: 400, message: name.error } };

    // Creating a list is announced in the chat, so it follows the posting rules
    const postError = await checkCanPost(chatId, userId);
    if (postError) return { error: postError };

    const count = await queryOne('SELECT COUNT(*) AS count FROM chat_lists WHERE chat_id = ?', [chatId]);
    if (count && parseInt(count.count) >= MAX_LISTS_PER_CHAT) {
        return { error: { status: 409, message: `A chat can have up to ${MAX_LISTS_PER_CHAT} lists` } };
    }

    const listId = await insertAndGetId(
        'INSERT INTO chat_lists (chat_id, created_by, name, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        [chatId, userId, name.text]
    );

    await deliverNewMessage(io, {
        chatId,
        senderId: userId,
        messageType: 'system',
        content: `${NOTICE_CREATED}${Number(listId)}`,
        decorate: (msg) => attachListRefs([msg])
    });
    const list = await broadcastList(io, listId);
    return { list };
}

async function renameList(io, userId, listId, nameInput) {
    const found = await findListForMember(listId, userId);
    if (!found) return { error: { status: 404, message: 'List not found' } };
    if (!canManage(found, userId)) {
        return { error: { status: 403, message: 'Only the person who made this list or a group admin can rename it' } };
    }
    const name = cleanLine(nameInput, LIST_NAME_MAX_LENGTH, 'The list name');
    if (!name.ok) return { error: { status: 400, message: name.error } };

    await executeQuery('UPDATE chat_lists SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name.text, listId]);
    return { list: await broadcastList(io, listId) };
}

async function deleteList(io, userId, listId) {
    const found = await findListForMember(listId, userId);
    if (!found) return { error: { status: 404, message: 'List not found' } };
    if (!canManage(found, userId)) {
        return { error: { status: 403, message: 'Only the person who made this list or a group admin can delete it' } };
    }
    await executeQuery('DELETE FROM chat_lists WHERE id = ?', [listId]);
    if (io) io.to(`chat_${found.chat_id}`).emit('list_deleted', { listId: Number(listId), chatId: Number(found.chat_id) });
    return { deleted: true };
}

// ===== Items =====

/**
 * @param {Object} input - { text, dueAt? (ISO with offset) }
 */
async function addItem(io, userId, listId, input = {}) {
    listId = toId(listId);
    if (!listId) return { error: { status: 400, message: 'Invalid list' } };
    const text = cleanLine(input.text, LIST_ITEM_MAX_LENGTH, 'The item');
    if (!text.ok) return { error: { status: 400, message: text.error } };
    const due = parseDue(input.dueAt);
    if (!due.ok) return { error: { status: 400, message: due.error } };

    const found = await findListForMember(listId, userId);
    if (!found) return { error: { status: 404, message: 'List not found' } };

    const count = await queryOne('SELECT COUNT(*) AS count FROM chat_list_items WHERE list_id = ?', [listId]);
    if (count && parseInt(count.count) >= MAX_ITEMS_PER_LIST) {
        return { error: { status: 409, message: `A list can have up to ${MAX_ITEMS_PER_LIST} items` } };
    }

    if (due.seconds) {
        await insertAndGetId(
            `INSERT INTO chat_list_items (list_id, chat_id, text, created_by, due_at, due_set_by, due_reminder_status, updated_at) VALUES (?, ?, ?, ?, ${plusSecondsSql()}, ?, 'pending', CURRENT_TIMESTAMP)`,
            [listId, found.chat_id, text.text, userId, due.seconds, userId]
        );
    } else {
        await insertAndGetId(
            'INSERT INTO chat_list_items (list_id, chat_id, text, created_by, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [listId, found.chat_id, text.text, userId]
        );
    }
    await executeQuery('UPDATE chat_lists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [listId]);
    return { list: await broadcastList(io, listId) };
}

/**
 * Edit the text, set/clear the due date and/or tick/untick an item
 * @param {Object} changes - { text?, dueAt? (null clears), done? (boolean) }
 */
async function updateItem(io, userId, itemId, changes = {}) {
    itemId = toId(itemId);
    if (!itemId) return { error: { status: 400, message: 'Invalid item' } };
    if (!changes || typeof changes !== 'object') return { error: { status: 400, message: 'Nothing to change' } };

    let text = null;
    if (changes.text !== undefined) {
        text = cleanLine(changes.text, LIST_ITEM_MAX_LENGTH, 'The item');
        if (!text.ok) return { error: { status: 400, message: text.error } };
    }
    const due = parseDue(changes.dueAt);
    if (!due.ok) return { error: { status: 400, message: due.error } };
    if (changes.done !== undefined && typeof changes.done !== 'boolean') {
        return { error: { status: 400, message: 'done must be true or false' } };
    }
    if (text === null && due.seconds === undefined && changes.done === undefined) {
        return { error: { status: 400, message: 'Nothing to change' } };
    }

    const found = await findItemForMember(itemId, userId);
    if (!found) return { error: { status: 404, message: 'Item not found' } };

    if (text) {
        await executeQuery('UPDATE chat_list_items SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [text.text, itemId]);
    }
    if (due.seconds === null) {
        await executeQuery(
            "UPDATE chat_list_items SET due_at = NULL, due_set_by = NULL, due_reminder_status = 'none', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [itemId]
        );
    } else if (due.seconds !== undefined) {
        await executeQuery(
            `UPDATE chat_list_items SET due_at = ${plusSecondsSql()}, due_set_by = ?, due_reminder_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [due.seconds, userId, itemId]
        );
    }
    if (changes.done === true) {
        // Only an open item: whoever ticked it first keeps the credit
        await executeQuery(
            'UPDATE chat_list_items SET done = TRUE, done_by = ?, done_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND done = FALSE',
            [userId, itemId]
        );
    } else if (changes.done === false) {
        await executeQuery(
            'UPDATE chat_list_items SET done = FALSE, done_by = NULL, done_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND done = TRUE',
            [itemId]
        );
    }
    return { list: await broadcastList(io, found.list_id) };
}

async function removeItem(io, userId, itemId) {
    itemId = toId(itemId);
    if (!itemId) return { error: { status: 400, message: 'Invalid item' } };
    const found = await findItemForMember(itemId, userId);
    if (!found) return { error: { status: 404, message: 'Item not found' } };
    await executeQuery('DELETE FROM chat_list_items WHERE id = ?', [itemId]);
    return { list: await broadcastList(io, found.list_id) };
}

// ===== Due-date reminders =====

/**
 * Scheduler tick: remind whoever set the due date of each item that came due and isn't done
 * @returns {Promise<{ fired: number, skipped: number }>}
 */
async function fireDueListItems(io) {
    const result = { fired: 0, skipped: 0 };
    const due = await executeQuery(
        `SELECT id FROM chat_list_items WHERE due_reminder_status = 'pending' AND due_at <= CURRENT_TIMESTAMP ORDER BY due_at, id LIMIT ${parseInt(PLAN_BATCH_SIZE)}`
    );

    for (const { id } of due) {
        const claimed = await updateAndCount(
            "UPDATE chat_list_items SET due_reminder_status = 'fired' WHERE id = ? AND due_reminder_status = 'pending'",
            [id]
        );
        if (!claimed) continue;

        // Still open, and the person who set the date is still in the chat
        const row = await queryOne(`
            SELECT i.id, i.list_id, i.chat_id, i.text, i.done, i.due_set_by, l.name AS list_name, gm.id AS membership_id
            FROM chat_list_items i
            JOIN chat_lists l ON l.id = i.list_id
            LEFT JOIN group_members gm ON gm.chat_id = i.chat_id AND gm.user_id = i.due_set_by
            WHERE i.id = ?
        `, [id]);
        if (!row || toBool(row.done) || !row.due_set_by || !row.membership_id) {
            result.skipped++;
            continue;
        }

        const payload = {
            itemId: Number(row.id),
            listId: Number(row.list_id),
            chatId: Number(row.chat_id),
            listName: row.list_name,
            text: row.text
        };
        if (io) io.to(`user_${row.due_set_by}`).emit('list_item_due', payload);
        notifyUser(io, row.due_set_by, {
            type: 'list_item_due',
            chatId: payload.chatId,
            title: `✅ Due: ${row.list_name}`,
            body: row.text,
            url: `chat.html?chat=${payload.chatId}`,
            tag: `list-item-${payload.itemId}`
        });
        result.fired++;
    }
    return result;
}

module.exports = {
    NOTICE_PATTERN,
    cleanLine,
    parseDue,
    findListForMember,
    findItemForMember,
    loadList,
    listChatLists,
    getListForMember,
    attachListRefs,
    createList,
    renameList,
    deleteList,
    addItem,
    updateItem,
    removeItem,
    fireDueListItems
};
