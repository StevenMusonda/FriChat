/**
 * Data rights: exporting your data and deleting your account.
 * The work happens in background jobs (utils/dataExport.js, utils/accountDeletion.js).
 */

const dataExport = require('../utils/dataExport');
const accountDeletion = require('../utils/accountDeletion');
const twoFactor = require('../utils/twoFactor');
const sessions = require('../utils/sessions');
const auditLog = require('../utils/auditLog');
const { attachmentHeader } = require('../utils/uploads');

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error);
    res.status(500).json({ success: false, message });
}

function sendError(res, error) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

/**
 * POST /api/account/exports
 */
async function requestExport(req, res) {
    try {
        const result = await dataExport.requestExport(req.user.id);
        if (result.error) return sendError(res, result.error);

        await auditLog.recordRequest(req, 'data_export_requested', { targetType: 'user', targetId: req.user.id });
        res.status(202).json({
            success: true,
            message: 'We\'re preparing your export. We\'ll email you when it\'s ready.',
            data: { exportId: result.exportId }
        });
    } catch (error) {
        serverError(res, 'Request export', error, 'Failed to request your export');
    }
}

/**
 * GET /api/account/exports
 */
async function listExports(req, res) {
    try {
        res.json({ success: true, data: await dataExport.listExports(req.user.id) });
    } catch (error) {
        serverError(res, 'List exports', error, 'Failed to load your exports');
    }
}

/**
 * POST /api/account/exports/:exportId/link: a few minutes' link to one of your own ready exports
 */
async function createDownloadLink(req, res) {
    try {
        const exportId = Number(req.params.exportId);
        const download = await dataExport.findDownload(exportId, req.user.id);
        if (!download) {
            return res.status(404).json({ success: false, message: 'That export is no longer available' });
        }
        const token = dataExport.signDownloadToken(exportId, req.user.id);
        res.json({ success: true, data: { path: `/account/exports/${exportId}/download?token=${encodeURIComponent(token)}` } });
    } catch (error) {
        serverError(res, 'Export link', error, 'Failed to prepare the download');
    }
}

/**
 * GET /api/account/exports/:exportId/download?token=... The browser opens this itself, so the token
 * stands in for the Authorization header. It only ever names this export.
 */
async function downloadExport(req, res) {
    try {
        const exportId = Number(req.params.exportId);
        const link = dataExport.verifyDownloadToken(req.query.token);
        const download = link && link.exportId === exportId ? await dataExport.findDownload(exportId, link.userId) : null;
        if (!download) {
            return res.status(404).json({ success: false, message: 'This link has expired. Open Settings > Security and try again.' });
        }

        await auditLog.record('data_export_downloaded', {
            actorId: link.userId,
            targetType: 'user',
            targetId: link.userId,
            ip: sessions.normalizeIp(req.ip)
        });

        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': attachmentHeader(dataExport.DOWNLOAD_NAME),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        // dotfiles: the folder is ours, and a dot anywhere in its path mustn't turn this into a 404
        res.sendFile(download.fullPath, { dotfiles: 'allow' }, (error) => {
            if (error && !res.headersSent) {
                console.error('Export download error:', error.message);
                res.status(404).json({ success: false, message: 'That export is no longer available' });
            }
        });
    } catch (error) {
        serverError(res, 'Export download', error, 'Failed to download your export');
    }
}

/**
 * POST /api/account/delete Body: { password, code? } (code when 2FA is on)
 */
async function requestDeletion(req, res) {
    try {
        const userId = req.user.id;
        const check = await twoFactor.reauthenticate(userId, req.body, req.ip);
        if (check.error) return sendError(res, check.error);

        const result = await accountDeletion.scheduleDeletion(req.io, req.user);
        if (result.error) return sendError(res, result.error);

        await auditLog.recordRequest(req, 'account_deletion_requested', { targetType: 'user', targetId: userId });
        sessions.clearRefreshCookie(res);

        res.json({
            success: true,
            message: 'Your account will be deleted. Sign in before then to cancel.',
            data: { deletionDueAt: result.dueAt }
        });
    } catch (error) {
        serverError(res, 'Request account deletion', error, 'Failed to start the deletion');
    }
}

module.exports = {
    requestExport,
    listExports,
    createDownloadLink,
    downloadExport,
    requestDeletion
};
