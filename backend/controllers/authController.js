/**
 * Authentication Controller
 * Handles user registration, login, and authentication
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');
const { sendPasswordResetEmail } = require('../utils/mailer');

const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Hash a reset token - only the hash is stored, so a leaked
 * database can't be used to reset anyone's password
 */
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
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

        // Generate JWT token
        const token = jwt.sign(
            { userId: userId, username: username },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                userId: userId,
                username: username,
                email: email,
                fullName: fullName,
                token: token
            }
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
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Update user status to online
        await executeQuery(
            'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
            ['online', user.id]
        );

        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, username: user.username },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                userId: user.id,
                username: user.username,
                email: user.email,
                fullName: user.full_name,
                avatarUrl: user.avatar_url,
                token: token
            }
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
 * Logout user
 */
async function logout(req, res) {
    try {
        const userId = req.user.id;

        // Update user status to offline
        await executeQuery(
            'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
            ['offline', userId]
        );

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
                username: user.username,
                email: user.email,
                fullName: user.full_name,
                avatarUrl: user.avatar_url,
                status: user.status
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
 * Update user profile
 */
async function updateProfile(req, res) {
    try {
        const userId = req.user.id;
        const { fullName, avatarUrl } = req.body;

        await executeQuery(
            'UPDATE users SET full_name = ?, avatar_url = ? WHERE id = ?',
            [sanitizeHtml(fullName) || null, avatarUrl || null, userId]
        );

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
 * Reset password using a token from the reset email
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

module.exports = {
    register,
    login,
    logout,
    getProfile,
    updateProfile,
    forgotPassword,
    resetPassword
};
