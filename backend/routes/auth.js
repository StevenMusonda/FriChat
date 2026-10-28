/**
 * Authentication Routes
 */

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateRegistration,
    validateLogin,
    validateForgotPassword,
    validateResetPassword,
    validateChangePassword,
    validateVerifyEmail,
    validateSessionIdParam,
    checkValidation
} = require('../utils/validation');

const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many password reset attempts. Please try again in a few minutes.'
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many sign-in attempts. Please try again in a few minutes.'
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many accounts created from here. Please try again later.'
});

// Every tab refreshes about every 15 minutes; this only stops hammering
const refreshLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many session refreshes. Please wait a moment.'
});

const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many password change attempts. Please try again in a few minutes.'
});

const verifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many verification attempts. Please try again in a few minutes.'
});

// Resend: per IP and per account (the per-account limiter runs after authentication)
const resendIpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many verification emails requested. Please try again later.'
});
const resendUserLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: 'We already sent you a few links. Please check your inbox (and spam folder) or try again in 15 minutes.',
    keyGenerator: (req) => `user:${req.user.id}`
});

const sessionActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many requests. Please wait a moment.'
});

/**
 * Refresh and logout act on the HttpOnly cookie, which the browser attaches by itself. Requiring a
 * custom header means a cross-site form or image can't trigger them: a page on another origin can
 * only send this header after a CORS preflight, which CORS_ORIGIN refuses.
 */
function requireRefreshHeader(req, res, next) {
    if (req.get('X-FriChat-Refresh') !== '1') {
        return res.status(403).json({ success: false, message: 'Missing X-FriChat-Refresh header' });
    }
    next();
}

// Public routes
router.post('/register', registerLimiter, validateRegistration, checkValidation, authController.register);
router.post('/login', loginLimiter, validateLogin, checkValidation, authController.login);
router.post('/refresh', refreshLimiter, requireRefreshHeader, authController.refresh);
router.post('/forgot-password', passwordResetLimiter, validateForgotPassword, checkValidation, authController.forgotPassword);
router.post('/reset-password', passwordResetLimiter, validateResetPassword, checkValidation, authController.resetPassword);
router.post('/verify-email', verifyEmailLimiter, validateVerifyEmail, checkValidation, authController.verifyEmail);

// Logout works with an expired access token too (the refresh cookie identifies the session)
router.post('/logout', sessionActionLimiter, requireRefreshHeader, optionalAuth, authController.logout);

// Protected routes
router.get('/profile', authenticateToken, authController.getProfile);
router.put('/profile', authenticateToken, authController.updateProfile);
router.put('/password', changePasswordLimiter, authenticateToken, validateChangePassword, checkValidation, authController.changePassword);
router.post('/resend-verification', resendIpLimiter, authenticateToken, resendUserLimiter, authController.resendVerification);

// Signed-in devices
router.get('/sessions', sessionActionLimiter, authenticateToken, authController.listSessions);
router.post('/sessions/revoke-others', sessionActionLimiter, authenticateToken, authController.revokeOtherSessions);
router.delete('/sessions/:sessionId', sessionActionLimiter, authenticateToken, validateSessionIdParam, checkValidation, authController.revokeSession);

module.exports = router;
