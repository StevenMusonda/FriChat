/**
 * Phase 12 on both fake drivers: events (RSVP live to the chat, one answer per member even when
 * socket events race, creator-only edits with a system notice, cancelled/ended events refuse
 * answers), event reminders (to going/maybe members only, fired once when ticks overlap, still sent
 * after a "restart", skipped when cancelled), shared lists (members only, who ticked it, a second
 * tick keeps the first name, due-date reminder once to whoever set it), .ics output, birthdays and
 * the new validation rules, routes and socket events.
 *
 * The fake database keeps the tables in memory and enforces the same keys as the real schema
 * (event_rsvps primary key, event_reminders unique offset), so a broken rule shows up as a
 * duplicate row or a thrown "duplicate key" error. `now` is the database clock in seconds.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setupFakeDb, fakeIo, stubModule } = require('./helpers/fakeDb');

const ALICE = 1;
const BOB = 2;
const EVE = 3; // not a member of anything
const CAROL = 4; // member, never answers
const CHAT = 5;

function duplicateKeyError(pg) {
    const error = new Error('duplicate key');
    error.code = pg ? '23505' : 'ER_DUP_ENTRY';
    return error;
}

function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        pg,
        now: 1000,
        members: { [CHAT]: new Map([[ALICE, 'admin'], [BOB, 'member'], [CAROL, 'member']]) },
        users: { [ALICE]: 'alice', [BOB]: 'bob', [EVE]: 'eve', [CAROL]: 'carol' },
        messages: new Map(),
        events: new Map(),
        rsvps: [],
        reminders: new Map(),
        lists: new Map(),
        items: new Map(),
        nextId: { message: 500, event: 1, reminder: 1, list: 1, item: 1 }
    };
    const changed = (n) => (pg ? Array.from({ length: n }, () => ({ id: 1 })) : { affectedRows: n });
    const inserted = (id) => (pg ? [{ id }] : { insertId: id });
    const none = () => (pg ? [] : { affectedRows: 0 });
    const bool = (value) => (pg ? !!value : (value ? 1 : 0));
    const isMember = (chatId, userId) => !!world.members[chatId] && world.members[chatId].has(Number(userId));
    const until = (at) => (at === null || at === undefined ? null : at - world.now);

    function eventRow(e) {
        return {
            id: e.id, chat_id: e.chat_id, message_id: e.message_id, created_by: e.created_by,
            title: e.title, description: e.description, location: e.location, timezone: e.timezone,
            status: e.status, revision: e.revision,
            starts_in: until(e.starts_at), ends_in: until(e.ends_at), cancelled_in: until(e.cancelled_at),
            creator_username: world.users[e.created_by], creator_full_name: null
        };
    }

    function itemRow(i) {
        const done = world.users[i.done_by];
        const creator = world.users[i.created_by];
        return {
            id: i.id, list_id: i.list_id, text: i.text, done: bool(i.done), created_by: i.created_by, done_by: i.done_by,
            done_in: until(i.done_at), due_in: until(i.due_at),
            creator_username: creator || null, creator_full_name: null, done_username: done || null, done_full_name: null
        };
    }

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');

        // --- membership / posting rules (utils/groups.js)
        if (/^SELECT gm\.id, gm\.role, c\.chat_type, c\.announcement_only FROM group_members gm JOIN chats c/.test(sql)) {
            const [chatId, userId] = params;
            return isMember(chatId, userId)
                ? [{ id: 1, role: world.members[chatId].get(Number(userId)), chat_type: 'group', announcement_only: bool(false) }]
                : [];
        }
        if (/privacy_settings|message_requests|user_blocks/.test(sql) && !/birthday/.test(sql)) return [];

        // --- events
        if (/^SELECT COUNT\(\*\) AS count FROM chat_events/.test(sql)) {
            return [{ count: [...world.events.values()].filter(e => e.chat_id === Number(params[0]) && e.status === 'active' && e.ends_at > world.now).length }];
        }
        if (/^INSERT INTO chat_events/.test(sql)) {
            const [chatId, messageId, createdBy, title, description, location, startsIn, endsIn, timezone] = params;
            const id = world.nextId.event++;
            world.events.set(id, {
                id, chat_id: chatId, message_id: messageId, created_by: createdBy, title, description, location, timezone,
                starts_at: world.now + startsIn, ends_at: world.now + endsIn, status: 'active', cancelled_at: null, revision: 0
            });
            return inserted(id);
        }
        if (/^INSERT INTO event_rsvps/.test(sql)) {
            const [eventId, userId] = params;
            const response = params.length > 2 ? params[2] : 'going';
            const existing = world.rsvps.find(r => r.event_id === eventId && r.user_id === userId);
            if (existing) {
                if (!/ON CONFLICT \(event_id, user_id\) DO UPDATE|ON DUPLICATE KEY UPDATE response/.test(sql)) throw duplicateKeyError(pg);
                existing.response = response;
                return pg ? [] : { affectedRows: 2 };
            }
            world.rsvps.push({ event_id: eventId, user_id: userId, response, seq: world.rsvps.length });
            return pg ? [] : { affectedRows: 1 };
        }
        if (sql === 'DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?') {
            world.rsvps = world.rsvps.filter(r => !(r.event_id === params[0] && r.user_id === params[1]));
            return none();
        }
        if (/^INSERT INTO event_reminders/.test(sql)) {
            const [eventId, offset, remindIn, status] = params;
            if ([...world.reminders.values()].some(r => r.event_id === eventId && r.offset_seconds === offset)) throw duplicateKeyError(pg);
            const id = world.nextId.reminder++;
            world.reminders.set(id, { id, event_id: eventId, offset_seconds: offset, remind_at: world.now + remindIn, status, fired_at: null });
            return pg ? [] : { insertId: id };
        }
        if (/^SELECT e\.id, e\.chat_id, e\.message_id, e\.created_by, e\.title, e\.description/.test(sql)) {
            let rows = [...world.events.values()];
            let i = 0;
            if (/JOIN group_members gm ON gm\.chat_id = e\.chat_id AND gm\.user_id = \?/.test(sql)) {
                const userId = params[i++];
                rows = rows.filter(e => isMember(e.chat_id, userId));
            }
            if (/WHERE e\.id = \?/.test(sql)) rows = rows.filter(e => e.id === Number(params[i]));
            if (/WHERE e\.message_id IN/.test(sql)) rows = rows.filter(e => params.map(Number).includes(e.message_id));
            if (/WHERE e\.chat_id = \?/.test(sql)) rows = rows.filter(e => e.chat_id === Number(params[i]));
            if (/e\.ends_at > CURRENT_TIMESTAMP/.test(sql)) rows = rows.filter(e => e.ends_at > world.now);
            if (/e\.ends_at <= CURRENT_TIMESTAMP/.test(sql)) rows = rows.filter(e => e.ends_at <= world.now);
            return rows.sort((a, b) => a.starts_at - b.starts_at).map(eventRow);
        }
        if (/^SELECT r\.event_id, r\.user_id, r\.response, u\.username, u\.full_name FROM event_rsvps r/.test(sql)) {
            return world.rsvps.filter(r => params.map(Number).includes(r.event_id))
                .sort((a, b) => a.seq - b.seq)
                .map(r => ({ ...r, username: world.users[r.user_id], full_name: null }));
        }
        if (/^SELECT event_id, offset_seconds, status FROM event_reminders WHERE event_id IN/.test(sql)) {
            return [...world.reminders.values()].filter(r => params.map(Number).includes(r.event_id)).sort((a, b) => a.offset_seconds - b.offset_seconds);
        }
        if (/^SELECT e\.id, e\.chat_id, e\.message_id, e\.created_by, e\.title, e\.status, .* FROM chat_events e JOIN group_members gm/.test(sql)) {
            const [userId, eventId] = params;
            const e = world.events.get(Number(eventId));
            if (!e || !isMember(e.chat_id, userId)) return [];
            const row = eventRow(e);
            return [{ id: e.id, chat_id: e.chat_id, message_id: e.message_id, created_by: e.created_by, title: e.title, status: e.status, starts_in: row.starts_in, ends_in: row.ends_in }];
        }
        if (/^SELECT id, chat_id, title, status FROM chat_events WHERE id IN/.test(sql)) {
            return [...world.events.values()].filter(e => params.map(Number).includes(e.id)).map(e => ({ id: e.id, chat_id: e.chat_id, title: e.title, status: e.status }));
        }
        if (/^UPDATE chat_events SET status = 'cancelled'/.test(sql)) {
            const e = world.events.get(Number(params[0]));
            if (!e || e.status !== 'active') return changed(0);
            e.status = 'cancelled';
            e.cancelled_at = world.now;
            e.revision++;
            return changed(1);
        }
        if (/^UPDATE chat_events SET .*revision = revision \+ 1, updated_at = CURRENT_TIMESTAMP WHERE id = \?$/.test(sql)) {
            const e = world.events.get(Number(params[params.length - 1]));
            const sets = sql.replace(/^UPDATE chat_events SET /, '').replace(/, revision = revision \+ 1.*$/, '').split(', ');
            let i = 0;
            for (const set of sets) {
                const column = set.split(' = ')[0];
                const value = params[i++];
                if (column === 'starts_at' || column === 'ends_at') e[column] = world.now + value;
                else e[column] = value;
            }
            e.revision++;
            return pg ? [] : { affectedRows: 1 };
        }
        if (sql === 'UPDATE messages SET content = ? WHERE id = ?') {
            const message = world.messages.get(Number(params[1]));
            if (message) message.content = params[0];
            return pg ? [] : { affectedRows: 1 };
        }
        if (/^DELETE FROM event_reminders WHERE event_id = \?/.test(sql)) {
            const [eventId, ...offsets] = params;
            for (const [id, r] of world.reminders) {
                if (r.event_id === eventId && (offsets.length === 0 || offsets.includes(r.offset_seconds))) world.reminders.delete(id);
            }
            return none();
        }
        if (/^UPDATE event_reminders SET status = 'cancelled' WHERE event_id = \? AND status = 'pending'/.test(sql)) {
            for (const r of world.reminders.values()) if (r.event_id === params[0] && r.status === 'pending') r.status = 'cancelled';
            return none();
        }
        if (/^SELECT id, event_id, offset_seconds FROM event_reminders WHERE status = 'pending' AND remind_at <= CURRENT_TIMESTAMP/.test(sql)) {
            return [...world.reminders.values()].filter(r => r.status === 'pending' && r.remind_at <= world.now)
                .map(r => ({ id: r.id, event_id: r.event_id, offset_seconds: r.offset_seconds }));
        }
        if (/^UPDATE event_reminders SET status = 'fired'/.test(sql)) {
            const r = world.reminders.get(Number(params[0]));
            if (!r || r.status !== 'pending') return changed(0);
            r.status = 'fired';
            r.fired_at = world.now;
            return changed(1);
        }
        if (/^UPDATE event_reminders SET status = 'skipped' WHERE id = \?/.test(sql)) {
            world.reminders.get(Number(params[0])).status = 'skipped';
            return none();
        }
        if (/^SELECT r\.user_id FROM event_rsvps r JOIN group_members gm/.test(sql)) {
            const [chatId, eventId] = params;
            return world.rsvps.filter(r => r.event_id === eventId && ['going', 'maybe'].includes(r.response) && isMember(chatId, r.user_id))
                .map(r => ({ user_id: r.user_id }));
        }

        // --- lists
        if (/^SELECT COUNT\(\*\) AS count FROM chat_lists WHERE chat_id = \?/.test(sql)) {
            return [{ count: [...world.lists.values()].filter(l => l.chat_id === params[0]).length }];
        }
        if (/^INSERT INTO chat_lists/.test(sql)) {
            const [chatId, createdBy, name] = params;
            const id = world.nextId.list++;
            world.lists.set(id, { id, chat_id: chatId, created_by: createdBy, name });
            return inserted(id);
        }
        if (/^SELECT l\.id, l\.chat_id, l\.created_by, l\.name, gm\.role, c\.chat_type FROM chat_lists l/.test(sql)) {
            const [userId, listId] = params;
            const l = world.lists.get(Number(listId));
            if (!l || !isMember(l.chat_id, userId)) return [];
            return [{ ...l, role: world.members[l.chat_id].get(Number(userId)), chat_type: 'group' }];
        }
        if (/^SELECT l\.id, l\.chat_id, l\.created_by, l\.name, u\.username AS creator_username, u\.full_name AS creator_full_name FROM chat_lists l JOIN users u ON u\.id = l\.created_by WHERE l\.id = \?$/.test(sql)) {
            const l = world.lists.get(Number(params[0]));
            return l ? [{ ...l, creator_username: world.users[l.created_by], creator_full_name: null }] : [];
        }
        if (/^SELECT l\.id, .*\(SELECT COUNT\(\*\) FROM chat_list_items ci/.test(sql)) {
            return [...world.lists.values()].filter(l => l.chat_id === Number(params[0])).map(l => {
                const items = [...world.items.values()].filter(i => i.list_id === l.id);
                return { ...l, creator_username: world.users[l.created_by], creator_full_name: null, item_count: items.length, done_count: items.filter(i => i.done).length };
            });
        }
        if (/^SELECT i\.id, i\.list_id, i\.text, i\.done, i\.created_by, i\.done_by/.test(sql)) {
            return [...world.items.values()].filter(i => i.list_id === Number(params[0])).sort((a, b) => a.id - b.id).map(itemRow);
        }
        if (/^SELECT i\.id, i\.list_id, i\.chat_id, i\.done FROM chat_list_items i JOIN group_members gm/.test(sql)) {
            const [userId, itemId] = params;
            const i = world.items.get(Number(itemId));
            return i && isMember(i.chat_id, userId) ? [{ id: i.id, list_id: i.list_id, chat_id: i.chat_id, done: bool(i.done) }] : [];
        }
        if (/^SELECT COUNT\(\*\) AS count FROM chat_list_items WHERE list_id = \?/.test(sql)) {
            return [{ count: [...world.items.values()].filter(i => i.list_id === params[0]).length }];
        }
        if (/^INSERT INTO chat_list_items/.test(sql)) {
            const withDue = /due_at/.test(sql);
            const [listId, chatId, text, createdBy, dueIn, dueSetBy] = params;
            const id = world.nextId.item++;
            world.items.set(id, {
                id, list_id: listId, chat_id: chatId, text, created_by: createdBy, done: false, done_by: null, done_at: null,
                due_at: withDue ? world.now + dueIn : null, due_set_by: withDue ? dueSetBy : null, due_reminder_status: withDue ? 'pending' : 'none'
            });
            return inserted(id);
        }
        if (/^UPDATE chat_lists SET (name = \?, )?updated_at = CURRENT_TIMESTAMP WHERE id = \?/.test(sql)) {
            if (/name = \?/.test(sql)) world.lists.get(Number(params[1])).name = params[0];
            return pg ? [] : { affectedRows: 1 };
        }
        if (sql === 'UPDATE chat_list_items SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?') {
            world.items.get(Number(params[1])).text = params[0];
            return none();
        }
        if (/^UPDATE chat_list_items SET due_at = NULL/.test(sql)) {
            Object.assign(world.items.get(Number(params[0])), { due_at: null, due_set_by: null, due_reminder_status: 'none' });
            return none();
        }
        if (/^UPDATE chat_list_items SET due_at = CURRENT_TIMESTAMP/.test(sql)) {
            const [seconds, userId, itemId] = params;
            Object.assign(world.items.get(Number(itemId)), { due_at: world.now + seconds, due_set_by: userId, due_reminder_status: 'pending' });
            return none();
        }
        if (/^UPDATE chat_list_items SET done = TRUE, done_by = \?, done_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = \? AND done = FALSE$/.test(sql)) {
            const item = world.items.get(Number(params[1]));
            if (item.done) return none();
            Object.assign(item, { done: true, done_by: params[0], done_at: world.now });
            return pg ? [] : { affectedRows: 1 };
        }
        if (/^UPDATE chat_list_items SET done = FALSE, done_by = NULL, done_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = \? AND done = TRUE$/.test(sql)) {
            Object.assign(world.items.get(Number(params[0])), { done: false, done_by: null, done_at: null });
            return none();
        }
        if (sql === 'DELETE FROM chat_list_items WHERE id = ?') {
            world.items.delete(Number(params[0]));
            return none();
        }
        if (sql === 'DELETE FROM chat_lists WHERE id = ?') {
            const id = Number(params[0]);
            world.lists.delete(id);
            for (const [itemId, item] of world.items) if (item.list_id === id) world.items.delete(itemId);
            return none();
        }
        if (/^SELECT id FROM chat_list_items WHERE due_reminder_status = 'pending' AND due_at <= CURRENT_TIMESTAMP/.test(sql)) {
            return [...world.items.values()].filter(i => i.due_reminder_status === 'pending' && i.due_at <= world.now).map(i => ({ id: i.id }));
        }
        if (/^UPDATE chat_list_items SET due_reminder_status = 'fired'/.test(sql)) {
            const item = world.items.get(Number(params[0]));
            if (!item || item.due_reminder_status !== 'pending') return changed(0);
            item.due_reminder_status = 'fired';
            return changed(1);
        }
        if (/^SELECT i\.id, i\.list_id, i\.chat_id, i\.text, i\.done, i\.due_set_by, l\.name AS list_name/.test(sql)) {
            const i = world.items.get(Number(params[0]));
            if (!i) return [];
            return [{ ...i, done: bool(i.done), list_name: world.lists.get(i.list_id).name, membership_id: i.due_set_by && isMember(i.chat_id, i.due_set_by) ? 1 : null }];
        }
        if (/^SELECT id, chat_id, name FROM chat_lists WHERE id IN/.test(sql)) {
            return [...world.lists.values()].filter(l => params.map(Number).includes(l.id)).map(l => ({ id: l.id, chat_id: l.chat_id, name: l.name }));
        }

        // --- messages (the normal delivery path)
        if (/^INSERT INTO messages \(chat_id, sender_id, message_type, content, reply_to_message_id, status, expires_at\)/.test(sql)) {
            const [chatId, senderId, type, content] = params;
            const id = world.nextId.message++;
            world.messages.set(id, { id, chat_id: chatId, sender_id: senderId, message_type: type, content });
            return inserted(id);
        }
        if (sql === 'DELETE FROM messages WHERE id = ?') {
            world.messages.delete(Number(params[0]));
            return none();
        }
        if (/FROM messages m JOIN users u ON m\.sender_id = u\.id/.test(sql)) {
            const message = world.messages.get(Number(params[0]));
            return message ? [{ ...message, username: world.users[message.sender_id], deleted_for_everyone: 0 }] : [];
        }
        if (/^SELECT last_read_message_id FROM group_members/.test(sql)) return [{ last_read_message_id: 0 }];
        if (/^SELECT id FROM messages WHERE id = \? AND chat_id = \?/.test(sql)) {
            const message = world.messages.get(Number(params[0]));
            return message ? [{ id: message.id }] : [];
        }
        if (/^SELECT MAX\(id\) AS id FROM messages/.test(sql)) return [{ id: world.nextId.message - 1 }];
        // Bookkeeping of the normal message path (chat timestamp, archive, read position, counts)
        if (/^UPDATE/.test(sql)) return pg ? [] : { affectedRows: 1 };
        if (/^SELECT COUNT\(\*\) AS count/.test(sql)) return [{ count: 0 }];
        throw new Error(`Unexpected query: ${sql}`);
    };
    return world;
}

/**
 * fakeIo plus the user-room fetch that push.js uses (nobody has a visible tab)
 */
