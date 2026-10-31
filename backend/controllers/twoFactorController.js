/**
 * Two-factor authentication in settings (signing in with a code is in authController).
 * The rules are in utils/twoFactor.js; this file writes the audit entries and sends the emails.
 */

const twoFactor = require('../utils/twoFactor');
const sessions = require('../utils/sessions');
const auditLog = require('../utils/auditLog');
const { notifySecurityEvent } = require('../utils/securityEmails');

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error);
    res.status(500).json({ success: false, message });
}

function sendError(res, error) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

/**
 * GET /api/auth/2fa
 */
async function getStatus(req, res) {
    try {
        res.json({ success: true, data: await twoFactor.getStatus(req.user.id) });
    } catch (error) {
        serverError(res, 'Two-factor status', error, 'Failed to load two-factor settings');
    }
}

/**
 * POST /api/auth/2fa/setup Body: { password }
 * The password is asked here too: a session left open must not be able to lock its owner out.
 */
async function beginSetup(req, res) {
    try {
        const check = await twoFactor.reauthenticate(req.user.id, { password: req.body.password });
        if (check.error) return sendError(res, check.error);

        const result = await twoFactor.beginSetup(req.user);
        if (result.error) return sendError(res, result.error);

        res.json({
            success: true,
            data: { secret: result.secret, otpauthUrl: result.otpauthUrl, qrCode: result.qrCode }
        });
    } catch (error) {
        serverError(res, 'Two-factor setup', error, 'Failed to start two-factor setup');
    }
}

/**
 * POST /api/auth/2fa/confirm Body: { code }
 * Recovery codes are in this response and nowhere else. Other devices never passed a second factor,
 * so they are signed out.
 */
async function confirmSetup(req, res) {
    try {
        const userId = req.user.id;
        const result = await twoFactor.confirmSetup(userId, req.sessionId, req.body.code);
        if (result.error) return sendError(res, result.error);

        const revoked = await sessions.revokeUserSessions(req.io, userId, '2fa', req.sessionId);
        await auditLog.recordRequest(req, '2fa_enabled', { targetType: 'user', targetId: userId, metadata: { revokedSessions: revoked } });
        notifySecurityEvent(req.user, 'two_factor_enabled');

        res.json({
            success: true,
            message: 'Two-factor authentication is on',
            data: { recoveryCodes: result.recoveryCodes, revokedSessions: revoked }
        });
    } catch (error) {
        serverError(res, 'Two-factor confirm', error, 'Failed to turn on two-factor authentication');
    }
}

/**
 * POST /api/auth/2fa/disable Body: { password, code } (a recovery code works too)
 */
async function disable(req, res) {
    try {
        const userId = req.user.id;
        const check = await twoFactor.reauthenticate(userId, req.body, req.ip);
        if (check.error) return sendError(res, check.error);
        if (!check.twoFactorEnabled) {
            return res.status(400).json({ success: false, message: 'Two-factor authentication is already off.', code: 'TWO_FACTOR_ALREADY_OFF' });
        }

        await twoFactor.disable(userId);
        await auditLog.recordRequest(req, '2fa_disabled', { targetType: 'user', targetId: userId });
        notifySecurityEvent(req.user, 'two_factor_disabled');

        res.json({ success: true, message: 'Two-factor authentication is off' });
    } catch (error) {
        serverError(res, 'Two-factor disable', error, 'Failed to turn off two-factor authentication');
    }
}

/**
 * POST /api/auth/2fa/recovery-codes Body: { password, code }: replaces every code
 */
async function regenerateRecoveryCodes(req, res) {
    try {
        const userId = req.user.id;
        const check = await twoFactor.reauthenticate(userId, req.body, req.ip);
        if (check.error) return sendError(res, check.error);
        if (!check.twoFactorEnabled) {
            return res.status(400).json({ success: false, message: 'Two-factor authentication is off.', code: 'TWO_FACTOR_ALREADY_OFF' });
        }

        const recoveryCodes = await twoFactor.replaceRecoveryCodes(userId);
        await auditLog.recordRequest(req, '2fa_recovery_regenerated', { targetType: 'user', targetId: userId });
        notifySecurityEvent(req.user, 'recovery_regenerated');

        res.json({ success: true, message: 'New recovery codes generated', data: { recoveryCodes } });
    } catch (error) {
        serverError(res, 'Regenerate recovery codes', error, 'Failed to generate new recovery codes');
    }
}

module.exports = {
    getStatus,
    beginSetup,
    confirmSetup,
    disable,
    regenerateRecoveryCodes
};
