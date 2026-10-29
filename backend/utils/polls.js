/**
 * Polls: a chat message of type 'poll' plus rows in polls / poll_options / poll_votes.
 * Shared by the REST controller and the poll_vote socket event.
 *
 * Voting sets the user's whole selection (optionIds), so repeating the same event changes nothing.
 * The database enforces the rules too: UNIQUE (option_id, user_id) is one vote per option per user,
 * and UNIQUE (poll_id, user_id, choice_slot) with choice_slot = 0 in single-choice polls means a
 * user can never hold two votes there, however many events race each other.
 */

const { executeQuery, queryOne, insertAndGetId, updateAndCount, dbType } = require('../config/database');
const { stripControlChars } = require('./messageText');
const { toBool } = require('./messageQueries');
const { checkCanPost } = require('./groups');
const { deliverNewMessage } = require('./messageDelivery');
const { plusSecondsSql, secondsUntilSql, isoFromSecondsUntil } = require('./timeSql');
const {
    POLL_QUESTION_MAX_LENGTH,
    POLL_OPTION_MAX_LENGTH,
    POLL_MIN_OPTIONS,
    POLL_MAX_OPTIONS
} = require('../config/scheduling');

const CLOSED_SQL = '(p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at <= CURRENT_TIMESTAMP))';

/**
 * Clean the question and options (stored raw like message text; clients escape on render)
 * @returns {{ ok: true, question, options } | { ok: false, error }}
 */
function cleanPollInput(question, options) {
    if (typeof question !== 'string') return { ok: false, error: 'The question must be text' };
    const cleanQuestion = stripControlChars(question).trim();
    if (!cleanQuestion) return { ok: false, error: 'Ask a question' };
    if (cleanQuestion.length > POLL_QUESTION_MAX_LENGTH) {
        return { ok: false, error: `The question must be at most ${POLL_QUESTION_MAX_LENGTH} characters` };
    }

    if (!Array.isArray(options)) return { ok: false, error: 'Options must be a list' };
    const cleanOptions = [];
    const seen = new Set();
    for (const option of options) {
        if (typeof option !== 'string') return { ok: false, error: 'Each option must be text' };
        // One line each
        const text = stripControlChars(option).replace(/\s+/g, ' ').trim();
        if (!text) continue; // empty rows in the form are ignored
        if (text.length > POLL_OPTION_MAX_LENGTH) {
            return { ok: false, error: `Options must be at most ${POLL_OPTION_MAX_LENGTH} characters` };
        }
        const key = text.toLowerCase();
        if (seen.has(key)) return { ok: false, error: 'Options must be different from each other' };
        seen.add(key);
        cleanOptions.push(text);
    }
    if (cleanOptions.length < POLL_MIN_OPTIONS || cleanOptions.length > POLL_MAX_OPTIONS) {
        return { ok: false, error: `A poll needs ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options` };
    }
    return { ok: true, question: cleanQuestion, options: cleanOptions };
}

/**
 * Raw poll rows for the given polls (by message id or poll id), with options and votes
 * @returns {Promise<Map<number, Object>>} pollId -> { poll, options, votes }
 */
async function loadPollRows(column, ids) {
    const result = new Map();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(', ');
    const where = column === 'message_id' ? 'p.message_id' : 'p.id';

    const polls = await executeQuery(`
        SELECT p.id, p.message_id, p.chat_id, p.created_by, p.question, p.multiple_choice, p.anonymous,
               ${secondsUntilSql('p.closes_at')} AS closes_in,
               ${secondsUntilSql('p.closed_at')} AS closed_in,
               CASE WHEN ${CLOSED_SQL} THEN 1 ELSE 0 END AS is_closed,
               cu.username AS creator_username, cu.full_name AS creator_full_name
        FROM polls p
        JOIN users cu ON cu.id = p.created_by
        WHERE ${where} IN (${placeholders})
    `, ids);
    if (polls.length === 0) return result;

    const pollIds = polls.map(p => p.id);
    const pollPlaceholders = pollIds.map(() => '?').join(', ');
    const [options, votes] = await Promise.all([
        executeQuery(
            `SELECT id, poll_id, position, option_text FROM poll_options WHERE poll_id IN (${pollPlaceholders}) ORDER BY poll_id, position`,
            pollIds
        ),
        executeQuery(`
            SELECT v.poll_id, v.option_id, v.user_id, u.username, u.full_name
            FROM poll_votes v
            JOIN users u ON u.id = v.user_id
            WHERE v.poll_id IN (${pollPlaceholders})
            ORDER BY v.id
        `, pollIds)
    ]);

    for (const poll of polls) result.set(Number(poll.id), { poll, options: [], votes: [] });
    for (const option of options) result.get(Number(option.poll_id)).options.push(option);
    for (const vote of votes) result.get(Number(vote.poll_id)).votes.push(vote);
    return result;
}

