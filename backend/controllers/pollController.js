/**
 * Poll Controller (rules in utils/polls.js; the poll_vote socket event uses the same functions)
 */

const polls = require('../utils/polls');
const { secondsFromNow } = require('../utils/timeSql');

function sendError(res, error) {
    return res.status(error.status || 400).json({
        success: false,
        message: error.message,
        code: error.code
    });
}

/**
 * POST /api/polls
 * Body: chatId, question, options (2-12), multipleChoice?, anonymous?, closesAt? (ISO with offset)
 */
async function createPoll(req, res) {
    try {
        const { chatId, question, options, multipleChoice, anonymous, closesAt } = req.body;
        let closesInSeconds = null;
        if (closesAt) {
            // Validated already; re-checked in case it slipped into the past meanwhile
            const parsed = secondsFromNow(closesAt);
            if (!parsed.ok) return sendError(res, { status: 400, message: parsed.error });
            closesInSeconds = parsed.seconds;
        }

        const result = await polls.createPoll(req.io, req.user.id, {
            chatId, question, options, multipleChoice, anonymous, closesInSeconds
        });
        if (result.error) return sendError(res, result.error);

        res.status(201).json({ success: true, data: result.message });
    } catch (error) {
        console.error('Create poll error:', error);
        res.status(500).json({ success: false, message: 'Failed to create poll' });
    }
}

/**
 * GET /api/polls/:pollId - current counts, voters (unless anonymous) and the caller's own votes
 */
async function getPoll(req, res) {
    try {
        const membership = await polls.findPollForMember(req.params.pollId, req.user.id);
        if (!membership) return sendError(res, { status: 404, message: 'Poll not found' });

        const poll = await polls.getPollState(req.params.pollId, req.user.id);
        res.json({ success: true, data: poll });
    } catch (error) {
        console.error('Get poll error:', error);
        res.status(500).json({ success: false, message: 'Failed to load poll' });
    }
}

/**
 * PUT /api/polls/:pollId/votes - Body: optionIds (the whole selection; [] takes the vote back)
 */
async function vote(req, res) {
    try {
        const result = await polls.setVotes(req.io, req.user.id, req.params.pollId, req.body.optionIds);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.poll });
    } catch (error) {
        console.error('Poll vote error:', error);
        res.status(500).json({ success: false, message: 'Failed to save your vote' });
    }
}

/**
 * POST /api/polls/:pollId/close - creator only
 */
async function closePoll(req, res) {
    try {
        const result = await polls.closePoll(req.io, req.user.id, req.params.pollId);
        if (result.error) return sendError(res, result.error);
        res.json({ success: true, data: result.poll });
    } catch (error) {
        console.error('Close poll error:', error);
        res.status(500).json({ success: false, message: 'Failed to close poll' });
    }
}

module.exports = { createPoll, getPoll, vote, closePoll };
