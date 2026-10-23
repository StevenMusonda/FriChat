/**
 * Authentication Routes
 */

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateRegistration,
    validateLogin,
    validateForgotPassword,
    validateResetPassword,
    checkValidation
} = require('../utils/validation');

const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many password reset attempts. Please try again in a few minutes.'
});

// Public routes
router.post('/register', validateRegistration, checkValidation, authController.register);
router.post('/login', validateLogin, checkValidation, authController.login);
router.post('/forgot-password', passwordResetLimiter, validateForgotPassword, checkValidation, authController.forgotPassword);
router.post('/reset-password', passwordResetLimiter, validateResetPassword, checkValidation, authController.resetPassword);

// Protected routes
router.post('/logout', authenticateToken, authController.logout);
router.get('/profile', authenticateToken, authController.getProfile);
router.put('/profile', authenticateToken, authController.updateProfile);

module.exports = router;
