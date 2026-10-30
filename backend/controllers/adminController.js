/**
 * Admin Controller
 * Report review, user management and the audit log. routes/admin.js puts authenticateToken and
 * requireAdmin in front of every handler here; each action writes an audit entry.
 */

const reports = require('../utils/reports');
const moderation = require('../utils/moderation');
const auditLog = require('../utils/auditLog');
const { attachmentHeader } = require('../utils/uploads');
const { AUDIT_EVENTS, REPORT_REASONS } = require('../config/moderation');

function sendError(res, error) {
    res.status(error.status).json({ success: false, message: error.message });
}

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error);
    res.status(500).json({ success: false, message });
}

/**
 * GET /api/admin/config - the filter lists of the console
 */
function getConfig(req, res) {
    res.json({ success: true, data: { auditEvents: AUDIT_EVENTS, reportReasons: REPORT_REASONS } });
}

// --- reports ---

async function listReports(req, res) {
    try {
        res.json({ success: true, data: await reports.listReports({ status: req.query.status, before: req.query.before }) });
    } catch (error) {
        serverError(res, 'List reports', error, 'Failed to load reports');
    }
}

async function getReport(req, res) {
    try {
        const report = await reports.getReport(req.params.reportId);
        if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

        // Evidence is private conversation, so who read it is on the record
        await auditLog.recordRequest(req, 'admin_report_viewed', { targetType: 'report', targetId: report.id });
        res.json({ success: true, data: report });
    } catch (error) {
        serverError(res, 'Get report', error, 'Failed to load the report');
    }
}

/**
 * GET /api/admin/reports/:reportId/evidence/:evidenceId/file - always a download of a generic type
 */
async function downloadEvidenceFile(req, res) {
    try {
        const file = await reports.findEvidenceFile(req.params.reportId, req.params.evidenceId);
        if (!file) return res.status(404).json({ success: false, message: 'No stored file for this message' });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', attachmentHeader(file.fileName));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(file.fullPath, { dotfiles: 'allow' }, (error) => {
            if (error && !res.headersSent) res.status(404).json({ success: false, message: 'The stored file is missing' });
        });
    } catch (error) {
        serverError(res, 'Download evidence', error, 'Failed to load the file');
    }
}

/**
 * The report in the URL, or null after answering 404
 */
async function findReport(req, res) {
    const report = await reports.getReport(req.params.reportId);
    if (!report) {
        sendError(res, { status: 404, message: 'Report not found' });
        return null;
    }
    return report;
}

async function dismissReport(req, res) {
    try {
        const report = await findReport(req, res);
        if (!report) return;

        await reports.resolveReport(report.id, req.user.id, 'dismissed', 'dismissed');
        await auditLog.recordRequest(req, 'admin_report_dismissed', { targetType: 'report', targetId: report.id });
        res.json({ success: true, message: 'Report dismissed' });
    } catch (error) {
        serverError(res, 'Dismiss report', error, 'Failed to dismiss the report');
    }
}

async function warnFromReport(req, res) {
    try {
        const report = await findReport(req, res);
        if (!report) return;
        if (!report.reportedUser) return sendError(res, { status: 409, message: 'The reported account no longer exists' });

        const result = await moderation.warnUser(req.io, report.reportedUser.id, req.user.id, req.body.message, report.id);
        if (result.error) return sendError(res, result.error);

        await reports.resolveReport(report.id, req.user.id, 'actioned', 'warned');
        await auditLog.recordRequest(req, 'admin_user_warned', {
            targetType: 'user',
            targetId: report.reportedUser.id,
            metadata: { reportId: report.id, warningId: result.warningId }
        });
        res.json({ success: true, message: `@${report.reportedUser.username} was warned` });
    } catch (error) {
        serverError(res, 'Warn user', error, 'Failed to warn the user');
    }
}

