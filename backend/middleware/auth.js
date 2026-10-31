/**
 * JWT Authentication Middleware
 * Verifies the short-lived access token, checks its session hasn't been revoked,
 * and attaches the user (req.user) and session id (req.sessionId) to the request
 */

const { verifyAccessToken, findSessionUser, touchSession, normalizeIp } = require('../utils/sessions');
const { toBool } = require('../utils/messageQueries');

function bearerToken(req) {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
}

/**
 * Verify JWT token and authenticate user
 */
async function authenticateToken(req, res, next) {
    try {
        const token = bearerToken(req);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access token required'
            });
        }

        // 401 (not 403): the frontend refreshes (and logs out if that fails) only on 401
        const decoded = verifyAccessToken(token);
        if (!decoded) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired token'
            });
        }

        // A revoked device is signed out on its next request, not when its access token runs out
        const user = await findSessionUser(decoded.userId, decoded.sid);
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Session ended. Please sign in again.',
                code: 'SESSION_REVOKED'
            });
        }

        req.user = user;
        req.sessionId = decoded.sid;
        touchSession(decoded.sid, normalizeIp(req.ip));
        next();
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
        const token = bearerToken(req);
        const decoded = token ? verifyAccessToken(token) : null;
        if (decoded) {
            const user = await findSessionUser(decoded.userId, decoded.sid);
            if (user) {
                req.user = user;
                req.sessionId = decoded.sid;
            }
        }
        next();
    } catch (error) {
        next();
    }
}

/**
 * Admin console routes, after authenticateToken. The flag is read from the database on each
 * request (findSessionUser); nothing the client sends can set it. An admin must also have 2FA on,
 * and findSessionUser has already refused a session that didn't pass it.
 */
function requireAdmin(req, res, next) {
    if (!req.user || !toBool(req.user.is_admin)) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    if (!req.user.totp_enabled_at) {
        return res.status(403).json({
            success: false,
            message: 'Turn on two-factor authentication in Settings > Security to use the admin console.',
            code: 'TWO_FACTOR_REQUIRED'
        });
    }
    next();
}

module.exports = {
    authenticateToken,
    optionalAuth,
    requireAdmin
};