function recordingIo() {
    const io = fakeIo();
    io.in = () => ({ fetchSockets: async () => [] });
    return io;
}

function addEvent(world, { createdBy = ALICE, startsIn = 7200, endsIn = 10800, reminders = [] } = {}) {
    const messageId = world.nextId.message++;
    world.messages.set(messageId, { id: messageId, chat_id: CHAT, sender_id: createdBy, message_type: 'event', content: 'Dinner' });
    const id = world.nextId.event++;
    world.events.set(id, {
        id, chat_id: CHAT, message_id: messageId, created_by: createdBy, title: 'Dinner', description: null, location: 'Home',
        timezone: 'Europe/Berlin', starts_at: world.now + startsIn, ends_at: world.now + endsIn, status: 'active', cancelled_at: null, revision: 0
    });
    world.rsvps.push({ event_id: id, user_id: createdBy, response: 'going', seq: world.rsvps.length });
    for (const offset of reminders) {
        const rid = world.nextId.reminder++;
        world.reminders.set(rid, { id: rid, event_id: id, offset_seconds: offset, remind_at: world.now + startsIn - offset, status: 'pending', fired_at: null });
    }
    return { eventId: id, messageId };
}

const answersOf = (world, eventId) => world.rsvps.filter(r => r.event_id === eventId).map(r => `${r.user_id}:${r.response}`).sort();