/**
 * The poll as clients see it. Counts and percentages for everyone; who voted only when the poll
 * isn't anonymous; myVotes only for the viewer (omitted for room broadcasts, where viewerId is null).
 * Percentages are of the people who voted (in multiple-choice polls they can add up past 100).
 */
function shapePoll({ poll, options, votes }, viewerId = null, now = Date.now()) {
    const anonymous = toBool(poll.anonymous);
    const voters = new Set(votes.map(v => Number(v.user_id)));
    const voterCount = voters.size;
    const closed = !!parseInt(poll.is_closed);
    const createdByName = poll.creator_full_name || poll.creator_username || null;

    // Only the creator can close early, and the scheduler closes at closes_at (closed_at = closes_at),
    // so a poll closed before its closing time (or without one) was closed by its creator.
    // closed_at is still NULL in the moments between closes_at passing and the scheduler's tick.
    const closesIn = poll.closes_in === null || poll.closes_in === undefined ? null : Number(poll.closes_in);
    const closedIn = poll.closed_in === null || poll.closed_in === undefined ? null : Number(poll.closed_in);
    const closedAutomatically = closed && closesIn !== null && (closedIn === null || closedIn >= closesIn);

    const shaped = {
        id: Number(poll.id),
        messageId: Number(poll.message_id),
        chatId: Number(poll.chat_id),
        createdBy: Number(poll.created_by),
        question: poll.question,
        multipleChoice: toBool(poll.multiple_choice),
        anonymous,
        createdByName,
        closed,
        closesAt: isoFromSecondsUntil(poll.closes_in, now),
        closedAt: closed ? isoFromSecondsUntil(closedAutomatically && closedIn === null ? closesIn : closedIn, now) : null,
        closedAutomatically,
        closedBy: closed && !closedAutomatically ? { userId: Number(poll.created_by), name: createdByName } : null,
        voterCount,
        options: options.map(option => {
            const optionVotes = votes.filter(v => Number(v.option_id) === Number(option.id));
            return {
                id: Number(option.id),
                text: option.option_text,
                votes: optionVotes.length,
                percent: voterCount ? Math.round((optionVotes.length / voterCount) * 100) : 0,
                voters: anonymous ? [] : optionVotes.map(v => ({
                    userId: Number(v.user_id),
                    name: v.full_name || v.username
                }))
            };
        })
    };

    if (viewerId !== null && viewerId !== undefined) {
        shaped.myVotes = votes.filter(v => Number(v.user_id) === Number(viewerId)).map(v => Number(v.option_id));
    }
    return shaped;
}

async function getPollState(pollId, viewerId = null) {
    const rows = await loadPollRows('id', [pollId]);
    const raw = rows.get(Number(pollId));
    return raw ? shapePoll(raw, viewerId) : null;
}

/**
 * Put `poll` on every poll message of a page (one set of queries for the page).
 * Polls deleted for everyone get nothing.
 */
async function attachPolls(messages, viewerId) {
    const pollMessages = messages.filter(m => m && m.message_type === 'poll' && !toBool(m.deleted_for_everyone));
    if (pollMessages.length === 0) return messages;

    const rows = await loadPollRows('message_id', pollMessages.map(m => m.id));
    const byMessage = new Map();
    for (const raw of rows.values()) byMessage.set(Number(raw.poll.message_id), raw);
    for (const message of pollMessages) {
        const raw = byMessage.get(Number(message.id));
        message.poll = raw ? shapePoll(raw, viewerId) : null;
    }
    return messages;
}

