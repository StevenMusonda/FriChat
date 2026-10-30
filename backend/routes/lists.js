/**
 * Shared list routes (phase 12). Item changes also work over Socket.IO
 * (list_item_add, list_item_update, list_item_remove).
 */

const express = require('express');
const router = express.Router();
const listController = require('../controllers/listController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateCreateList,
    validateListIdParam,
    validateRenameList,
    validateListsQuery,
    validateAddListItem,
    validateListItemIdParam,
    validateUpdateListItem,
    checkValidation
} = require('../utils/validation');

// A new list posts a notice to the chat
const listCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many new lists. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

// Ticking through a shopping list is quick work
const listActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many list changes. Please slow down.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);

router.get('/', listActionLimiter, validateListsQuery, checkValidation, listController.listLists);
router.post('/', listCreateLimiter, validateCreateList, checkValidation, listController.createList);
router.patch('/items/:itemId', listActionLimiter, validateUpdateListItem, checkValidation, listController.updateItem);
router.delete('/items/:itemId', listActionLimiter, validateListItemIdParam, checkValidation, listController.removeItem);
router.get('/:listId', listActionLimiter, validateListIdParam, checkValidation, listController.getList);
router.patch('/:listId', listActionLimiter, validateRenameList, checkValidation, listController.renameList);
router.delete('/:listId', listActionLimiter, validateListIdParam, checkValidation, listController.deleteList);
router.post('/:listId/items', listActionLimiter, validateAddListItem, checkValidation, listController.addItem);

module.exports = router;
