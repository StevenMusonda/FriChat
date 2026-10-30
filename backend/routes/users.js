/**
 * User routes: your profile, photo, custom status and privacy settings; other people's profile cards
 */

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { uploadUserAvatar, handleUserAvatarUploadError } = require('../middleware/userAvatarUpload');
const {
    validateProfileUpdate,
    validateCustomStatus,
    validatePrivacySettings,
    validateUserIdParam,
    validateBirthday,
    checkValidation
} = require('../utils/validation');

const profileLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many profile changes. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

// Photos are decoded and re-encoded, so they get a tighter budget (checked before multer reads the body)
const avatarLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many photo uploads. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

// Profile cards (opened by clicking a name)
const profileCardLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many requests. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);

router.get('/me', profileCardLimiter, userController.getMe);
router.put('/me/profile', profileLimiter, validateProfileUpdate, checkValidation, userController.updateProfile);
router.post('/me/avatar', avatarLimiter, uploadUserAvatar, handleUserAvatarUploadError, userController.uploadAvatar);
router.delete('/me/avatar', avatarLimiter, userController.removeAvatar);
router.put('/me/status', profileLimiter, validateCustomStatus, checkValidation, userController.setCustomStatus);
router.delete('/me/status', profileLimiter, userController.clearCustomStatus);
router.put('/me/birthday', profileLimiter, validateBirthday, checkValidation, userController.setBirthday);
router.delete('/me/birthday', profileLimiter, userController.clearBirthday);
router.get('/me/privacy', profileCardLimiter, userController.getPrivacy);
router.put('/me/privacy', profileLimiter, validatePrivacySettings, checkValidation, userController.updatePrivacy);

router.get('/:userId', profileCardLimiter, validateUserIdParam, checkValidation, userController.getUserProfile);

module.exports = router;