describe('phase 12: event input and times', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const events = load('utils/events.js');

    test('text is cleaned to one line, optional fields become null, timezone is checked', () => {
        const ok = events.cleanEventInput({ title: '  Sunday\n lunch ', description: ' Bring\n\n\n\ncake ', location: '  ', timezone: 'Europe/Berlin' });
        assert.deepEqual(ok, { ok: true, fields: { title: 'Sunday lunch', description: 'Bring\n\ncake', location: null, timezone: 'Europe/Berlin' } });
        assert.equal(events.cleanEventInput({ title: '   ' }).ok, false);
        assert.equal(events.cleanEventInput({ title: 'x'.repeat(151) }).ok, false);
        assert.equal(events.cleanEventInput({ title: 'ok', timezone: 'Mars/Olympus' }).ok, false);
        assert.equal(events.cleanEventInput({ title: 'ok' }).fields.timezone, 'UTC');
        // An edit only checks what it sends
        assert.deepEqual(events.cleanEventInput({ location: ' Park ' }, { partial: true }), { ok: true, fields: { location: 'Park' } });
    });

    test('the same instant in different timezones is the same start; no offset is refused', () => {
        const now = Date.parse('2026-10-30T12:00:00.000Z');
        const utc = events.eventSecondsFromNow('2026-11-01T18:00:00Z', now);
        assert.deepEqual(events.eventSecondsFromNow('2026-11-01T19:00:00+01:00', now), utc);
        assert.deepEqual(events.eventSecondsFromNow('2026-11-01T13:00:00-05:00', now), utc);
        assert.equal(events.eventSecondsFromNow('2026-11-01T18:00', now).ok, false);
        assert.equal(events.eventSecondsFromNow('2030-11-01T18:00:00Z', now).ok, false);
    });

    test('start in the future, end after start, at most 31 days long', () => {
        assert.equal(events.checkEventTimes(3600, 7200), null);
        assert.match(events.checkEventTimes(-60, 7200), /future/);
        assert.equal(events.checkEventTimes(-60, 7200, { newStart: false }), null); // editing an ongoing event's end
        assert.match(events.checkEventTimes(3600, 3600), /end after/);
        assert.match(events.checkEventTimes(3600, 3600 + 32 * 86400), /31 days/);
    });

    test('reminder choices', () => {
        assert.deepEqual(events.normalizeReminders(['1d', 'start', '1h', 'start']), [0, 3600, 86400]);
        assert.deepEqual(events.normalizeReminders(undefined), []);
        assert.equal(events.normalizeReminders(['2h']), null);
        assert.equal(events.normalizeReminders('start'), null);
    });
});

