/**
 * Chat Routes
 */

const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const groupController = require('../controllers/groupController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { uploadGroupAvatar, handleAvatarUploadError } = require('../middleware/groupAvatarUpload');
const {
    validateCreateChat,
    validateMentionsOnly,
    validateChatIdParam,
    validateGroupSettings,
    validateCreateInvite,
    validateInviteIdParam,
    validateJoinRequestParam,
    validateMemberTag,
    validateLeaveGroup,
    validateAddMember,
    validateRemoveMember,
    validateMemberRole,
    validateChatUserParams,
    checkValidation
} = require('../utils/validation');

// Per-chat notification settings
const chatSettingsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many setting changes. Please wait a moment.'
});

// Group settings, invite links, join requests, member tags and leaving
const groupActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many group changes. Please wait a moment.'
});

// Avatars are decoded and resized, so they get a tighter budget (checked before multer reads the body)
const groupAvatarLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many avatar uploads. Please wait a moment.'
});

// All routes require authentication
router.use(authenticateToken);

// Chat routes
router.get('/', chatController.getUserChats);
router.get('/:chatId', chatController.getChatById);
router.post('/', validateCreateChat, checkValidation, chatController.createChat);

// Group management (DELETE ...?ban=true is "Remove and ban")
router.post('/:chatId/members', groupActionLimiter, validateAddMember, checkValidation, chatController.addMember);
router.delete('/:chatId/members/:userId', groupActionLimiter, validateRemoveMember, checkValidation, chatController.removeMember);

// Make a member an admin or remove admin rights (admins; a group always keeps one admin)
router.put('/:chatId/members/:userId/role', groupActionLimiter, validateMemberRole, checkValidation, groupController.setMemberRole);

// Banned users (admins)
router.get('/:chatId/bans', groupActionLimiter, validateChatIdParam, checkValidation, groupController.listBans);
router.delete('/:chatId/bans/:userId', groupActionLimiter, validateChatUserParams, checkValidation, groupController.unbanMember);

// Group profile and settings (admins; GET /:chatId returns them to every member)
router.patch('/:chatId/settings', groupActionLimiter, validateGroupSettings, checkValidation, groupController.updateGroupSettings);
router.post('/:chatId/avatar', groupAvatarLimiter, validateChatIdParam, checkValidation, uploadGroupAvatar, handleAvatarUploadError, groupController.uploadAvatar);
router.delete('/:chatId/avatar', groupAvatarLimiter, validateChatIdParam, checkValidation, groupController.removeAvatar);

// Invite links (admins; ENABLE_INVITE_LINKS=false switches create and list off)
router.post('/:chatId/invites', groupActionLimiter, validateCreateInvite, checkValidation, groupController.createInvite);
router.get('/:chatId/invites', groupActionLimiter, validateChatIdParam, checkValidation, groupController.listInvites);
router.delete('/:chatId/invites/:inviteId', groupActionLimiter, validateInviteIdParam, checkValidation, groupController.revokeInvite);

// Join requests from invite links when "Approve new members" is on (admins)
router.get('/:chatId/join-requests', groupActionLimiter, validateChatIdParam, checkValidation, groupController.listJoinRequests);
router.post('/:chatId/join-requests/:requestId/approve', groupActionLimiter, validateJoinRequestParam, checkValidation, groupController.approveJoinRequest);
router.post('/:chatId/join-requests/:requestId/decline', groupActionLimiter, validateJoinRequestParam, checkValidation, groupController.declineJoinRequest);

// Member tags (admins) and leaving
router.put('/:chatId/members/:userId/tag', groupActionLimiter, validateMemberTag, checkValidation, groupController.setMemberTag);
router.post('/:chatId/leave', groupActionLimiter, validateLeaveGroup, checkValidation, groupController.leaveGroup);

// User search
router.get('/search/users', chatController.searchUsers);

// Per-user read position, mute and archive
router.post('/:chatId/read', chatController.markRead);
router.put('/:chatId/mute', chatController.updateMute);
router.put('/:chatId/archive', chatController.updateArchive);
router.put('/:chatId/mentions-only', chatSettingsLimiter, validateMentionsOnly, checkValidation, chatController.updateMentionsOnly);

// Delete chat
router.delete('/:chatId', chatController.deleteChat);

module.exports = router;
