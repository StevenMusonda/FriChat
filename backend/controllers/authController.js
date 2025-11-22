/**
 * Authentication Controller
 * Handles user registration, login, and authentication
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');

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

        // Insert user
        const result = await executeQuery(
            'INSERT INTO users (username, email, password_hash, full_name, status) VALUES (?, ?, ?, ?, ?)',
            [username, email, passwordHash, sanitizeHtml(fullName) || null, 'offline']
        );

        const userId = result.insertId || result[0]?.id;

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

module.exports = {
    register,
    login,
    logout,
    getProfile,
    updateProfile
};
