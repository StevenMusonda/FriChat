/**
 * Events (phase 12): a chat message of type 'event' (the card) plus a row in chat_events, the
 * members' answers in event_rsvps and the reminders the creator picked in event_reminders.
 * Shared by the REST controller and the event_rsvp socket event.
 *
 * Times use the same rule as scheduled messages (utils/timeSql.js): clients send ISO instants with an
 * offset, the server stores CURRENT_TIMESTAMP + n seconds and answers with UTC ISO strings. The
 * creator's IANA timezone is kept beside them so everyone can also see the time where it was planned.
 *
 * Only the creator edits or cancels; each change posts a system notice to the chat
 * ("event_updated:<id>:<fields>" / "event_cancelled:<id>", turned into text by the clients).
 * Reminders go to members who answered going or maybe, once each: the scheduler claims a row
 * (pending -> fired) before it sends anything.
 */

const { executeQuery, queryOne, insertAndGetId, updateAndCount, dbType } = require('../config/database');
const { stripControlChars } = require('./messageText');
const { toBool } = require('./messageQueries');
const { checkCanPost, getMembership } = require('./groups');
const { deliverNewMessage } = require('./messageDelivery');
const { notifyUser } = require('./push');
const { plusSecondsSql, secondsUntilSql, isoFromSecondsUntil, isIsoWithOffset } = require('./timeSql');
const { isValidTimezone } = require('./notificationSettings');
const { MIN_LEAD_SECONDS } = require('../config/scheduling');
const {
    EVENT_TITLE_MAX_LENGTH,
    EVENT_DESCRIPTION_MAX_LENGTH,
    EVENT_LOCATION_MAX_LENGTH,
    EVENT_MAX_DAYS_AHEAD,
    EVENT_MAX_LENGTH_DAYS,
    EVENT_REMINDER_OFFSETS,
    RSVP_RESPONSES,
    MAX_UPCOMING_EVENTS_PER_CHAT,
    EVENT_PAGE_SIZE,
    PLAN_BATCH_SIZE
} = require('../config/planning');

const DAY = 24 * 60 * 60;
const NOTICE_UPDATED = 'event_updated:';
const NOTICE_CANCELLED = 'event_cancelled:';
const NOTICE_PATTERN = /^event_(updated|cancelled):(\d+)(?::([a-z,]+))?$/;
// Fields an edit can change, in the order the notice lists them
const NOTICE_FIELDS = ['title', 'time', 'location', 'description'];

const SELECT_EVENT = `
    SELECT e.id, e.chat_id, e.message_id, e.created_by, e.title, e.description, e.location,
           e.timezone, e.status, e.revision,
           ${secondsUntilSql('e.starts_at')} AS starts_in,
           ${secondsUntilSql('e.ends_at')} AS ends_in,
           ${secondsUntilSql('e.cancelled_at')} AS cancelled_in,
           cu.username AS creator_username, cu.full_name AS creator_full_name
    FROM chat_events e
    JOIN users cu ON cu.id = e.created_by`;

// ===== Input =====

/**
 * One line of text: control characters and line breaks removed, spaces collapsed, trimmed
 */