async function suspendFromReport(req, res) {
    try {
        const report = await findReport(req, res);
        if (!report) return;
        if (!report.reportedUser) return sendError(res, { status: 409, message: 'The reported account no longer exists' });

        const result = await moderation.suspendUser(req.io, report.reportedUser.id, req.body.reason);
        if (result.error) return sendError(res, result.error);

        await reports.resolveReport(report.id, req.user.id, 'actioned', 'suspended');
        await auditLog.recordRequest(req, 'admin_user_suspended', {
            targetType: 'user',
            targetId: report.reportedUser.id,
            metadata: { reportId: report.id, reason: req.body.reason || null, revokedSessions: result.revokedSessions }
        });
        res.json({ success: true, message: `@${report.reportedUser.username} was suspended` });
    } catch (error) {
        serverError(res, 'Suspend user', error, 'Failed to suspend the user');
    }
}

async function deleteReportedMessage(req, res) {
    try {
        const report = await findReport(req, res);
        if (!report) return;
        if (!report.messageId) return sendError(res, { status: 400, message: 'This report isn\'t about a message' });

        const { deleted } = await moderation.deleteMessageForEveryone(req.io, report.messageId, req.user.id);

        await reports.resolveReport(report.id, req.user.id, 'actioned', 'message_deleted');
        await auditLog.recordRequest(req, 'admin_message_deleted', {
            targetType: 'message',
            targetId: report.messageId,
            metadata: { reportId: report.id, alreadyGone: !deleted }
        });
        res.json({ success: true, message: deleted ? 'Message deleted for everyone' : 'The message was already gone' });
    } catch (error) {
        serverError(res, 'Delete message', error, 'Failed to delete the message');
    }
}

// --- users ---

async function listUsers(req, res) {
    try {
        res.json({ success: true, data: await moderation.searchUsers({ q: req.query.q, status: req.query.status, before: req.query.before }) });
    } catch (error) {
        serverError(res, 'List users', error, 'Failed to load users');
    }
}

async function suspendUser(req, res) {
    try {
        const userId = Number(req.params.userId);
        const result = await moderation.suspendUser(req.io, userId, req.body.reason);
        if (result.error) return sendError(res, result.error);

        await auditLog.recordRequest(req, 'admin_user_suspended', {
            targetType: 'user',
            targetId: userId,
            metadata: { reason: req.body.reason || null, revokedSessions: result.revokedSessions }
        });
        res.json({ success: true, message: 'Account suspended' });
    } catch (error) {
        serverError(res, 'Suspend user', error, 'Failed to suspend the account');
    }
}

async function unsuspendUser(req, res) {
    try {
        const userId = Number(req.params.userId);
        const result = await moderation.unsuspendUser(userId);
        if (result.error) return sendError(res, result.error);

        await auditLog.recordRequest(req, 'admin_user_unsuspended', { targetType: 'user', targetId: userId });
        res.json({ success: true, message: 'Account restored' });
    } catch (error) {
        serverError(res, 'Unsuspend user', error, 'Failed to restore the account');
    }
}

async function forceLogout(req, res) {
    try {
        const userId = Number(req.params.userId);
        if (userId === Number(req.user.id)) {
            return sendError(res, { status: 400, message: 'Use Settings > Devices for your own sessions' });
        }

        const result = await moderation.forceLogout(req.io, userId);
        if (result.error) return sendError(res, result.error);

        await auditLog.recordRequest(req, 'admin_user_logged_out', {
            targetType: 'user',
            targetId: userId,
            metadata: { revokedSessions: result.revokedSessions }
        });
        res.json({ success: true, message: `Signed out ${result.revokedSessions} session${result.revokedSessions === 1 ? '' : 's'}` });
    } catch (error) {
        serverError(res, 'Force logout', error, 'Failed to sign the user out');
    }
}

// --- audit log (read-only) ---

async function searchAudit(req, res) {
    try {
        const { event, actorId, targetType, targetId, ip, q, from, to, before } = req.query;
        res.json({ success: true, data: await auditLog.search({ event, actorId, targetType, targetId, ip, q, from, to, before }) });
    } catch (error) {
        serverError(res, 'Search audit log', error, 'Failed to load the audit log');
    }
}

module.exports = {
    getConfig,
    listReports,
    getReport,
    downloadEvidenceFile,
    dismissReport,
    warnFromReport,
    suspendFromReport,
    deleteReportedMessage,
    listUsers,
    suspendUser,
    unsuspendUser,
    forceLogout,
    searchAudit
};
