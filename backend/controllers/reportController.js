/**
 * Report Controller
 * File a report on a message or a user (and optionally block them), and the warnings a user sees
 */

const reports = require('../utils/reports');
const blocks = require('../utils/blocks');
const moderation = require('../utils/moderation');
const auditLog = require('../utils/auditLog');
const { emitPresenceChange } = require('./blockController');

/**
 * POST /api/reports
 * Body: { targetType: 'message'|'user', messageId?, userId?, chatId?, reason, note?, block? }
 */
async function createReport(req, res) {
    try {
        const reporterId = req.user.id;
        const result = await reports.fileReport(reporterId, req.body);
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        if (!result.duplicate) {
            await auditLog.recordRequest(req, 'report_filed', {
                targetType: 'report',
                targetId: result.reportId,
                metadata: {
                    on: req.body.targetType,
                    messageId: req.body.messageId || null,
                    reportedUserId: result.reportedUserId,
                    reason: req.body.reason
                }
            });
        }

        let blocked = false;
        if (req.body.block === true) {
            blocked = true;
            if (await blocks.blockUser(reporterId, result.reportedUserId)) {
                await emitPresenceChange(req.io, reporterId, result.reportedUserId, true);
                if (req.io) req.io.to(`user_${reporterId}`).emit('block_updated', { userId: result.reportedUserId, blocked: true });
            }
        }

        res.status(result.duplicate ? 200 : 201).json({
            success: true,
            message: result.duplicate ? 'You already reported this. We\'re looking at it.' : 'Thanks. Your report was sent to the moderators.',
            data: { reportId: result.reportId, blocked }
        });
    } catch (error) {
        console.error('Create report error:', error);
        res.status(500).json({ success: false, message: 'Failed to send the report' });
    }
}

/**
 * GET /api/reports/warnings - warnings from admins this user hasn't acknowledged
 */
async function listWarnings(req, res) {
    try {
        res.json({ success: true, data: await moderation.listOpenWarnings(req.user.id) });
    } catch (error) {
        console.error('List warnings error:', error);
        res.status(500).json({ success: false, message: 'Failed to load warnings' });
    }
}

/**
 * POST /api/reports/warnings/:warningId/acknowledge
 */
async function acknowledgeWarning(req, res) {
    try {
        const done = await moderation.acknowledgeWarning(req.user.id, req.params.warningId);
        if (!done) return res.status(404).json({ success: false, message: 'Warning not found' });
        res.json({ success: true });
    } catch (error) {
        console.error('Acknowledge warning error:', error);
        res.status(500).json({ success: false, message: 'Failed to acknowledge the warning' });
    }
}

module.exports = { createReport, listWarnings, acknowledgeWarning };