describe('phase 12: .ics file', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { buildIcs, escapeText, foldLine, icsFileName } = load('utils/eventIcs.js');
    const event = {
        id: 7, title: 'Dinner; Drinks, & more', description: 'Line one\nLine two', location: 'Mum\'s, Main St',
        startsAt: '2026-11-07T17:00:00.000Z', endsAt: '2026-11-07T20:30:00.000Z', timezone: 'Europe/Berlin',
        status: 'active', revision: 2, createdByName: 'Alice &amp; Co'
    };

    test('UTC times, stable UID, SEQUENCE from the revision, escaped text', () => {
        const ics = buildIcs(event, { host: 'chat.example.com', now: new Date('2026-10-30T10:00:00Z') });
        assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
        assert.match(ics, /\r\nDTSTART:20261107T170000Z\r\n/);
        assert.match(ics, /\r\nDTEND:20261107T203000Z\r\n/);
        assert.match(ics, /\r\nUID:frichat-event-7@chat\.example\.com\r\n/);
        assert.match(ics, /\r\nSEQUENCE:2\r\n/);
        assert.match(ics, /\r\nSUMMARY:Dinner\\; Drinks\\, & more\r\n/);
        assert.match(ics, /\r\nLOCATION:Mum's\\, Main St\r\n/);
        assert.match(ics, /DESCRIPTION:Line one\\nLine two\\n\\nPlanned by Alice & Co on FriChat/);
        assert.match(ics, /\r\nSTATUS:CONFIRMED\r\n/);
        assert.match(ics, /END:VCALENDAR\r\n$/);
    });

    test('user text cannot add calendar properties', () => {
        const ics = buildIcs({ ...event, title: 'Party\r\nATTENDEE:mailto:x@evil.test\nEND:VEVENT' });
        const lines = ics.split('\r\n');
        assert.equal(lines.filter(l => /^ATTENDEE/.test(l)).length, 0);
        assert.equal(lines.filter(l => l === 'END:VEVENT').length, 1);
        assert.equal(escapeText('a\\b'), 'a\\\\b');
    });

    test('long lines fold at 75 octets without splitting a character; cancelled events say so', () => {
        const folded = foldLine(`SUMMARY:${'🎉'.repeat(40)}`);
        for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
        assert.equal(folded.replace(/\r\n /g, ''), `SUMMARY:${'🎉'.repeat(40)}`);
        assert.match(buildIcs({ ...event, status: 'cancelled' }), /STATUS:CANCELLED/);
        assert.equal(icsFileName({ title: 'Dinner; Drinks / "x"' }), 'Dinner-Drinks-x.ics');
        assert.equal(icsFileName({ title: '🎉' }), 'event.ics');
    });
});

