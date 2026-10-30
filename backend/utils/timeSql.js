/**
 * Absolute times picked by a user (scheduled sends, reminders, poll closing) without timezone bugs.
 *
 * Clients send an ISO 8601 instant with an offset ("2026-11-02T08:00:00.000Z"). The server turns it
 * into "seconds from now" and stores CURRENT_TIMESTAMP + that many seconds, so the stored value is on
 * the database's own clock and compares cleanly with CURRENT_TIMESTAMP (same idea as invite and
 * session expiry). Reading back, SQL computes "seconds until" and the API answers with a UTC ISO
 * string, so neither Node's nor the database's timezone ever shifts a time. Browsers display it
 * in the viewer's own timezone.
 */

const { dbType } = require('../config/database');
const { MIN_LEAD_SECONDS, MAX_SCHEDULE_DAYS } = require('../config/scheduling');

// ISO 8601 with an explicit offset: a bare "2026-11-02T08:00" would mean the server's local time
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * SQL for CURRENT_TIMESTAMP plus one bound parameter of whole seconds
 */
function plusSecondsSql() {
    return dbType === 'postgresql'
        ? "CURRENT_TIMESTAMP + (CAST(? AS INTEGER) * INTERVAL '1 second')"
        : 'CURRENT_TIMESTAMP + INTERVAL ? SECOND';
}

/**
 * SQL for whole seconds from now until `column` (negative once it's past; NULL stays NULL).
 * `column` is always a fixed identifier from our own code, never user input.
 */
function secondsUntilSql(column) {
    return dbType === 'postgresql'
        ? `CAST(EXTRACT(EPOCH FROM (${column} - CURRENT_TIMESTAMP)) AS INTEGER)`
        : `TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, ${column})`;
}

/**
 * SQL for CURRENT_TIMESTAMP minus a constant number of seconds (a config value, never user input)
 */
function minusSecondsSql(seconds) {
    const n = parseInt(seconds, 10);
    return dbType === 'postgresql'
        ? `CURRENT_TIMESTAMP - INTERVAL '${n} seconds'`
        : `CURRENT_TIMESTAMP - INTERVAL ${n} SECOND`;
}

/**
 * SQL value for a new message's expires_at: now + the chat's disappearing-messages timer, or NULL
 * when the timer is off. Takes one bound parameter, the chat id. Every insert into messages uses it,
 * so a message can never be stored without the expiry its chat had when it was sent.
 */
function chatExpiresAtSql() {
    return dbType === 'postgresql'
        ? "(SELECT CASE WHEN dc.disappearing_seconds > 0 THEN CURRENT_TIMESTAMP + (dc.disappearing_seconds * INTERVAL '1 second') ELSE NULL END FROM chats dc WHERE dc.id = ?)"
        : '(SELECT CASE WHEN dc.disappearing_seconds > 0 THEN CURRENT_TIMESTAMP + INTERVAL dc.disappearing_seconds SECOND ELSE NULL END FROM chats dc WHERE dc.id = ?)';
}

/**
 * "seconds until" from SQL -> UTC ISO string (null when there's no time)
 */
function isoFromSecondsUntil(seconds, now = Date.now()) {
    if (seconds === null || seconds === undefined || seconds === '') return null;
    const n = Number(seconds);
    if (!Number.isFinite(n)) return null;
    return new Date(now + n * 1000).toISOString();
}

function isIsoWithOffset(value) {
    return typeof value === 'string' && ISO_WITH_OFFSET.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Seconds from now until an ISO instant, if it's inside the allowed window
 * @returns {{ ok: true, seconds: number } | { ok: false, error: string }}
 */
function secondsFromNow(value, now = Date.now()) {
    if (!isIsoWithOffset(value)) {
        return { ok: false, error: 'Time must be an ISO 8601 date and time with a timezone offset' };
    }
    const seconds = Math.round((Date.parse(value) - now) / 1000);
    if (seconds < MIN_LEAD_SECONDS) {
        return { ok: false, error: 'Pick a time in the future' };
    }
    if (seconds > MAX_SCHEDULE_DAYS * 24 * 60 * 60) {
        return { ok: false, error: `Pick a time within ${MAX_SCHEDULE_DAYS} days` };
    }
    return { ok: true, seconds };
}

module.exports = {
    plusSecondsSql,
    secondsUntilSql,
    minusSecondsSql,
    chatExpiresAtSql,
    isoFromSecondsUntil,
    isIsoWithOffset,
    secondsFromNow
};