/**
 * Tell the chat about new counts. The room copy has no myVotes; the voter's own tabs get theirs.
 */
async function broadcastPoll(io, pollId, voterId = null) {
    if (!io) return null;
    const rows = await loadPollRows('id', [pollId]);
    const raw = rows.get(Number(pollId));
    if (!raw) return null;
    io.to(`chat_${raw.poll.chat_id}`).emit('poll_updated', shapePoll(raw));
    if (voterId) io.to(`user_${voterId}`).emit('poll_updated', shapePoll(raw, voterId));
    return raw;
}

/**
 * Create a poll message in a chat
 * @param {Object} input - { chatId, question, options, multipleChoice, anonymous, closesInSeconds }
 * @returns {{ message } | { error: { status, message, code? } }}
 */
async function createPoll(io, userId, input) {
    const cleaned = cleanPollInput(input.question, input.options);
    if (!cleaned.ok) return { error: { status: 400, message: cleaned.error } };

    // Member of the chat, an admin in announcement-only groups, not blocked in a direct chat
    const postError = await checkCanPost(input.chatId, userId);
    if (postError) return { error: postError };

    const closesIn = input.closesInSeconds ? parseInt(input.closesInSeconds, 10) : null;

    const message = await deliverNewMessage(io, {
        chatId: input.chatId,
        senderId: userId,
        messageType: 'poll',
        content: cleaned.question,
        afterInsert: async (messageId) => {
            const params = [messageId, input.chatId, userId, cleaned.question, !!input.multipleChoice, !!input.anonymous];
            if (closesIn) params.push(closesIn);
            const pollId = await insertAndGetId(
                `INSERT INTO polls (message_id, chat_id, created_by, question, multiple_choice, anonymous, closes_at) VALUES (?, ?, ?, ?, ?, ?, ${closesIn ? plusSecondsSql() : 'NULL'})`,
                params
            );
            for (let i = 0; i < cleaned.options.length; i++) {
                await executeQuery(
                    'INSERT INTO poll_options (poll_id, position, option_text) VALUES (?, ?, ?)',
                    [pollId, i, cleaned.options[i]]
                );
            }
        },
        decorate: (msg) => attachPolls([msg], null)
    });

    if (!message) return { error: { status: 500, message: 'Poll created but could not be retrieved' } };
    // The creator's copy carries their (empty) selection
    if (message.poll) message.poll.myVotes = [];
    return { message };
}

/**
 * The poll, if the user is a member of its chat (404 otherwise, like a poll that doesn't exist)
 */
async function findPollForMember(pollId, userId) {
    return queryOne(`
        SELECT p.id, p.chat_id, p.created_by, p.multiple_choice, m.deleted_for_everyone,
               CASE WHEN ${CLOSED_SQL} THEN 1 ELSE 0 END AS is_closed
        FROM polls p
        JOIN messages m ON m.id = p.message_id
        JOIN group_members gm ON gm.chat_id = p.chat_id AND gm.user_id = ?
        WHERE p.id = ?
    `, [userId, pollId]);
}

/**
 * Validate the requested selection: distinct positive integers, at most POLL_MAX_OPTIONS
 * @returns {number[] | null}
 */