describe('phase 12: birthdays', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const birthdays = load('utils/birthdays.js');
    const now = new Date('2026-10-30T12:00:00Z');

    test('real calendar days only; 29 February needs a leap year when the year is given', () => {
        assert.equal(birthdays.checkBirthday(29, 2, null, now), null);
        assert.equal(birthdays.checkBirthday(29, 2, 2000, now), null);
        assert.match(birthdays.checkBirthday(29, 2, 2001, now), /not in that month/);
        assert.match(birthdays.checkBirthday(31, 4, null, now), /not in that month/);
        assert.match(birthdays.checkBirthday(1, 13, null, now), /month/);
        assert.match(birthdays.checkBirthday(1, 1, 2027, now), /year/);
        assert.match(birthdays.checkBirthday(1, 1, 1850, now), /year/);
    });

    test('the viewer\'s date must be a real date within a day of today', () => {
        assert.deepEqual(birthdays.parseViewerDate('2026-10-31', now), { year: 2026, month: 10, day: 31 });
        assert.ok(birthdays.parseViewerDate('2026-10-29', now));
        assert.equal(birthdays.parseViewerDate('2026-11-05', now), null);
        assert.equal(birthdays.parseViewerDate('2026-02-30', now), null);
        assert.equal(birthdays.parseViewerDate('31.10.2026', now), null);
    });

    for (const dbType of ['mysql', 'postgresql']) {
        test(`banner: members only, groups only, "nobody" and blocks hide it, 29 Feb on 28 Feb (${dbType})`, async () => {
            const people = [
                { id: BOB, username: 'bob', full_name: null, birthday_audience: null, birthday_day: 28, birthday_month: 2 },
                { id: CAROL, username: 'carol', full_name: 'Carol', birthday_audience: 'nobody', birthday_day: 28, birthday_month: 2 },
                { id: ALICE, username: 'alice', full_name: null, birthday_audience: 'nobody', birthday_day: 29, birthday_month: 2 }
            ];
            let blockedBy = [];
            const fake = setupFakeDb(dbType, (sql, params) => {
                if (/^SELECT gm\.id, gm\.role, c\.chat_type/.test(sql)) {
                    return [ALICE, BOB, CAROL].includes(Number(params[1])) ? [{ id: 1, role: 'member', chat_type: params[0] === 9 ? 'direct' : 'group' }] : [];
                }
                if (/FROM group_members gm JOIN users u ON u\.id = gm\.user_id LEFT JOIN privacy_settings/.test(sql)) {
                    const [, month, d1, d2] = params;
                    return people.filter(p => p.birthday_month === month && [d1, d2].includes(p.birthday_day)).sort((a, b) => a.id - b.id);
                }
                if (/user_blocks/.test(sql)) return blockedBy.map(id => ({ blocker_id: id }));
                throw new Error(`Unexpected query: ${sql}`);
            });
            const { birthdaysInChat } = fake.load('utils/birthdays.js');
            const feb28 = new Date('2027-02-28T09:00:00Z'); // 2027 is not a leap year

            const forAlice = await birthdaysInChat(ALICE, CHAT, '2027-02-28', feb28);
            // Bob (default audience), Alice herself (her own 29 Feb), not Carol ("nobody")
            assert.deepEqual(forAlice.birthdays.map(b => [b.userId, b.isSelf]), [[ALICE, true], [BOB, false]]);

            blockedBy = [BOB];
            const blocked = await birthdaysInChat(ALICE, CHAT, '2027-02-28', feb28);
            assert.deepEqual(blocked.birthdays.map(b => b.userId), [ALICE]);

            assert.equal((await birthdaysInChat(EVE, CHAT, '2027-02-28', feb28)).error.status, 403);
            assert.equal((await birthdaysInChat(ALICE, CHAT, '2027-03-05', feb28)).error.status, 400);
            assert.deepEqual(await birthdaysInChat(ALICE, 9, '2027-02-28', feb28), { birthdays: [] });
        });
    }
});

