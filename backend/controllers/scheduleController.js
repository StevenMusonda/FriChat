/**
 * Scheduled messages and message reminders (rules in utils/scheduledMessages.js and utils/reminders.js).
 * Times come in as ISO 8601 with an offset (validated in utils/validation.js) and are stored as
 * seconds from now on the database clock, so the user's timezone never matters to the server.
 */

const scheduled = require('../utils/scheduledMessages');
const reminders = require('../utils/reminders');
const { secondsFromNow } = require('../utils/timeSql');

/**
 * Seconds from now for a validated time; re-checked here in case it slipped into the past meanwhile
 */
function secondsOrError(res, value) {
    const parsed = secondsFromNow(value);
    if (!parsed.ok) {
        sendError(res, { status: 400, message: parsed.error });
        return null;
    }
    return parsed.seconds;
}

function sendError(res, error) {
    return res.status(error.status || 400).json({
        success: false,
        message: error.message,
        code: error.code
    });
}

/**
 * GET /api/scheduled-messages?chatId= - pending and failed, soonest first
 */
async function listScheduled(req, res) {
    try {
        const data = await scheduled.listScheduled(req.user.id, req.query.chatId || null);
        res.json({ success: true, data });
    } catch (error) {
        console.error('List scheduled messages error:', error);
        res.status(500).json({ success: false, message: 'Failed to load scheduled messages' });
    }
}

/**
 * POST /api/scheduled-messages - Body: chatId, content, sendAt, replyToMessageId?
 */
async function createScheduled(req, res) {
    try {
        const { chatId, content, sendAt, replyToMessageId } = req.body;
        const sendInSeconds = secondsOrError(res, sendAt);
        if (sendInSeconds === null) return;
        const result = await scheduled.createScheduled(req.io, req.user.id, {
            chatId,
            content,
            replyToMessageId: replyToMessageId || null,
            sendInSeconds
        });
        if (result.error) return sendError(res, result.error);
        res.status(201).json({ success: true, data: result.scheduledMessage });
    } catch (error) {
        console.error('Schedule message error:', error);
        res.status(500).json({ success: false, message: 'Failed to schedule message' });
    }
}

/**
 * PATCH /api/scheduled-messages/:scheduledId - Body: content?, sendAt?
 */
async function updateScheduled(req, res) {
    try {
        const changes = {};
        if (req.body.content !== undefined) changes.content = req.body.content;
        if (req.body.sendAt !== undefined) {
            changes.sendInSeconds = secondsOrError(res, req.body.sendAt);
            if (changes.sendInSeconds === null) return;
        }

        const result = await scheduled.updateScheduled(req.io, req.user.id, req.params.scheduledId, changes);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.scheduledMessage });
    } catch (error) {
        console.error('Update scheduled message error:', error);
        res.status(500).json({ success: false, message: 'Failed to update scheduled message' });
    }
}

/**
 * DELETE /api/scheduled-messages/:scheduledId - cancel (pending) or dismiss (failed)
 */
async function cancelScheduled(req, res) {
    try {
        const result = await scheduled.cancelScheduled(req.io, req.user.id, req.params.scheduledId);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.scheduledMessage });
    } catch (error) {
        console.error('Cancel scheduled message error:', error);
        res.status(500).json({ success: false, message: 'Failed to cancel scheduled message' });
    }
}

/**
 * GET /api/reminders?status=pending|fired
 */
async function listReminders(req, res) {
    try {
        const data = await reminders.listReminders(req.user.id, req.query.status || null);
        res.json({ success: true, data });
    } catch (error) {
        console.error('List reminders error:', error);
        res.status(500).json({ success: false, message: 'Failed to load reminders' });
    }
}

/**
 * POST /api/reminders - Body: messageId, remindAt
 */
async function createReminder(req, res) {
    try {
        const remindInSeconds = secondsOrError(res, req.body.remindAt);
        if (remindInSeconds === null) return;
        const result = await reminders.createReminder(req.io, req.user.id, {
            messageId: req.body.messageId,
            remindInSeconds
        });
        if (result.error) return sendError(res, result.error);
        res.status(201).json({ success: true, data: result.reminder });
    } catch (error) {
        console.error('Create reminder error:', error);
        res.status(500).json({ success: false, message: 'Failed to set reminder' });
    }
}

/**
 * DELETE /api/reminders/:reminderId - cancel a pending reminder or dismiss a fired one
 */
async function deleteReminder(req, res) {
    try {
        const result = await reminders.deleteReminder(req.io, req.user.id, req.params.reminderId);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.reminder });
    } catch (error) {
        console.error('Delete reminder error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove reminder' });
    }
}

module.exports = {
    listScheduled,
    createScheduled,
    updateScheduled,
    cancelScheduled,
    listReminders,
    createReminder,
    deleteReminder
};