function cleanLine(value) {
    return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

/**
 * Clean the text fields of a new event (all present) or an edit (only what's sent).
 * Stored raw like message text; clients escape on render.
 * @returns {{ ok: true, fields } | { ok: false, error }}
 */
function cleanEventInput(input, { partial = false } = {}) {
    const fields = {};

    if (!partial || input.title !== undefined) {
        if (typeof input.title !== 'string') return { ok: false, error: 'The title must be text' };
        const title = cleanLine(input.title);
        if (!title) return { ok: false, error: 'Give the event a title' };
        if (title.length > EVENT_TITLE_MAX_LENGTH) {
            return { ok: false, error: `The title must be at most ${EVENT_TITLE_MAX_LENGTH} characters` };
        }
        fields.title = title;
    }

    if (!partial || input.description !== undefined) {
        const raw = input.description === null || input.description === undefined ? '' : input.description;
        if (typeof raw !== 'string') return { ok: false, error: 'The description must be text' };
        // Line breaks are kept; runs of blank lines are not
        const description = stripControlChars(raw).replace(/\n{3,}/g, '\n\n').trim();
        if (description.length > EVENT_DESCRIPTION_MAX_LENGTH) {
            return { ok: false, error: `The description must be at most ${EVENT_DESCRIPTION_MAX_LENGTH} characters` };
        }
        fields.description = description || null;
    }

    if (!partial || input.location !== undefined) {
        const raw = input.location === null || input.location === undefined ? '' : input.location;
        if (typeof raw !== 'string') return { ok: false, error: 'The location must be text' };
        const location = cleanLine(raw);
        if (location.length > EVENT_LOCATION_MAX_LENGTH) {
            return { ok: false, error: `The location must be at most ${EVENT_LOCATION_MAX_LENGTH} characters` };
        }
        fields.location = location || null;
    }

    if (!partial || input.timezone !== undefined) {
        const timezone = input.timezone === undefined || input.timezone === null || input.timezone === '' ? 'UTC' : input.timezone;
        if (!isValidTimezone(timezone)) return { ok: false, error: 'Unknown timezone' };
        fields.timezone = timezone;
    }

    return { ok: true, fields };
}

/**
 * Whole seconds from now until an ISO instant with an offset (negative when it's past), if it is
 * no further away than an event may be
 * @returns {{ ok: true, seconds } | { ok: false, error }}
 */
function eventSecondsFromNow(value, now = Date.now()) {
    if (!isIsoWithOffset(value)) {
        return { ok: false, error: 'Times must be ISO 8601 dates and times with a timezone offset' };
    }
    const seconds = Math.round((Date.parse(value) - now) / 1000);
    if (Math.abs(seconds) > (EVENT_MAX_DAYS_AHEAD + EVENT_MAX_LENGTH_DAYS) * DAY) {
        return { ok: false, error: `Pick a time within ${EVENT_MAX_DAYS_AHEAD} days` };
    }
    return { ok: true, seconds };
}

/**
 * The start and end of an event, both in seconds from now
 * @param {boolean} newStart - the start is being set (it must then be in the future)
 * @returns {null | string} what's wrong, or null
 */
function checkEventTimes(startsIn, endsIn, { newStart = true } = {}) {
    if (newStart && startsIn < MIN_LEAD_SECONDS) return 'Pick a start time in the future';
    if (startsIn > EVENT_MAX_DAYS_AHEAD * DAY) return `Pick a start within ${EVENT_MAX_DAYS_AHEAD} days`;
    if (endsIn <= startsIn) return 'The event must end after it starts';
    if (endsIn - startsIn > EVENT_MAX_LENGTH_DAYS * DAY) return `An event can last at most ${EVENT_MAX_LENGTH_DAYS} days`;
    return null;
}

/**
 * ['start', '1h', '1d'] -> sorted distinct offsets in seconds, or null when something isn't a choice
 */
function normalizeReminders(reminders) {
    if (reminders === undefined || reminders === null) return [];
    if (!Array.isArray(reminders)) return null;
    const offsets = new Set();
    for (const key of reminders) {
        if (!Object.prototype.hasOwnProperty.call(EVENT_REMINDER_OFFSETS, key)) return null;
        offsets.add(EVENT_REMINDER_OFFSETS[key]);
    }
    return [...offsets].sort((a, b) => a - b);
}

function reminderKey(offset) {
    return Object.keys(EVENT_REMINDER_OFFSETS).find(key => EVENT_REMINDER_OFFSETS[key] === Number(offset)) || null;
}

// ===== Reading =====

function toNumberOrNull(value) {
    return value === null || value === undefined || value === '' ? null : Number(value);
}

/**
 * Events matching a fixed WHERE/ORDER clause (from this file, never user input), with their
 * answers and reminders
 * @returns {Promise<Array<{ event, rsvps, reminders }>>} in the query's order
 */
async function fetchEventRows(whereSql, params, orderSql = 'ORDER BY e.id') {
    const events = await executeQuery(`${SELECT_EVENT} ${whereSql} ${orderSql}`, params);
    if (events.length === 0) return [];

    const ids = events.map(e => Number(e.id));
    const placeholders = ids.map(() => '?').join(', ');
    const [rsvps, reminders] = await Promise.all([
        executeQuery(`
            SELECT r.event_id, r.user_id, r.response, u.username, u.full_name
            FROM event_rsvps r
            JOIN users u ON u.id = r.user_id
            WHERE r.event_id IN (${placeholders})
            ORDER BY r.updated_at, r.user_id
        `, ids),
        executeQuery(
            `SELECT event_id, offset_seconds, status FROM event_reminders WHERE event_id IN (${placeholders}) ORDER BY offset_seconds`,
            ids
        )
    ]);

    const byId = new Map(events.map(event => [Number(event.id), { event, rsvps: [], reminders: [] }]));
    for (const rsvp of rsvps) {
        const raw = byId.get(Number(rsvp.event_id));
        if (raw) raw.rsvps.push(rsvp);
    }
    for (const reminder of reminders) {
        const raw = byId.get(Number(reminder.event_id));
        if (raw) raw.reminders.push(reminder);
    }
    return [...byId.values()];
}

/**
 * The event as members see it: answers with names and counts, the reminder choices, and the
 * viewer's own answer (omitted for room broadcasts, where viewerId is null; clients can also find
 * themselves in the lists)
 */
function shapeEvent({ event, rsvps, reminders }, viewerId = null, now = Date.now()) {
    const startsIn = toNumberOrNull(event.starts_in);
    const endsIn = toNumberOrNull(event.ends_in);
    const cancelled = event.status === 'cancelled';
    const answers = { going: [], maybe: [], declined: [] };
    for (const rsvp of rsvps) {
        if (!answers[rsvp.response]) continue;
        answers[rsvp.response].push({ userId: Number(rsvp.user_id), name: rsvp.full_name || rsvp.username });
    }

    const shaped = {
        id: Number(event.id),
        chatId: Number(event.chat_id),
        messageId: toNumberOrNull(event.message_id),
        createdBy: Number(event.created_by),
        createdByName: event.creator_full_name || event.creator_username || null,
        title: event.title,
        description: event.description || null,
        location: event.location || null,
        timezone: event.timezone || 'UTC',
        startsAt: isoFromSecondsUntil(startsIn, now),
        endsAt: isoFromSecondsUntil(endsIn, now),
        status: cancelled ? 'cancelled' : 'active',
        cancelledAt: cancelled ? isoFromSecondsUntil(event.cancelled_in, now) : null,
        started: startsIn !== null && startsIn <= 0,
        ended: endsIn !== null && endsIn <= 0,
        revision: Number(event.revision) || 0,
        reminders: reminders.map(r => reminderKey(r.offset_seconds)).filter(Boolean),
        counts: { going: answers.going.length, maybe: answers.maybe.length, declined: answers.declined.length },
        rsvps: answers
    };

    if (viewerId !== null && viewerId !== undefined) {
        const mine = rsvps.find(r => Number(r.user_id) === Number(viewerId));
        shaped.myRsvp = mine && answers[mine.response] ? mine.response : null;
    }
    return shaped;
}

async function getEventState(eventId, viewerId = null) {
    const [raw] = await fetchEventRows('WHERE e.id = ?', [eventId]);
    return raw ? shapeEvent(raw, viewerId) : null;
}

/**
 * The event, if the user is a member of its chat (null otherwise, like an event that doesn't exist)
 */
async function findEventForMember(eventId, userId) {
    return queryOne(`
        SELECT e.id, e.chat_id, e.message_id, e.created_by, e.title, e.status,
               ${secondsUntilSql('e.starts_at')} AS starts_in,
               ${secondsUntilSql('e.ends_at')} AS ends_in
        FROM chat_events e
        JOIN group_members gm ON gm.chat_id = e.chat_id AND gm.user_id = ?
        WHERE e.id = ?
    `, [userId, eventId]);
}

/**
 * GET one event (members only)
 */
async function getEventForMember(eventId, userId) {
    const found = await findEventForMember(eventId, userId);
    if (!found) return { error: { status: 404, message: 'Event not found' } };
    return { event: await getEventState(eventId, userId) };
}

/**
 * Upcoming (not ended yet, soonest first) or past (most recent first) events of one chat
 */
async function listChatEvents(userId, chatId, scope = 'upcoming') {
    const membership = await getMembership(chatId, userId);
    if (!membership) return { error: { status: 403, message: 'Access denied to this chat' } };

    const past = scope === 'past';
    const rows = await fetchEventRows(
        `WHERE e.chat_id = ? AND e.ends_at ${past ? '<=' : '>'} CURRENT_TIMESTAMP`,
        [chatId],
        `ORDER BY e.starts_at ${past ? 'DESC' : 'ASC'}, e.id LIMIT ${parseInt(EVENT_PAGE_SIZE)}`
    );
    const now = Date.now();
    return { events: rows.map(raw => shapeEvent(raw, userId, now)) };
}

/**
 * "My events": events in every chat the user is a member of
 */
async function listMyEvents(userId, scope = 'upcoming') {
    const past = scope === 'past';
    const rows = await fetchEventRows(
        `JOIN group_members gm ON gm.chat_id = e.chat_id AND gm.user_id = ?
         WHERE e.ends_at ${past ? '<=' : '>'} CURRENT_TIMESTAMP`,
        [userId],
        `ORDER BY e.starts_at ${past ? 'DESC' : 'ASC'}, e.id LIMIT ${parseInt(EVENT_PAGE_SIZE)}`
    );
    const now = Date.now();
    return { events: rows.map(raw => shapeEvent(raw, userId, now)) };
}

/**
 * Put `event` on every event card of a page, and `event_ref` ({ id, title, status }) on the
 * "event updated / cancelled" notices. Cards deleted for everyone get nothing.
 */
async function attachEvents(messages, viewerId) {
    const cards = messages.filter(m => m && m.message_type === 'event' && !toBool(m.deleted_for_everyone));
    const notices = messages.filter(m => m && m.message_type === 'system' && NOTICE_PATTERN.test(String(m.content || '')));
    if (cards.length === 0 && notices.length === 0) return messages;

    if (cards.length > 0) {
        const ids = cards.map(m => Number(m.id));
        const rows = await fetchEventRows(`WHERE e.message_id IN (${ids.map(() => '?').join(', ')})`, ids);
        const byMessage = new Map(rows.map(raw => [Number(raw.event.message_id), raw]));
        const now = Date.now();
        for (const message of cards) {
            const raw = byMessage.get(Number(message.id));
            message.event = raw ? shapeEvent(raw, viewerId, now) : null;
        }
    }

    if (notices.length > 0) {
        const ids = [...new Set(notices.map(m => Number(NOTICE_PATTERN.exec(m.content)[2])))];
        const rows = await executeQuery(
            `SELECT id, chat_id, title, status FROM chat_events WHERE id IN (${ids.map(() => '?').join(', ')})`,
            ids
        );
        const byId = new Map(rows.map(row => [Number(row.id), row]));
        for (const message of notices) {
            const row = byId.get(Number(NOTICE_PATTERN.exec(message.content)[2]));
            // Only an event of the same chat (a notice can't point anywhere else, but never leak one)
            message.event_ref = row && Number(row.chat_id) === Number(message.chat_id)
                ? { id: Number(row.id), title: row.title, status: row.status }
                : null;
        }
    }
    return messages;
}

/**
 * Tell the chat (every member's tabs) about the event's new state
 */
async function broadcastEvent(io, eventId) {
    const [raw] = await fetchEventRows('WHERE e.id = ?', [eventId]);
    if (!raw) return null;
    if (io) io.to(`chat_${raw.event.chat_id}`).emit('event_updated', shapeEvent(raw));
    return raw;
}

// ===== Writing =====

/**
 * One reminder row per offset; a reminder whose time has already passed is kept as 'skipped'
 * (so it never fires late)
 */
async function insertReminders(eventId, startsIn, offsets) {
    for (const offset of offsets) {
        const remindIn = Number(startsIn) - offset;
        await executeQuery(
            `INSERT INTO event_reminders (event_id, offset_seconds, remind_at, status) VALUES (?, ?, ${plusSecondsSql()}, ?)`,
            [eventId, offset, Math.round(remindIn), remindIn >= MIN_LEAD_SECONDS ? 'pending' : 'skipped']
        );
    }
}

/**
 * Create an event in a chat: the card message, the event, the creator's "going" and the reminders
 * @param {Object} input - { chatId, title, description, location, timezone, startsInSeconds, endsInSeconds, reminders }
 * @returns {{ message } | { error: { status, message, code? } }}
 */
async function createEvent(io, userId, input) {
    const cleaned = cleanEventInput(input);
    if (!cleaned.ok) return { error: { status: 400, message: cleaned.error } };

    const startsIn = Number(input.startsInSeconds);
    const endsIn = Number(input.endsInSeconds);
    if (!Number.isFinite(startsIn) || !Number.isFinite(endsIn)) {
        return { error: { status: 400, message: 'Pick a start and an end time' } };
    }
    const timeError = checkEventTimes(startsIn, endsIn);
    if (timeError) return { error: { status: 400, message: timeError } };

    const offsets = normalizeReminders(input.reminders);
    if (!offsets) return { error: { status: 400, message: 'Reminders must be start, 1h or 1d' } };

    // Member of the chat, an admin in announcement-only groups, not blocked in a direct chat
    const postError = await checkCanPost(input.chatId, userId);
    if (postError) return { error: postError };

    const open = await queryOne(
        "SELECT COUNT(*) AS count FROM chat_events WHERE chat_id = ? AND status = 'active' AND ends_at > CURRENT_TIMESTAMP",
        [input.chatId]
    );
    if (open && parseInt(open.count) >= MAX_UPCOMING_EVENTS_PER_CHAT) {
        return { error: { status: 409, message: `A chat can have up to ${MAX_UPCOMING_EVENTS_PER_CHAT} upcoming events` } };
    }

    const { title, description, location, timezone } = cleaned.fields;
    const message = await deliverNewMessage(io, {
        chatId: input.chatId,
        senderId: userId,
        messageType: 'event',
        content: title,
        afterInsert: async (messageId) => {
            const eventId = await insertAndGetId(
                `INSERT INTO chat_events (chat_id, message_id, created_by, title, description, location, starts_at, ends_at, timezone, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${plusSecondsSql()}, ${plusSecondsSql()}, ?, 'active', CURRENT_TIMESTAMP)`,
                [input.chatId, messageId, userId, title, description, location, Math.round(startsIn), Math.round(endsIn), timezone]
            );
            // The person who plans it is going (and so gets the reminders)
            await executeQuery(
                "INSERT INTO event_rsvps (event_id, user_id, response) VALUES (?, ?, 'going')",
                [eventId, userId]
            );
            await insertReminders(eventId, startsIn, offsets);
        },
        decorate: (msg) => attachEvents([msg], null)
    });

    if (!message) return { error: { status: 500, message: 'Event created but could not be retrieved' } };
    if (message.event) message.event.myRsvp = 'going';
    return { message };
}

/**
 * Post an "event updated / cancelled" notice to the chat (decorated with the event's title)
 */
async function postEventNotice(io, chatId, userId, code) {
    return deliverNewMessage(io, {
        chatId,
        senderId: userId,
        messageType: 'system',
        content: code,
        decorate: (msg) => attachEvents([msg], null)
    });
}

/**
 * Edit an event (its creator only). Send only what changes:
 *   { title, description, location, timezone, startsInSeconds, endsInSeconds, reminders }
 * @returns {{ event } | { error }}
 */
async function updateEvent(io, userId, eventId, changes) {
    const found = await findEventForMember(eventId, userId);
    if (!found) return { error: { status: 404, message: 'Event not found' } };
    if (Number(found.created_by) !== Number(userId)) {
        return { error: { status: 403, message: 'Only the person who created this event can change it' } };
    }
    if (found.status === 'cancelled') return { error: { status: 409, message: 'This event was cancelled' } };

    const cleaned = cleanEventInput(changes, { partial: true });
    if (!cleaned.ok) return { error: { status: 400, message: cleaned.error } };

    const hasStart = changes.startsInSeconds !== undefined && changes.startsInSeconds !== null;
    const hasEnd = changes.endsInSeconds !== undefined && changes.endsInSeconds !== null;
    const startsIn = hasStart ? Number(changes.startsInSeconds) : Number(found.starts_in);
    const endsIn = hasEnd ? Number(changes.endsInSeconds) : Number(found.ends_in);
    if (!Number.isFinite(startsIn) || !Number.isFinite(endsIn)) return { error: { status: 400, message: 'Invalid time' } };
    // An ended event can't be moved around any more
    if ((hasStart || hasEnd) && Number(found.ends_in) <= 0) {
        return { error: { status: 409, message: 'This event has already ended' } };
    }
    const timeError = checkEventTimes(startsIn, endsIn, { newStart: hasStart });
    if (timeError) return { error: { status: 400, message: timeError } };

    let offsets = null;
    if (changes.reminders !== undefined) {
        offsets = normalizeReminders(changes.reminders);
        if (!offsets) return { error: { status: 400, message: 'Reminders must be start, 1h or 1d' } };
    }

    const sets = [];
    const params = [];
    for (const field of ['title', 'description', 'location', 'timezone']) {
        if (cleaned.fields[field] !== undefined) {
            sets.push(`${field} = ?`);
            params.push(cleaned.fields[field]);
        }
    }
    if (hasStart) {
        sets.push(`starts_at = ${plusSecondsSql()}`);
        params.push(Math.round(startsIn));
    }
    if (hasEnd) {
        sets.push(`ends_at = ${plusSecondsSql()}`);
        params.push(Math.round(endsIn));
    }
    if (sets.length === 0 && offsets === null) return { event: await getEventState(eventId, userId) };

    // What the members are told about (reminders are the creator's own business)
    const before = await getEventState(eventId);
    const changed = [];
    if (cleaned.fields.title !== undefined && cleaned.fields.title !== before.title) changed.push('title');
    const timeMoved = (hasStart && Math.abs(Date.parse(before.startsAt) - (Date.now() + startsIn * 1000)) > 30 * 1000)
        || (hasEnd && Math.abs(Date.parse(before.endsAt) - (Date.now() + endsIn * 1000)) > 30 * 1000)
        || (cleaned.fields.timezone !== undefined && cleaned.fields.timezone !== before.timezone);
    if (timeMoved) changed.push('time');
    if (cleaned.fields.location !== undefined && cleaned.fields.location !== before.location) changed.push('location');
    if (cleaned.fields.description !== undefined && cleaned.fields.description !== before.description) changed.push('description');

    if (sets.length > 0) {
        await executeQuery(
            `UPDATE chat_events SET ${sets.join(', ')}, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...params, eventId]
        );
        // The card's text is the title (chat list preview, search)
        if (cleaned.fields.title !== undefined && found.message_id) {
            await executeQuery('UPDATE messages SET content = ? WHERE id = ?', [cleaned.fields.title, found.message_id]);
        }
    }

    // A new start time schedules every reminder again (each fires once for the new time);
    // otherwise only added/removed choices change and fired ones stay fired
    const current = (before.reminders || []).map(key => EVENT_REMINDER_OFFSETS[key]);
    const wanted = offsets === null ? current : offsets;
    if (hasStart) {
        await executeQuery('DELETE FROM event_reminders WHERE event_id = ?', [eventId]);
        await insertReminders(eventId, startsIn, wanted);
    } else if (offsets !== null) {
        const removed = current.filter(offset => !wanted.includes(offset));
        if (removed.length > 0) {
            await executeQuery(
                `DELETE FROM event_reminders WHERE event_id = ? AND offset_seconds IN (${removed.map(() => '?').join(', ')})`,
                [eventId, ...removed]
            );
        }
        await insertReminders(eventId, startsIn, wanted.filter(offset => !current.includes(offset)));
    }

    if (changed.length > 0) {
        const fields = NOTICE_FIELDS.filter(field => changed.includes(field)).join(',');
        await postEventNotice(io, found.chat_id, userId, `${NOTICE_UPDATED}${Number(eventId)}:${fields}`);
    }
    await broadcastEvent(io, eventId);
    return { event: await getEventState(eventId, userId) };
}

/**
 * Cancel an event (its creator only). Cancelling a cancelled event just returns it.
 */
async function cancelEvent(io, userId, eventId) {
    const found = await findEventForMember(eventId, userId);
    if (!found) return { error: { status: 404, message: 'Event not found' } };
    if (Number(found.created_by) !== Number(userId)) {
        return { error: { status: 403, message: 'Only the person who created this event can cancel it' } };
    }

    const changed = await updateAndCount(
        "UPDATE chat_events SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
        [eventId]
    );
    if (changed) {
        await executeQuery(
            "UPDATE event_reminders SET status = 'cancelled' WHERE event_id = ? AND status = 'pending'",
            [eventId]
        );
        await postEventNotice(io, found.chat_id, userId, `${NOTICE_CANCELLED}${Number(eventId)}`);
        await broadcastEvent(io, eventId);
    }
    return { event: await getEventState(eventId, userId) };
}

function upsertRsvpSql() {
    const base = 'INSERT INTO event_rsvps (event_id, user_id, response) VALUES (?, ?, ?)';
    return dbType === 'postgresql'
        ? `${base} ON CONFLICT (event_id, user_id) DO UPDATE SET response = EXCLUDED.response, updated_at = CURRENT_TIMESTAMP`
        : `${base} ON DUPLICATE KEY UPDATE response = VALUES(response), updated_at = CURRENT_TIMESTAMP`;
}

/**
 * Answer an event: 'going' | 'maybe' | 'declined', or null to take the answer back.
 * The primary key (event_id, user_id) keeps it to one answer per member however events race.
 * @returns {{ event } | { error }}
 */
async function setRsvp(io, userId, eventId, response) {
    eventId = Number(eventId);
    if (!Number.isInteger(eventId) || eventId < 1) return { error: { status: 400, message: 'Invalid event' } };
    if (response !== null && !RSVP_RESPONSES.includes(response)) {
        return { error: { status: 400, message: 'Answer going, maybe or declined' } };
    }

    const found = await findEventForMember(eventId, userId);
    if (!found) return { error: { status: 404, message: 'Event not found' } };
    if (found.status === 'cancelled') return { error: { status: 409, message: 'This event was cancelled' } };
    if (Number(found.ends_in) <= 0) return { error: { status: 409, message: 'This event has already ended' } };

    if (response === null) {
        await executeQuery('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?', [eventId, userId]);
    } else {
        await executeQuery(upsertRsvpSql(), [eventId, userId, response]);
    }

    const raw = await broadcastEvent(io, eventId);
    return { event: raw ? shapeEvent(raw, userId) : await getEventState(eventId, userId) };
}

// ===== Reminders =====

function reminderText(event, offset) {
    if (Number(offset) >= DAY) return `${event.title} is tomorrow`;
    if (Number(offset) >= 60 * 60) return `${event.title} starts in 1 hour`;
    return `${event.title} is starting now`;
}

/**
 * Scheduler tick: send every event reminder that is due to the members going or maybe
 * @returns {Promise<{ fired: number, skipped: number, notified: number }>}
 */
async function fireDueEventReminders(io) {
    const result = { fired: 0, skipped: 0, notified: 0 };
    const due = await executeQuery(
        `SELECT id, event_id, offset_seconds FROM event_reminders WHERE status = 'pending' AND remind_at <= CURRENT_TIMESTAMP ORDER BY remind_at, id LIMIT ${parseInt(PLAN_BATCH_SIZE)}`
    );

    for (const row of due) {
        // Exactly one tick sends it
        const claimed = await updateAndCount(
            "UPDATE event_reminders SET status = 'fired', fired_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
            [row.id]
        );
        if (!claimed) continue;

        const [raw] = await fetchEventRows('WHERE e.id = ?', [row.event_id]);
        const offset = Number(row.offset_seconds);
        // Cancelled, over, or (a before-the-start reminder) already started while the server was down
        if (!raw || raw.event.status !== 'active' || Number(raw.event.ends_in) <= 0
            || (offset > 0 && Number(raw.event.starts_in) <= 0)) {
            await executeQuery("UPDATE event_reminders SET status = 'skipped' WHERE id = ?", [row.id]);
            result.skipped++;
            continue;
        }
        result.fired++;

        // Going or maybe, and still in the chat
        const recipients = await executeQuery(`
            SELECT r.user_id
            FROM event_rsvps r
            JOIN group_members gm ON gm.chat_id = ? AND gm.user_id = r.user_id
            WHERE r.event_id = ? AND r.response IN ('going', 'maybe')
        `, [raw.event.chat_id, row.event_id]);

        const event = shapeEvent(raw);
        const body = reminderText(event, offset);
        for (const { user_id: recipientId } of recipients) {
            if (io) io.to(`user_${recipientId}`).emit('event_reminder', { event, reminder: reminderKey(offset), text: body });
            notifyUser(io, recipientId, {
                type: 'event_reminder',
                chatId: event.chatId,
                messageId: event.messageId,
                title: '📅 Event reminder',
                body,
                url: event.messageId ? `chat.html?chat=${event.chatId}&message=${event.messageId}` : `chat.html?chat=${event.chatId}`,
                tag: `event-${event.id}-${reminderKey(offset)}`
            });
            result.notified++;
        }
    }
    return result;
}

module.exports = {
    NOTICE_PATTERN,
    cleanEventInput,
    eventSecondsFromNow,
    checkEventTimes,
    normalizeReminders,
    shapeEvent,
    fetchEventRows,
    getEventState,
    findEventForMember,
    getEventForMember,
    listChatEvents,
    listMyEvents,
    attachEvents,
    createEvent,
    updateEvent,
    cancelEvent,
    setRsvp,
    fireDueEventReminders
};
