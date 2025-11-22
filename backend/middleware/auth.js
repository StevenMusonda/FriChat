/**
 * JWT Authentication Middleware
 * Verifies JWT tokens and attaches user info to request
 */

const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/database');

/**
 * Verify JWT token and authenticate user
 */
async function authenticateToken(req, res, next) {
    try {
        // Get token from header
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ 
                success: false, 
                message: 'Access token required' 
            });
        }

        // Verify token
        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (err) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Invalid or expired token' 
                });
            }

            // Get user from database
            const user = await queryOne(
                'SELECT id, username, email, full_name, avatar_url, status FROM users WHERE id = ?',
                [decoded.userId]
            );

            if (!user) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'User not found' 
                });
            }

            // Attach user to request
            req.user = user;
            next();
        });
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Authentication failed' 
        });
    }
}

/**
 * Optional authentication - doesn't fail if no token
 */
async function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return next();
        }

        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (!err) {
                const user = await queryOne(
                    'SELECT id, username, email, full_name, avatar_url, status FROM users WHERE id = ?',
                    [decoded.userId]
                );
                if (user) {
                    req.user = user;
                }
            }
            next();
        });
    } catch (error) {
        next();
    }
}

module.exports = {
    authenticateToken,
    optionalAuth
};
