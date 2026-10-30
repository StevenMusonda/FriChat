/**
 * Shared list Controller (rules in utils/lists.js; the list_item_* socket events use the same functions)
 */

const lists = require('../utils/lists');

function reply(res, result, status = 200, key = 'list') {
    if (result.error) {
        return res.status(result.error.status || 400).json({
            success: false,
            message: result.error.message,
            code: result.error.code
        });
    }
    return res.status(status).json({ success: true, data: key ? result[key] : null });
}

function failed(res, label, error, message) {
    console.error(`${label} error:`, error);
    res.status(500).json({ success: false, message });
}

/**
 * GET /api/lists?chatId= - the chat's lists with counts
 */
async function listLists(req, res) {
    try {
        reply(res, await lists.listChatLists(req.user.id, req.query.chatId), 200, 'lists');
    } catch (error) {
        failed(res, 'List lists', error, 'Failed to load lists');
    }
}

/**
 * POST /api/lists - Body: { chatId, name }
 */
async function createList(req, res) {
    try {
        reply(res, await lists.createList(req.io, req.user.id, req.body), 201);
    } catch (error) {
        failed(res, 'Create list', error, 'Failed to create the list');
    }
}

/**
 * GET /api/lists/:listId - the list with its items
 */
async function getList(req, res) {
    try {
        reply(res, await lists.getListForMember(req.user.id, req.params.listId));
    } catch (error) {
        failed(res, 'Get list', error, 'Failed to load the list');
    }
}

/**
 * PATCH /api/lists/:listId - Body: { name } (the list's creator or a group admin)
 */
async function renameList(req, res) {
    try {
        reply(res, await lists.renameList(req.io, req.user.id, req.params.listId, req.body.name));
    } catch (error) {
        failed(res, 'Rename list', error, 'Failed to rename the list');
    }
}

/**
 * DELETE /api/lists/:listId (the list's creator or a group admin)
 */
async function deleteList(req, res) {
    try {
        reply(res, await lists.deleteList(req.io, req.user.id, req.params.listId), 200, null);
    } catch (error) {
        failed(res, 'Delete list', error, 'Failed to delete the list');
    }
}

/**
 * POST /api/lists/:listId/items - Body: { text, dueAt? }
 */
async function addItem(req, res) {
    try {
        const { text, dueAt } = req.body;
        reply(res, await lists.addItem(req.io, req.user.id, req.params.listId, { text, dueAt }), 201);
    } catch (error) {
        failed(res, 'Add list item', error, 'Failed to add the item');
    }
}

/**
 * PATCH /api/lists/items/:itemId - Body: any of { text, dueAt (null clears), done }
 */
async function updateItem(req, res) {
    try {
        const { text, dueAt, done } = req.body;
        reply(res, await lists.updateItem(req.io, req.user.id, req.params.itemId, { text, dueAt, done }));
    } catch (error) {
        failed(res, 'Update list item', error, 'Failed to update the item');
    }
}

/**
 * DELETE /api/lists/items/:itemId
 */
async function removeItem(req, res) {
    try {
        reply(res, await lists.removeItem(req.io, req.user.id, req.params.itemId));
    } catch (error) {
        failed(res, 'Remove list item', error, 'Failed to remove the item');
    }
}

module.exports = { listLists, createList, getList, renameList, deleteList, addItem, updateItem, removeItem };
