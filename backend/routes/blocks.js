/**
 * Block routes
 */

const express = require('express');
const router = express.Router();
const blockController = require('../controllers/blockController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validateBlockUser, validateUserIdParam, checkValidation } = require('../utils/validation');

const blockLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many block changes. Please wait a moment.'
});

router.use(blockLimiter);
router.use(authenticateToken);

router.get('/', blockController.listBlocked);
router.post('/', validateBlockUser, checkValidation, blockController.blockUser);
router.delete('/:userId', validateUserIdParam, checkValidation, blockController.unblockUser);

module.exports = router;
