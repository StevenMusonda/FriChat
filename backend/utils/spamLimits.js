/**
 * Spam limit for new accounts: how many messages an hour they may send to people who aren't
 * contacts yet, i.e. in direct chats the other person hasn't accepted (config/moderation.js).
 *
 * Counted from the messages table, so it holds across restarts and for every send path;
 * utils/groups.js checkCanPost calls it, and the forward endpoint calls it directly.
 * Soft-deleted messages still count, so deleting a message doesn't win back the allowance.
 */

const { queryOne } = require('../config/database');
const { spamConfig } = require('../config/moderation');

const isPostgres = () => process.env.DB_TYPE === 'postgresql';

function minusHoursSql() {
    return isPostgres()
        ? "CURRENT_TIMESTAMP - CAST(? AS INTEGER) * INTERVAL '1 hour'"
        : 'DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? HOUR)';
}

function limitError(limit) {
    return {
        status: 429,
        code: 'SPAM_LIMIT',
        message: `New accounts can send ${limit} messages an hour to people who haven't accepted their request yet. Please try again later.`
    };
}

/**
 * @returns {Promise<null | { status, code, message }>} an error when this send goes over the limit
 */
async function checkNonContactLimit(chatId, userId) {
    const { newAccountHours, nonContactMessagesPerHour: limit } = spamConfig();
    if (newAccountHours === 0 || limit === 0) return null;

    // Only the side who asked: the recipient of a request can't post until they accept it
    const request = await queryOne(
        "SELECT chat_id FROM message_requests WHERE chat_id = ? AND requester_id = ? AND status <> 'accepted'",
        [chatId, userId]
    );
    if (!request) return null;

    const newAccount = await queryOne(
        `SELECT id FROM users WHERE id = ? AND created_at > ${minusHoursSql()}`,
        [userId, newAccountHours]
    );
    if (!newAccount) return null;

    const sent = await queryOne(`
        SELECT COUNT(*) AS count
        FROM messages m
        JOIN message_requests mr ON mr.chat_id = m.chat_id AND mr.requester_id = m.sender_id
        WHERE m.sender_id = ? AND mr.status <> 'accepted' AND m.created_at > ${minusHoursSql()}
    `, [userId, 1]);

    return sent && parseInt(sent.count, 10) >= limit ? limitError(limit) : null;
}

module.exports = { checkNonContactLimit };
