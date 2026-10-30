/**
 * Authentication Controller
 * Handles user registration, login, sessions (refresh/logout), passwords and email verification
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');
const { sendPasswordResetEmail } = require('../utils/mailer');
const sessions = require('../utils/sessions');
const verification = require('../utils/emailVerification');
const { safeAvatarUrl } = require('../utils/privacy');
const { toBool } = require('../utils/messageQueries');
const auditLog = require('../utils/auditLog');

const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Hash a reset token - only the hash is stored, so a leaked
 * database can't be used to reset anyone's password
 */
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * The fields every auth response returns about the signed-in user
 */
function shapeUser(user) {
    return {
        userId: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name || null,
        avatarUrl: safeAvatarUrl(user.avatar_url),
        emailVerified: verification.isEmailVerified(user),
        isAdmin: toBool(user.is_admin) // only decides whether the console link shows; admin routes check the database
    };
}

/**
 * Start a session for this device: refresh token in an HttpOnly cookie, access token in the body
 */
async function startSession(req, res, user) {
    const { sessionId, refreshToken } = await sessions.createSession(user.id, sessions.requestMeta(req));
    sessions.setRefreshCookie(res, refreshToken);
    return sessions.signAccessToken(user, sessionId);
}

/**
 * Register a new user
 */
async function register(req, res) {
    try {
        const { username, email, password, fullName } = req.body;

        // Check if user already exists
        const existingUser = await queryOne(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Username or email already exists'
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Insert user and get inserted id (handle MySQL and PostgreSQL)
        let userId;
        if (process.env.DB_TYPE === 'postgresql') {
            const result = await executeQuery(
                'INSERT INTO users (username, email, password_hash, full_name, status) VALUES (?, ?, ?, ?, ?) RETURNING id',
                [username, email, passwordHash, sanitizeHtml(fullName) || null, 'offline']
            );
            userId = result[0]?.id;
        } else {
            const result = await executeQuery(
                'INSERT INTO users (username, email, password_hash, full_name, status) VALUES (?, ?, ?, ?, ?)',
                [username, email, passwordHash, sanitizeHtml(fullName) || null, 'offline']
            );
            userId = result.insertId || result[0]?.id;
        }

        const user = { id: userId, username, email, full_name: fullName || null, avatar_url: null, email_verified_at: null };

        // New accounts can sign in straight away; verifying unlocks invite links and new contacts
        await verification.issueVerification(user);

        const { accessToken, expiresIn } = await startSession(req, res, user);

        res.status(201).json({
            success: true,
            message: 'User registered successfully. Check your email to verify your address.',
            data: { ...shapeUser(user), accessToken, expiresIn }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Registration failed',
            error: error.message
        });
    }
}

/**
 * Login user
 */
async function login(req, res) {
    try {
        const { username, password } = req.body;

        // Find user by username or email
        const user = await queryOne(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [username, username]
        );

        if (!user) {
            await auditLog.recordRequest(req, 'login_failed', { metadata: { unknownAccount: true } });
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            await auditLog.recordRequest(req, 'login_failed', { targetType: 'user', targetId: user.id });
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // After the password check, so a stranger can't find out an account is suspended
        if (user.suspended_at) {
            await auditLog.recordRequest(req, 'login_blocked_suspended', { actorId: user.id, targetType: 'user', targetId: user.id });
            return res.status(403).json({
                success: false,
                message: 'This account has been suspended.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        // Update user status to online
        await executeQuery(
            'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
            ['online', user.id]
        );

        const { accessToken, expiresIn } = await startSession(req, res, user);
        await auditLog.recordRequest(req, 'login', { actorId: user.id, targetType: 'user', targetId: user.id });

        res.json({
            success: true,
            message: 'Login successful',
            data: { ...shapeUser(user), accessToken, expiresIn }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Login failed',
            error: error.message
        });
    }
}

/**
 * POST /api/auth/refresh (refresh cookie)
 * Rotates the refresh token and returns a new access token. A refresh token that was already
 * rotated out is treated as stolen: its whole session is revoked and its sockets disconnected.
 */
async function refresh(req, res) {
    try {
        const token = sessions.readRefreshCookie(req);
        if (!token) {
            return res.status(401).json({ success: false, message: 'Not signed in', code: 'NO_SESSION' });
        }

        const result = await sessions.rotateRefreshToken(token, sessions.requestMeta(req));

        if (result.error === 'race') {
            // Another tab refreshed with this cookie a moment ago; the browser now holds the newer one
            return res.status(409).json({ success: false, message: 'Refresh already in progress, retry', code: 'REFRESH_RACE' });
        }

        if (result.error === 'reused') {
            await sessions.revokeSession(req.io, result.sessionId, 'reuse');
            await auditLog.recordRequest(req, 'session_revoked', {
                actorId: result.userId,
                targetType: 'session',
                targetId: result.sessionId,
                metadata: { reason: 'reuse' }
            });
            console.warn(`Refresh token reuse detected - revoked session ${result.sessionId} of user ${result.userId}`);
            sessions.clearRefreshCookie(res);
            return res.status(401).json({ success: false, message: 'This sign-in was ended for your security. Please sign in again.', code: 'TOKEN_REUSED' });
        }

        if (result.error) {
            sessions.clearRefreshCookie(res);
            return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.', code: 'SESSION_EXPIRED' });
        }

        const user = await queryOne(
            'SELECT id, username, email, full_name, avatar_url, email_verified_at, is_admin, suspended_at FROM users WHERE id = ?',
            [result.userId]
        );
        if (!user || user.suspended_at) {
            await sessions.revokeSession(req.io, result.sessionId, user ? 'suspended' : 'user');
            sessions.clearRefreshCookie(res);
            return res.status(401).json({ success: false, message: 'User not found', code: 'SESSION_EXPIRED' });
        }

        sessions.setRefreshCookie(res, result.refreshToken);
        const { accessToken, expiresIn } = sessions.signAccessToken(user, result.sessionId);

        res.json({
            success: true,
            data: { ...shapeUser(user), accessToken, expiresIn }
        });
    } catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({ success: false, message: 'Failed to refresh the session' });
    }
}

/**
 * Logout: ends this device's session (found by access token, or by the refresh cookie when the
 * access token has already expired) and clears the cookie
 */
async function logout(req, res) {
    try {
        let sessionId = req.sessionId || null;
        let userId = req.user ? req.user.id : null;

        if (!sessionId) {
            const session = await sessions.findSessionByRefreshToken(sessions.readRefreshCookie(req));
            if (session) {
                sessionId = Number(session.id);
                userId = Number(session.user_id);
            }
        }

        if (sessionId) {
            await sessions.revokeSession(req.io, sessionId, 'logout', userId);
        }
        sessions.clearRefreshCookie(res);

        if (userId) {
            // Update user status to offline
            await executeQuery(
                'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
                ['offline', userId]
            );
        }

        res.json({
            success: true,
            message: 'Logout successful'
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            message: 'Logout failed',
            error: error.message
        });
    }
}

/**
 * Get current user profile
 */
async function getProfile(req, res) {
    try {
        const user = req.user;

        res.json({
            success: true,
            data: {
                id: user.id,
                userId: user.id,
                username: user.username,
                email: user.email,
                fullName: user.full_name,
                avatarUrl: safeAvatarUrl(user.avatar_url),
                status: user.status,
                emailVerified: verification.isEmailVerified(user),
                isAdmin: toBool(user.is_admin)
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get profile',
            error: error.message
        });
    }
}

/**
 * Update the display name (older clients; PUT /api/users/me/profile also takes a bio).
 * Photos can only be uploaded (POST /api/users/me/avatar), never set to a URL.
 */
async function updateProfile(req, res) {
    try {
        const userId = req.user.id;
        const { fullName } = req.body;

        if (fullName !== undefined) {
            await executeQuery(
                'UPDATE users SET full_name = ? WHERE id = ?',
                [sanitizeHtml(fullName) || null, userId]
            );
        }

        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update profile',
            error: error.message
        });
    }
}

/**
 * PUT /api/auth/password Body: { currentPassword, newPassword }
 * Every other device is signed out; this one stays signed in.
 */
async function changePassword(req, res) {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        const row = await queryOne('SELECT password_hash FROM users WHERE id = ?', [userId]);
        if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
            // 400, not 401: a wrong current password must not sign the user out
            return res.status(400).json({ success: false, message: 'Your current password is incorrect', code: 'WRONG_PASSWORD' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        await executeQuery(
            'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [passwordHash, userId]
        );
        // Outstanding reset links would undo the change
        await executeQuery('DELETE FROM password_resets WHERE user_id = ?', [userId]);

        const revoked = await sessions.revokeUserSessions(req.io, userId, 'password', req.sessionId);
        await auditLog.recordRequest(req, 'password_changed', { targetType: 'user', targetId: userId, metadata: { revokedSessions: revoked } });

        res.json({
            success: true,
            message: revoked > 0
                ? `Password changed. ${revoked} other device${revoked === 1 ? ' was' : 's were'} signed out.`
                : 'Password changed.',
            data: { revokedSessions: revoked }
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, message: 'Failed to change password' });
    }
}

/**
 * Request a password reset link
 * Always responds the same way so the endpoint can't be used
 * to discover which emails have accounts
 */
async function forgotPassword(req, res) {
    const genericResponse = {
        success: true,
        message: 'If an account exists for that email, a password reset link has been sent.'
    };

    try {
        const { email } = req.body;

        const user = await queryOne(
            'SELECT id, username, email FROM users WHERE email = ?',
            [email]
        );

        if (!user) {
            return res.json(genericResponse);
        }

        // Only one active reset link per user
        await executeQuery('DELETE FROM password_resets WHERE user_id = ?', [user.id]);

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

        await executeQuery(
            'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
            [user.id, hashResetToken(token), expiresAt]
        );

        const frontendUrl = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:8080')
            .replace(/\/+$/, '');
        const resetUrl = `${frontendUrl}/reset-password.html?token=${token}`;

        // Don't await - response time shouldn't reveal whether an email was sent
        sendPasswordResetEmail(user.email, user.username, resetUrl, RESET_TOKEN_TTL_MINUTES)
            .catch(error => console.error('Password reset email error:', error));

        res.json(genericResponse);
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process password reset request'
        });
    }
}

/**
 * Reset password using a token from the reset email. Signs out every device.
 */
async function resetPassword(req, res) {
    try {
        const { token, password } = req.body;

        const reset = await queryOne(
            'SELECT id, user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?',
            [hashResetToken(token), new Date()]
        );

        if (!reset) {
            return res.status(400).json({
                success: false,
                message: 'This reset link is invalid or has expired. Please request a new one.'
            });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        await executeQuery(
            'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [passwordHash, reset.user_id]
        );

        // Tokens are single-use
        await executeQuery('DELETE FROM password_resets WHERE user_id = ?', [reset.user_id]);

        // Whoever knew the old password is signed out everywhere
        await sessions.revokeUserSessions(req.io, reset.user_id, 'password');
        await auditLog.recordRequest(req, 'password_reset', { actorId: reset.user_id, targetType: 'user', targetId: reset.user_id });

        res.json({
            success: true,
            message: 'Your password has been reset. You can now log in.'
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset password'
        });
    }
}

/**
 * POST /api/auth/verify-email Body: { token } (from the link in the verification email)
 */
async function verifyEmail(req, res) {
    try {
        const userId = await verification.consumeVerification(req.body.token);
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'This verification link is invalid or has expired. Sign in and send a new one from Settings.'
            });
        }

        // Open tabs drop the "verify your email" banner
        if (req.io) {
            req.io.to(`user_${userId}`).emit('email_verified', { userId });
        }

        res.json({ success: true, message: 'Your email address is verified.' });
    } catch (error) {
        console.error('Verify email error:', error);
        res.status(500).json({ success: false, message: 'Failed to verify the email address' });
    }
}