function normalizeOptionIds(optionIds) {
    if (!Array.isArray(optionIds) || optionIds.length > POLL_MAX_OPTIONS) return null;
    const ids = [];
    for (const value of optionIds) {
        const id = Number(value);
        if (!Number.isInteger(id) || id < 1) return null;
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

function insertVoteSql(single) {
    const base = 'INSERT INTO poll_votes (poll_id, option_id, user_id, choice_slot) VALUES (?, ?, ?, ?)';
    if (single) {
        // The one vote of a single-choice poll moves to the new option
        return dbType === 'postgresql'
            ? `${base} ON CONFLICT (poll_id, user_id, choice_slot) DO UPDATE SET option_id = EXCLUDED.option_id`
            : `${base} ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)`;
    }
    // Already voted for this option: nothing to do
    return dbType === 'postgresql'
        ? `${base} ON CONFLICT DO NOTHING`
        : `${base} ON DUPLICATE KEY UPDATE choice_slot = choice_slot`;
}

/**
 * Set the user's selection in a poll to exactly optionIds ([] takes the vote back)
 * @returns {{ poll } | { error: { status, message } }}
 */
async function setVotes(io, userId, pollId, optionIds) {
    pollId = Number(pollId);
    if (!Number.isInteger(pollId) || pollId < 1) return { error: { status: 400, message: 'Invalid poll' } };

    const ids = normalizeOptionIds(optionIds);
    if (!ids) return { error: { status: 400, message: 'Invalid options' } };

    const poll = await findPollForMember(pollId, userId);
    if (!poll) return { error: { status: 404, message: 'Poll not found' } };
    if (toBool(poll.deleted_for_everyone)) return { error: { status: 410, message: 'This poll was deleted' } };
    if (parseInt(poll.is_closed)) return { error: { status: 409, message: 'This poll is closed' } };

    const single = !toBool(poll.multiple_choice);
    if (single && ids.length > 1) {
        return { error: { status: 400, message: 'Only one option can be chosen in this poll' } };
    }

    const options = await executeQuery('SELECT id FROM poll_options WHERE poll_id = ?', [pollId]);
    const valid = new Set(options.map(o => Number(o.id)));
    if (ids.some(id => !valid.has(id))) return { error: { status: 400, message: 'That option is not in this poll' } };

    if (ids.length === 0) {
        await executeQuery('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, userId]);
    } else if (single) {
        await executeQuery(insertVoteSql(true), [pollId, ids[0], userId, 0]);
    } else {
        await executeQuery(
            `DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_id NOT IN (${ids.map(() => '?').join(', ')})`,
            [pollId, userId, ...ids]
        );
        for (const id of ids) {
            await executeQuery(insertVoteSql(false), [pollId, id, userId, id]);
        }
    }

    const raw = await broadcastPoll(io, pollId, userId);
    if (!raw) return { poll: await getPollState(pollId, userId) };
    return { poll: shapePoll(raw, userId) };
}

/**
 * Close a poll early (its creator only). Closing a closed poll just returns it.
 */
async function closePoll(io, userId, pollId) {
    const poll = await findPollForMember(pollId, userId);
    if (!poll) return { error: { status: 404, message: 'Poll not found' } };
    if (Number(poll.created_by) !== Number(userId)) {
        return { error: { status: 403, message: 'Only the person who created this poll can close it' } };
    }
    if (toBool(poll.deleted_for_everyone)) return { error: { status: 410, message: 'This poll was deleted' } };

    const changed = await updateAndCount(
        'UPDATE polls SET closed_at = CURRENT_TIMESTAMP WHERE id = ? AND closed_at IS NULL',
        [pollId]
    );
    if (changed) await broadcastPoll(io, pollId);
    return { poll: await getPollState(pollId, userId) };
}

/**
 * Scheduler: close polls whose closing time has passed and tell their chats
 */
async function closeDuePolls(io, limit = 100) {
    const due = await executeQuery(
        `SELECT id FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= CURRENT_TIMESTAMP ORDER BY closes_at LIMIT ${parseInt(limit)}`
    );
    let closed = 0;
    for (const row of due) {
        const changed = await updateAndCount(
            'UPDATE polls SET closed_at = closes_at WHERE id = ? AND closed_at IS NULL',
            [row.id]
        );
        if (changed) {
            closed++;
            await broadcastPoll(io, row.id);
        }
    }
    return closed;
}

module.exports = {
    cleanPollInput,
    shapePoll,
    loadPollRows,
    attachPolls,
    getPollState,
    findPollForMember,
    normalizeOptionIds,
    createPoll,
    setVotes,
    closePoll,
    closeDuePolls
};
