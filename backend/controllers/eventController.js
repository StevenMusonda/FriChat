/**
 * Event Controller (rules in utils/events.js; the event_rsvp socket event uses the same functions)
 */

const events = require('../utils/events');
const { buildIcs, icsFileName } = require('../utils/eventIcs');

function sendError(res, error) {
    return res.status(error.status || 400).json({
        success: false,
        message: error.message,
        code: error.code
    });
}

/**
 * ISO times from the body -> seconds from now (validated already; re-parsed for the exact value)
 * @returns {{ startsInSeconds?, endsInSeconds? } | { error }}
 */
function timesFromBody(body) {
    const times = {};
    for (const [field, key] of [['startsAt', 'startsInSeconds'], ['endsAt', 'endsInSeconds']]) {
        if (body[field] === undefined) continue;
        const parsed = events.eventSecondsFromNow(body[field]);
        if (!parsed.ok) return { error: { status: 400, message: parsed.error } };
        times[key] = parsed.seconds;
    }
    return times;
}

/**
 * POST /api/events
 * Body: chatId, title, description?, location?, timezone? (IANA), startsAt, endsAt (ISO with offset),
 *       reminders? (any of 'start', '1h', '1d')
 */
async function createEvent(req, res) {
    try {
        const times = timesFromBody(req.body);
        if (times.error) return sendError(res, times.error);
        const { chatId, title, description, location, timezone, reminders } = req.body;
        const result = await events.createEvent(req.io, req.user.id, {
            chatId, title, description, location, timezone, reminders, ...times
        });
        if (result.error) return sendError(res, result.error);
        res.status(201).json({ success: true, data: result.message });
    } catch (error) {
        console.error('Create event error:', error);
        res.status(500).json({ success: false, message: 'Failed to create the event' });
    }
}

/**
 * GET /api/events?chatId=&scope=upcoming|past - one chat's events, or (no chatId) "My events"
 * across every chat the user is in
 */
async function listEvents(req, res) {
    try {
        const scope = req.query.scope || 'upcoming';
        const result = req.query.chatId
            ? await events.listChatEvents(req.user.id, req.query.chatId, scope)
            : await events.listMyEvents(req.user.id, scope);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.events });
    } catch (error) {
        console.error('List events error:', error);
        res.status(500).json({ success: false, message: 'Failed to load events' });
    }
}

/**
 * GET /api/events/:eventId
 */
async function getEvent(req, res) {
    try {
        const result = await events.getEventForMember(req.params.eventId, req.user.id);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.event });
    } catch (error) {
        console.error('Get event error:', error);
        res.status(500).json({ success: false, message: 'Failed to load the event' });
    }
}

/**
 * PATCH /api/events/:eventId - creator only; send only what changes
 */
async function updateEvent(req, res) {
    try {
        const times = timesFromBody(req.body);
        if (times.error) return sendError(res, times.error);
        const changes = { ...times };
        for (const field of ['title', 'description', 'location', 'timezone', 'reminders']) {
            if (req.body[field] !== undefined) changes[field] = req.body[field];
        }
        const result = await events.updateEvent(req.io, req.user.id, req.params.eventId, changes);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.event });
    } catch (error) {
        console.error('Update event error:', error);
        res.status(500).json({ success: false, message: 'Failed to update the event' });
    }
}

/**
 * POST /api/events/:eventId/cancel - creator only
 */
async function cancelEvent(req, res) {
    try {
        const result = await events.cancelEvent(req.io, req.user.id, req.params.eventId);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.event });
    } catch (error) {
        console.error('Cancel event error:', error);
        res.status(500).json({ success: false, message: 'Failed to cancel the event' });
    }
}

/**
 * PUT /api/events/:eventId/rsvp - Body: { response: 'going' | 'maybe' | 'declined' | null }
 */
async function setRsvp(req, res) {
    try {
        const result = await events.setRsvp(req.io, req.user.id, req.params.eventId, req.body.response);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.event });
    } catch (error) {
        console.error('Event RSVP error:', error);
        res.status(500).json({ success: false, message: 'Failed to save your answer' });
    }
}

/**
 * GET /api/events/:eventId/ics - the event as a calendar file (members only)
 */
async function downloadIcs(req, res) {
    try {
        const result = await events.getEventForMember(req.params.eventId, req.user.id);
        if (result.error) return sendError(res, result.error);
        const ics = buildIcs(result.event, { host: req.hostname || 'frichat' });
        res.set({
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${icsFileName(result.event)}"`,
            'Cache-Control': 'no-store'
        });
        res.send(ics);
    } catch (error) {
        console.error('Event .ics error:', error);
        res.status(500).json({ success: false, message: 'Failed to build the calendar file' });
    }
}

module.exports = { createEvent, listEvents, getEvent, updateEvent, cancelEvent, setRsvp, downloadIcs };