for (const dbType of ['mysql', 'postgresql']) {
    describe(`phase 12: events (${dbType})`, () => {
        function setup(world = createWorld(dbType)) {
            const fake = setupFakeDb(dbType, world.handler);
            return { world, events: fake.load('utils/events.js'), io: recordingIo() };
        }

        test('creating an event posts a card, the creator is going, past reminders are skipped', async () => {
            const { world, events, io } = setup();
            const refused = await events.createEvent(io, EVE, { chatId: CHAT, title: 'x', startsInSeconds: 3600, endsInSeconds: 7200 });
            assert.equal(refused.error.code, 'NOT_A_MEMBER');
            assert.equal(world.events.size, 0);

            const result = await events.createEvent(io, ALICE, {
                chatId: CHAT, title: ' Dinner ', location: 'Home', timezone: 'Europe/Berlin',
                startsInSeconds: 3 * 3600, endsInSeconds: 5 * 3600, reminders: ['start', '1h', '1d']
            });
            assert.equal(result.message.message_type, 'event');
            assert.equal(result.message.event.title, 'Dinner');
            assert.equal(result.message.event.myRsvp, 'going');
            assert.deepEqual(result.message.event.counts, { going: 1, maybe: 0, declined: 0 });
            assert.deepEqual(answersOf(world, result.message.event.id), [`${ALICE}:going`]);
            // 1 day before a start 3 hours away has already passed: kept as skipped, never fires late
            assert.deepEqual([...world.reminders.values()].map(r => [r.offset_seconds, r.status]), [[0, 'pending'], [3600, 'pending'], [86400, 'skipped']]);
            const card = io.emitted.find(e => e.event === 'new_message');
            assert.equal(card.room, `chat_${CHAT}`);
            assert.equal(card.data.event.timezone, 'Europe/Berlin');
        });

        test('answers go live to the chat with names; repeated and racing events keep one answer per member', async () => {
            const { world, events, io } = setup();
            const { eventId } = addEvent(world);

            await Promise.all(Array.from({ length: 6 }, (_, i) => events.setRsvp(io, BOB, eventId, i % 2 ? 'maybe' : 'going')));
            assert.equal(world.rsvps.filter(r => r.event_id === eventId && r.user_id === BOB).length, 1);

            const result = await events.setRsvp(io, BOB, eventId, 'declined');
            assert.equal(result.event.myRsvp, 'declined');
            const live = io.emitted.filter(e => e.event === 'event_updated').pop();
            assert.equal(live.room, `chat_${CHAT}`);
            assert.deepEqual(live.data.counts, { going: 1, maybe: 0, declined: 1 });
            assert.deepEqual(live.data.rsvps.declined, [{ userId: BOB, name: 'bob' }]);
            assert.equal(live.data.myRsvp, undefined); // the room copy is the same for everyone

            await events.setRsvp(io, BOB, eventId, null);
            assert.deepEqual(answersOf(world, eventId), [`${ALICE}:going`]);
        });

        test('non-members, cancelled and ended events and bad answers are refused', async () => {
            const { world, events, io } = setup();
            const { eventId } = addEvent(world);
            assert.equal((await events.setRsvp(io, EVE, eventId, 'going')).error.status, 404);
            assert.equal((await events.getEventForMember(eventId, EVE)).error.status, 404);
            assert.equal((await events.listChatEvents(EVE, CHAT)).error.status, 403);
            assert.equal((await events.setRsvp(io, BOB, eventId, 'yes')).error.status, 400);
            assert.equal((await events.setRsvp(io, BOB, 'x', 'going')).error.status, 400);
            assert.deepEqual(answersOf(world, eventId), [`${ALICE}:going`]);

            world.now += 4 * 3600; // after the end
            assert.equal((await events.setRsvp(io, BOB, eventId, 'going')).error.status, 409);

            const second = addEvent(world);
            world.events.get(second.eventId).status = 'cancelled';
            assert.equal((await events.setRsvp(io, BOB, second.eventId, 'going')).error.status, 409);
            assert.equal(io.emitted.filter(e => e.event === 'event_updated').length, 0);
        });

        test('only the creator edits or cancels; members get a system notice; reminders follow the new time', async () => {
            const { world, events, io } = setup();
            const { eventId, messageId } = addEvent(world, { reminders: [0, 3600] });
            [...world.reminders.values()].find(r => r.offset_seconds === 3600).status = 'fired';

            assert.equal((await events.updateEvent(io, BOB, eventId, { location: 'Pub' })).error.status, 403);
            assert.equal((await events.cancelEvent(io, BOB, eventId)).error.status, 403);
            assert.equal((await events.updateEvent(io, EVE, eventId, { location: 'Pub' })).error.status, 404);
            assert.equal(world.events.get(eventId).location, 'Home');

            // Location only: one notice naming the field, reminders untouched
            const edited = await events.updateEvent(io, ALICE, eventId, { location: ' The park ' });
            assert.equal(edited.event.location, 'The park');
            assert.equal(edited.event.revision, 1);
            const notice = io.emitted.find(e => e.event === 'new_message' && e.data.message_type === 'system');
            assert.equal(notice.data.content, `event_updated:${eventId}:location`);
            assert.deepEqual(notice.data.event_ref, { id: eventId, title: 'Dinner', status: 'active' });
            assert.deepEqual([...world.reminders.values()].map(r => r.status).sort(), ['fired', 'pending']);

            // New title and start: the card's text follows; every reminder is scheduled again
            const moved = await events.updateEvent(io, ALICE, eventId, { title: 'Late dinner', startsInSeconds: 3 * 3600, endsInSeconds: 4 * 3600 });
            assert.equal(moved.event.title, 'Late dinner');
            assert.equal(world.messages.get(messageId).content, 'Late dinner');
            assert.deepEqual([...world.reminders.values()].map(r => [r.offset_seconds, r.status, r.remind_at - world.now]).sort(),
                [[0, 'pending', 3 * 3600], [3600, 'pending', 2 * 3600]]);
            const notices = io.emitted.filter(e => e.event === 'new_message' && e.data.message_type === 'system');
            assert.equal(notices[1].data.content, `event_updated:${eventId}:title,time`);

            // End before start is refused
            assert.equal((await events.updateEvent(io, ALICE, eventId, { endsInSeconds: 60 })).error.status, 400);

            // Reminder choices only: no notice to the chat
            await events.updateEvent(io, ALICE, eventId, { reminders: ['start'] });
            assert.deepEqual([...world.reminders.values()].map(r => r.offset_seconds), [0]);
            assert.equal(io.emitted.filter(e => e.event === 'new_message' && e.data.message_type === 'system').length, 2);

            const cancelled = await events.cancelEvent(io, ALICE, eventId);
            assert.equal(cancelled.event.status, 'cancelled');
            assert.deepEqual([...world.reminders.values()].map(r => r.status), ['cancelled']);
            const last = io.emitted.filter(e => e.event === 'new_message').pop();
            assert.equal(last.data.content, `event_cancelled:${eventId}`);
            // Cancelling again changes nothing and posts nothing
            await events.cancelEvent(io, ALICE, eventId);
            assert.equal(io.emitted.filter(e => e.event === 'new_message').length, 3);
            assert.equal((await events.updateEvent(io, ALICE, eventId, { location: 'x' })).error.status, 409);
        });

        test('reminders go once to members going or maybe, even when ticks overlap', async () => {
            const { world, events, io } = setup();
            const { eventId } = addEvent(world, { startsIn: 600, reminders: [0] });
            world.rsvps.push({ event_id: eventId, user_id: BOB, response: 'maybe', seq: 9 });
            world.rsvps.push({ event_id: eventId, user_id: CAROL, response: 'declined', seq: 10 });

            assert.deepEqual(await events.fireDueEventReminders(io), { fired: 0, skipped: 0, notified: 0 });
            world.now += 600;
            const [a, b] = await Promise.all([events.fireDueEventReminders(io), events.fireDueEventReminders(io)]);
            assert.equal(a.fired + b.fired, 1);
            const sent = io.emitted.filter(e => e.event === 'event_reminder');
            assert.deepEqual(sent.map(e => e.room).sort(), [`user_${ALICE}`, `user_${BOB}`]);
            assert.equal(sent[0].data.text, 'Dinner is starting now');
            assert.equal(sent[0].data.reminder, 'start');
            await events.fireDueEventReminders(io);
            assert.equal(io.emitted.filter(e => e.event === 'event_reminder').length, 2);
        });

        test('a restarted server sends what the old one stored; left members, cancelled or started events get nothing', async () => {
            const world = createWorld(dbType);
            const { eventId } = addEvent(world, { startsIn: 7200, reminders: [0, 3600] });
            world.rsvps.push({ event_id: eventId, user_id: BOB, response: 'going', seq: 9 });
            world.members[CHAT].delete(BOB); // left the chat
            world.now += 3600;

            const fresh = setup(world); // new module instances: the state is only in the "database"
            await fresh.events.fireDueEventReminders(fresh.io);
            assert.deepEqual(fresh.io.emitted.filter(e => e.event === 'event_reminder').map(e => [e.room, e.data.text]),
                [[`user_${ALICE}`, 'Dinner starts in 1 hour']]);

            // Cancelled before its start reminder came due
            world.events.get(eventId).status = 'cancelled';
            world.now += 3600;
            const result = await fresh.events.fireDueEventReminders(fresh.io);
            assert.deepEqual(result, { fired: 0, skipped: 1, notified: 0 });

            // A "1 hour before" reminder found after the start (server was down) is skipped
            const late = addEvent(world, { startsIn: -60, endsIn: 3600 });
            const rid = world.nextId.reminder++;
            world.reminders.set(rid, { id: rid, event_id: late.eventId, offset_seconds: 3600, remind_at: world.now - 3660, status: 'pending', fired_at: null });
            assert.equal((await fresh.events.fireDueEventReminders(fresh.io)).skipped, 1);
            assert.equal(world.reminders.get(rid).status, 'skipped');
        });

        test('chat history, notices and "My events" carry the event; viewers get their own answer', async () => {
            const { world, events } = setup();
            const { eventId, messageId } = addEvent(world);
            world.rsvps.push({ event_id: eventId, user_id: BOB, response: 'maybe', seq: 9 });
            const page = [
                { id: messageId, chat_id: CHAT, message_type: 'event', content: 'Dinner' },
                { id: 900, chat_id: CHAT, message_type: 'system', content: `event_updated:${eventId}:time` },
                { id: 901, chat_id: 77, message_type: 'system', content: `event_cancelled:${eventId}` }, // other chat: never leaks
                { id: 902, chat_id: CHAT, message_type: 'event', content: 'gone', deleted_for_everyone: 1 }
            ];
            await events.attachEvents(page, BOB);
            assert.equal(page[0].event.myRsvp, 'maybe');
            assert.deepEqual(page[1].event_ref, { id: eventId, title: 'Dinner', status: 'active' });
            assert.equal(page[2].event_ref, null);
            assert.equal(page[3].event, undefined);

            const mine = await events.listMyEvents(BOB);
            assert.deepEqual(mine.events.map(e => [e.id, e.myRsvp]), [[eventId, 'maybe']]);
            assert.deepEqual((await events.listMyEvents(EVE)).events, []);
            world.now += 4 * 3600;
            assert.deepEqual((await events.listChatEvents(BOB, CHAT)).events, []);
            assert.equal((await events.listChatEvents(BOB, CHAT, 'past')).events[0].ended, true);
        });
    });

    describe(`phase 12: shared lists (${dbType})`, () => {
        function setup(world = createWorld(dbType)) {
            const fake = setupFakeDb(dbType, world.handler);
            return { world, lists: fake.load('utils/lists.js'), io: recordingIo() };
        }

        test('members create lists (announced in the chat) and add items live; others cannot see or touch them', async () => {
            const { world, lists, io } = setup();
            assert.equal((await lists.createList(io, EVE, { chatId: CHAT, name: 'Spy' })).error.code, 'NOT_A_MEMBER');
            assert.equal((await lists.createList(io, ALICE, { chatId: CHAT, name: '   ' })).error.status, 400);

            const created = await lists.createList(io, ALICE, { chatId: CHAT, name: ' Groceries ' });
            const listId = created.list.id;
            assert.equal(created.list.name, 'Groceries');
            const notice = io.emitted.find(e => e.event === 'new_message');
            assert.equal(notice.data.content, `list_created:${listId}`);
            assert.deepEqual(notice.data.list_ref, { id: listId, name: 'Groceries' });

            const added = await lists.addItem(io, BOB, listId, { text: '  Milk\n2 litres ' });
            assert.equal(added.list.items[0].text, 'Milk 2 litres');
            assert.deepEqual(added.list.items[0].createdBy, { userId: BOB, name: 'bob' });
            const live = io.emitted.filter(e => e.event === 'list_updated').pop();
            assert.equal(live.room, `chat_${CHAT}`);
            assert.equal(live.data.items.length, 1);

            const itemId = added.list.items[0].id;
            assert.equal((await lists.addItem(io, EVE, listId, { text: 'x' })).error.status, 404);
            assert.equal((await lists.updateItem(io, EVE, itemId, { done: true })).error.status, 404);
            assert.equal((await lists.removeItem(io, EVE, itemId)).error.status, 404);
            assert.equal((await lists.getListForMember(EVE, listId)).error.status, 404);
            assert.equal((await lists.listChatLists(EVE, CHAT)).error.status, 403);
            assert.equal(world.items.get(itemId).done, false);
            assert.deepEqual((await lists.listChatLists(BOB, CHAT)).lists.map(l => [l.name, l.counts.total]), [['Groceries', 1]]);
        });

        test('ticking records who did it; a second tick keeps the first name; unticking clears it', async () => {
            const { world, lists, io } = setup();
            const { list } = await lists.createList(io, ALICE, { chatId: CHAT, name: 'Groceries' });
            const { list: withItem } = await lists.addItem(io, ALICE, list.id, { text: 'Eggs' });
            const itemId = withItem.items[0].id;

            await Promise.all([lists.updateItem(io, BOB, itemId, { done: true }), lists.updateItem(io, ALICE, itemId, { done: true })]);
            assert.equal(world.items.get(itemId).done_by, BOB);
            const ticked = io.emitted.filter(e => e.event === 'list_updated').pop().data.items[0];
            assert.equal(ticked.done, true);
            assert.deepEqual(ticked.doneBy, { userId: BOB, name: 'bob' });
            assert.deepEqual((await lists.listChatLists(ALICE, CHAT)).lists[0].counts, { total: 1, done: 1 });

            const unticked = await lists.updateItem(io, ALICE, itemId, { done: false });
            assert.equal(unticked.list.items[0].doneBy, null);
            const edited = await lists.updateItem(io, CAROL, itemId, { text: ' Free-range eggs ' });
            assert.equal(edited.list.items[0].text, 'Free-range eggs');
            assert.equal((await lists.updateItem(io, ALICE, itemId, {})).error.status, 400);
            assert.equal((await lists.updateItem(io, ALICE, itemId, { done: 'yes' })).error.status, 400);
            assert.equal((await lists.updateItem(io, ALICE, itemId, { text: 'x'.repeat(301) })).error.status, 400);

            await lists.removeItem(io, BOB, itemId);
            assert.equal(world.items.size, 0);
        });

        test('renaming and deleting is for the creator or a group admin', async () => {
            const { world, lists, io } = setup();
            const { list } = await lists.createList(io, BOB, { chatId: CHAT, name: 'Chores' });
            assert.equal((await lists.renameList(io, CAROL, list.id, 'Mine')).error.status, 403);
            assert.equal((await lists.deleteList(io, CAROL, list.id)).error.status, 403);
            assert.equal((await lists.renameList(io, BOB, list.id, 'House chores')).list.name, 'House chores');
            assert.deepEqual(await lists.deleteList(io, ALICE, list.id), { deleted: true }); // Alice is an admin
            assert.equal(world.lists.size, 0);
            assert.deepEqual(io.emitted.filter(e => e.event === 'list_deleted').map(e => [e.room, e.data]), [[`chat_${CHAT}`, { listId: list.id, chatId: CHAT }]]);
        });

        test('a due date reminds whoever set it, once; done items and leavers get nothing', async () => {
            const { world, lists, io } = setup();
            const { list } = await lists.createList(io, ALICE, { chatId: CHAT, name: 'To do' });
            const inAnHour = new Date(Date.now() + 3600 * 1000).toISOString();
            assert.equal((await lists.addItem(io, BOB, list.id, { text: 'Call the plumber', dueAt: '2020-01-01T00:00:00Z' })).error.status, 400);
            await lists.addItem(io, BOB, list.id, { text: 'Call the plumber', dueAt: inAnHour });
            await lists.addItem(io, ALICE, list.id, { text: 'Pay rent', dueAt: inAnHour });
            await lists.addItem(io, CAROL, list.id, { text: 'Water plants', dueAt: inAnHour });
            const [plumber, rent, plants] = [...world.items.values()];
            assert.equal(plumber.due_set_by, BOB);
            await lists.updateItem(io, ALICE, rent.id, { done: true });
            world.members[CHAT].delete(CAROL);

            world.now += 3601;
            const [a, b] = await Promise.all([lists.fireDueListItems(io), lists.fireDueListItems(io)]);
            assert.equal(a.fired + b.fired, 1);
            assert.equal(a.skipped + b.skipped, 2);
            const due = io.emitted.filter(e => e.event === 'list_item_due');
            assert.deepEqual(due.map(e => [e.room, e.data.text, e.data.listName]), [[`user_${BOB}`, 'Call the plumber', 'To do']]);
            await lists.fireDueListItems(io);
            assert.equal(io.emitted.filter(e => e.event === 'list_item_due').length, 1);
            assert.equal(plants.due_reminder_status, 'fired');

            // A new due date arms it again; clearing it disarms it
            await lists.updateItem(io, BOB, plumber.id, { dueAt: new Date(Date.now() + 7200 * 1000).toISOString() });
            assert.equal(plumber.due_reminder_status, 'pending');
            await lists.updateItem(io, BOB, plumber.id, { dueAt: null });
            assert.equal(plumber.due_reminder_status, 'none');
        });
    });

    test(`socket events: membership checked for event_rsvp and list_item_* (${dbType})`, async () => {
        const world = createWorld(dbType);
        const fake = setupFakeDb(dbType, world.handler);
        const { eventId } = addEvent(world);
        world.lists.set(1, { id: 1, chat_id: CHAT, created_by: ALICE, name: 'Groceries' });
        world.items.set(1, { id: 1, list_id: 1, chat_id: CHAT, text: 'Milk', created_by: ALICE, done: false, done_by: null, done_at: null, due_at: null, due_set_by: null, due_reminder_status: 'none' });
        process.env.PORT = '0';
        stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });

        const log = console.log;
        console.log = () => {};
        const { io } = fake.load('server.js');
        const recorder = recordingIo();
        io.to = recorder.to;

        const sockets = [BOB, EVE].map((userId) => {
            const handlers = {};
            const errors = [];
            const socket = {
                id: `s${userId}`, userId, data: {}, join() {},
                on(event, fn) { handlers[event] = fn; },
                emit(event, payload) { if (event === 'error') errors.push(payload); }
            };
            io.sockets.listeners('connection')[0](socket);
            return { handlers, errors };
        });

        try {
            const [bob, eve] = sockets;
            await Promise.all(Array.from({ length: 5 }, () => bob.handlers.event_rsvp({ eventId, response: 'maybe' })));
            assert.deepEqual(answersOf(world, eventId), [`${ALICE}:going`, `${BOB}:maybe`]);
            assert.deepEqual(bob.errors, []);
            await bob.handlers.event_rsvp({ eventId });
            assert.equal(bob.errors.pop().event, 'event_rsvp');

            await eve.handlers.event_rsvp({ eventId, response: 'going' });
            assert.equal(eve.errors.pop().message, 'Event not found');
            await eve.handlers.list_item_add({ listId: 1, text: 'Spy' });
            assert.equal(eve.errors.pop().message, 'List not found');
            await eve.handlers.list_item_update({ itemId: 1, done: true });
            assert.equal(eve.errors.pop().message, 'Item not found');
            await eve.handlers.list_item_remove({ itemId: 1 });
            assert.equal(eve.errors.pop().message, 'Item not found');
            assert.equal(world.items.get(1).done, false);
            assert.equal(world.items.size, 1);
            assert.deepEqual(answersOf(world, eventId), [`${ALICE}:going`, `${BOB}:maybe`]);

            await bob.handlers.list_item_update({ itemId: 1, done: true });
            assert.equal(world.items.get(1).done_by, BOB);
            await bob.handlers.list_item_add(null);
            assert.equal(bob.errors.pop().message, 'Invalid request');
            assert.ok(recorder.emitted.some(e => e.event === 'list_updated' && e.room === `chat_${CHAT}`));
        } finally {
            await new Promise(resolve => io.close(() => resolve()));
            console.log = log;
        }
    });
}