/**
 * POST /api/auth/resend-verification (signed in, rate limited per user and per IP)
 */
async function resendVerification(req, res) {
    try {
        if (verification.isEmailVerified(req.user)) {
            return res.status(400).json({ success: false, message: 'Your email address is already verified.', code: 'ALREADY_VERIFIED' });
        }

        await verification.issueVerification(req.user);

        res.json({ success: true, message: `We sent a new verification link to ${req.user.email}.` });
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ success: false, message: 'Failed to send the verification email' });
    }
}

/**
 * GET /api/auth/sessions - this user's signed-in devices; `current` marks the one asking
 */
async function listSessions(req, res) {
    try {
        const list = await sessions.listActiveSessions(req.user.id);
        res.json({
            success: true,
            data: list.map(session => ({ ...session, current: session.id === Number(req.sessionId) }))
        });
    } catch (error) {
        console.error('List sessions error:', error);
        res.status(500).json({ success: false, message: 'Failed to load your devices' });
    }
}

/**
 * DELETE /api/auth/sessions/:sessionId - sign one device out (its sockets disconnect immediately)
 */
async function revokeSession(req, res) {
    try {
        const sessionId = Number(req.params.sessionId);
        const revoked = await sessions.revokeSession(req.io, sessionId, 'user', req.user.id);
        if (!revoked) {
            return res.status(404).json({ success: false, message: 'Device not found or already signed out' });
        }
        await auditLog.recordRequest(req, 'session_revoked', { targetType: 'session', targetId: sessionId, metadata: { reason: 'user' } });

        const current = sessionId === Number(req.sessionId);
        if (current) sessions.clearRefreshCookie(res);

        res.json({ success: true, message: current ? 'Signed out of this device' : 'Device signed out', data: { sessionId, current } });
    } catch (error) {
        console.error('Revoke session error:', error);
        res.status(500).json({ success: false, message: 'Failed to sign the device out' });
    }
}

/**
 * POST /api/auth/sessions/revoke-others - sign out every device except this one
 */
async function revokeOtherSessions(req, res) {
    try {
        const revoked = await sessions.revokeUserSessions(req.io, req.user.id, 'user', req.sessionId);
        if (revoked > 0) {
            await auditLog.recordRequest(req, 'session_revoked', { targetType: 'user', targetId: req.user.id, metadata: { reason: 'user', revokedSessions: revoked } });
        }
        res.json({
            success: true,
            message: revoked > 0 ? `Signed out ${revoked} other device${revoked === 1 ? '' : 's'}` : 'No other devices were signed in',
            data: { revokedSessions: revoked }
        });
    } catch (error) {
        console.error('Revoke other sessions error:', error);
        res.status(500).json({ success: false, message: 'Failed to sign out other devices' });
    }
}

module.exports = {
    register,
    login,
    refresh,
    logout,
    getProfile,
    updateProfile,
    changePassword,
    forgotPassword,
    resetPassword,
    verifyEmail,
    resendVerification,
    listSessions,
    revokeSession,
    revokeOtherSessions
};
