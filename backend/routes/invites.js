/**
 * Invite link routes (preview and join). Creating, listing and revoking links are group routes in chats.js.
 */

const express = require('express');
const router = express.Router();
const inviteController = require('../controllers/inviteController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validateInviteCode, checkValidation } = require('../utils/validation');

// Slows down anyone guessing codes (a 128-bit code can't be guessed, but every lookup costs a query)
const inviteLookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many invite link requests. Please wait a moment.'
});

router.use(inviteLookupLimiter);
router.use(authenticateToken);

router.get('/:code', validateInviteCode, checkValidation, inviteController.previewInvite);
router.post('/:code/join', validateInviteCode, checkValidation, inviteController.joinWithInvite);

module.exports = router;