describe('phase 12: validation and routes', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const validation = load('utils/validation.js');
    const { validationResult } = require('express-validator');

    async function run(chain, req) {
        const request = { params: {}, query: {}, body: {}, ...req };
        for (const rule of chain) await rule.run(request);
        return validationResult(request).array().map(e => e.msg);
    }
    const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

    test('events', async () => {
        const good = { chatId: 5, title: 'Dinner', startsAt: inHours(2), endsAt: inHours(3), timezone: 'Europe/Berlin', reminders: ['1h'] };
        assert.deepEqual(await run(validation.validateCreateEvent, { body: good }), []);
        assert.ok((await run(validation.validateCreateEvent, { body: { ...good, startsAt: '2030-01-01T10:00' } })).length > 0);
        assert.ok((await run(validation.validateCreateEvent, { body: { ...good, reminders: ['2h'] } })).length > 0);
        assert.ok((await run(validation.validateCreateEvent, { body: { ...good, timezone: 'Nowhere/Land' } })).length > 0);
        assert.ok((await run(validation.validateCreateEvent, { body: { ...good, title: 7 } })).length > 0);
        assert.ok((await run(validation.validateUpdateEvent, { params: { eventId: '1' }, body: {} })).length > 0);
        assert.deepEqual(await run(validation.validateUpdateEvent, { params: { eventId: '1' }, body: { location: null } }), []);
        assert.deepEqual(await run(validation.validateRsvp, { params: { eventId: '1' }, body: { response: null } }), []);
        assert.ok((await run(validation.validateRsvp, { params: { eventId: '1' }, body: { response: 'yes' } })).length > 0);
        assert.ok((await run(validation.validateEventsQuery, { query: { scope: 'all' } })).length > 0);
    });

    test('lists', async () => {
        assert.deepEqual(await run(validation.validateCreateList, { body: { chatId: 5, name: 'Groceries' } }), []);
        assert.ok((await run(validation.validateCreateList, { body: { chatId: 5, name: '' } })).length > 0);
        assert.ok((await run(validation.validateListsQuery, { query: {} })).length > 0);
        assert.deepEqual(await run(validation.validateAddListItem, { params: { listId: '1' }, body: { text: 'Milk', dueAt: null } }), []);
        assert.ok((await run(validation.validateAddListItem, { params: { listId: '1' }, body: { text: 'Milk', dueAt: '2020-01-01T00:00:00Z' } })).length > 0);
        assert.deepEqual(await run(validation.validateUpdateListItem, { params: { itemId: '3' }, body: { dueAt: null } }), []);
        assert.ok((await run(validation.validateUpdateListItem, { params: { itemId: '3' }, body: {} })).length > 0);
        assert.ok((await run(validation.validateUpdateListItem, { params: { itemId: '3' }, body: { done: 'true' } })).length > 0);
    });

    test('birthdays and the privacy setting', async () => {
        assert.deepEqual(await run(validation.validateBirthday, { body: { day: 29, month: 2 } }), []);
        assert.deepEqual(await run(validation.validateBirthday, { body: { day: 7, month: 11, year: 1990 } }), []);
        assert.ok((await run(validation.validateBirthday, { body: { day: 29, month: 2, year: 2001 } })).length > 0);
        assert.ok((await run(validation.validateBirthday, { body: { day: 31, month: 4 } })).length > 0);
        assert.ok((await run(validation.validateBirthdaysQuery, { params: { chatId: '5' }, query: { date: 'today' } })).length > 0);
        assert.deepEqual(await run(validation.validatePrivacySettings, { body: { birthday: 'nobody' } }), []);
        assert.ok((await run(validation.validatePrivacySettings, { body: { birthday: 'friends' } })).length > 0);
    });

    test('every new route requires auth and is rate limited', () => {
        const { authenticateToken } = load('middleware/auth.js');
        for (const router of [load('routes/events.js'), load('routes/lists.js')]) {
            assert.equal(router.stack[0].handle, authenticateToken);
            const routes = router.stack.filter(l => l.route);
            assert.ok(routes.length >= 7);
            // limiter + validation + check + controller
            assert.ok(routes.every(l => l.route.stack.length >= 4 && l.route.stack[0].name !== 'authenticateToken'));
        }
        const users = load('routes/users.js').stack.filter(l => l.route && /birthday/.test(l.route.path));
        assert.equal(users.length, 2);
        const chats = load('routes/chats.js').stack.filter(l => l.route && l.route.path === '/:chatId/birthdays');
        assert.equal(chats.length, 1);
        assert.ok(chats[0].route.stack.length >= 4);
        const limits = load('config/socketLimits.js');
        assert.deepEqual(limits.groups.plan.events, ['event_rsvp', 'list_item_add', 'list_item_update', 'list_item_remove']);
    });
});
