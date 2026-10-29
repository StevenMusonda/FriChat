/**
 * Phase 8 on both fake drivers: polls (single-choice rule and no double votes, also through
 * repeated poll_vote socket events), scheduled messages (sent by the scheduler through the normal
 * message path, discarded + notified after leaving the chat, sent once when ticks overlap, still sent
 * after a "restart"), reminders, timezone-proof times and the new validation rules.
 *
 * The fake database below keeps the tables in memory and enforces the same unique keys as the
 * real schema, so a broken rule shows up as a duplicate row or a thrown "duplicate key" error.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setupFakeDb, fakeIo, fakeRes, stubModule } = require('./helpers/fakeDb');

const ALICE = 1;
const BOB = 2;
const EVE = 3; // not a member of anything
const CHAT = 5;

function duplicateKeyError(pg) {
    const error = new Error('duplicate key');
    error.code = pg ? '23505' : 'ER_DUP_ENTRY';
    return error;
}

/**
 * In-memory tables for everything phase 8 touches. `now` is the database clock in seconds.
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        pg,
        now: 1000,
        members: { [CHAT]: new Set([ALICE, BOB]) },
        users: { [ALICE]: 'alice', [BOB]: 'bob', [EVE]: 'eve' },
        polls: new Map(),
        options: new Map(),
        votes: [],
        messages: new Map(),
        scheduled: new Map(),
        reminders: new Map(),
        nextId: { poll: 1, option: 100, vote: 1, message: 500, scheduled: 1, reminder: 1 },
        statements: []
    };
    const changed = (n) => (pg ? Array.from({ length: n }, () => ({ id: 1 })) : { affectedRows: n });
    const inserted = (id) => (pg ? [{ id }] : { insertId: id });
    const isMember = (chatId, userId) => !!world.members[chatId] && world.members[chatId].has(Number(userId));

    function insertVote(sql, [pollId, optionId, userId, slot]) {
        const slotClash = world.votes.find(v => v.poll_id === pollId && v.user_id === userId && v.choice_slot === slot);
        const optionClash = world.votes.find(v => v.option_id === optionId && v.user_id === userId);
        if (/ON CONFLICT \(poll_id, user_id, choice_slot\) DO UPDATE|ON DUPLICATE KEY UPDATE option_id = VALUES\(option_id\)/.test(sql)) {
            if (slotClash) {
                if (optionClash && optionClash !== slotClash) throw duplicateKeyError(pg);
                slotClash.option_id = optionId;
                return pg ? [] : { affectedRows: 2 };
            }
        } else if (/ON CONFLICT DO NOTHING|ON DUPLICATE KEY UPDATE choice_slot = choice_slot/.test(sql)) {
            if (slotClash || optionClash) return pg ? [] : { affectedRows: 0 };
        }
        if (slotClash || optionClash) throw duplicateKeyError(pg);
        world.votes.push({ id: world.nextId.vote++, poll_id: pollId, option_id: optionId, user_id: userId, choice_slot: slot });
        return pg ? [] : { insertId: world.nextId.vote - 1 };
    }

    function pollRow(poll) {
        return {
            id: poll.id,
            message_id: poll.message_id,
            chat_id: poll.chat_id,
            created_by: poll.created_by,
            question: poll.question,
            multiple_choice: pg ? poll.multiple_choice : (poll.multiple_choice ? 1 : 0),
            anonymous: pg ? poll.anonymous : (poll.anonymous ? 1 : 0),
            closes_in: poll.closes_at === null ? null : poll.closes_at - world.now,
            closed_in: poll.closed_at === null ? null : poll.closed_at - world.now,
            is_closed: poll.closed_at !== null || (poll.closes_at !== null && poll.closes_at <= world.now) ? 1 : 0,
            creator_username: world.users[poll.created_by],
            creator_full_name: null
        };
    }

    function scheduledRow(row) {
        return { ...row, send_in: row.send_at - world.now };
    }

    function reminderRow(r) {
        const message = world.messages.get(r.message_id);
        return {
            id: r.id, user_id: r.user_id, message_id: r.message_id, chat_id: r.chat_id, status: r.status,
            remind_in: r.remind_at - world.now,
            fired_in: r.fired_at === null ? null : r.fired_at - world.now,
            message_type: message.message_type, content: message.content,
            deleted_for_everyone: message.deleted ? 1 : 0, sender_id: message.sender_id,
            sender_username: world.users[message.sender_id], sender_full_name: null, file_name: null,
            membership_id: isMember(r.chat_id, r.user_id) ? 1 : null
        };
    }

    world.handler = (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');
        world.statements.push(sql);
        const returning = / RETURNING id$/.test(sql);
        const base = sql.replace(/ RETURNING id$/, '');

        // --- membership / posting rules
        if (/^SELECT gm\.id, gm\.role, c\.chat_type, c\.announcement_only FROM group_members gm JOIN chats c/.test(base)) {
            const [chatId, userId] = params;
            return isMember(chatId, userId) ? [{ id: 1, role: 'member', chat_type: 'group', announcement_only: pg ? false : 0 }] : [];
        }
        if (/user_blocks/.test(base)) return [];

        // --- polls
        if (/^SELECT p\.id, p\.chat_id, p\.created_by, p\.multiple_choice, m\.deleted_for_everyone/.test(base)) {
            const [userId, pollId] = params;
            const poll = world.polls.get(Number(pollId));
            if (!poll || !isMember(poll.chat_id, userId)) return [];
            const row = pollRow(poll);
            return [{ id: poll.id, chat_id: poll.chat_id, created_by: poll.created_by, multiple_choice: row.multiple_choice, deleted_for_everyone: poll.deleted ? 1 : 0, is_closed: row.is_closed }];
        }
        if (/^SELECT p\.id, p\.message_id, p\.chat_id, p\.created_by, p\.question/.test(base)) {
            const byMessage = /WHERE p\.message_id IN/.test(base);
            return [...world.polls.values()]
                .filter(p => params.map(Number).includes(byMessage ? p.message_id : p.id))
                .map(pollRow);
        }
        if (/^SELECT id, poll_id, position, option_text FROM poll_options WHERE poll_id IN/.test(base)) {
            return [...world.options.values()].filter(o => params.map(Number).includes(o.poll_id)).sort((a, b) => a.position - b.position);
        }
        if (/^SELECT v\.poll_id, v\.option_id, v\.user_id, u\.username, u\.full_name FROM poll_votes v/.test(base)) {
            return world.votes.filter(v => params.map(Number).includes(v.poll_id))
                .map(v => ({ ...v, username: world.users[v.user_id], full_name: null }));
        }
        if (base === 'SELECT id FROM poll_options WHERE poll_id = ?') {
            return [...world.options.values()].filter(o => o.poll_id === Number(params[0])).map(o => ({ id: o.id }));
        }
        if (base === 'DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?') {
            const [pollId, userId] = params;
            world.votes = world.votes.filter(v => !(v.poll_id === pollId && v.user_id === userId));
            return pg ? [] : { affectedRows: 1 };
        }
        if (/^DELETE FROM poll_votes WHERE poll_id = \? AND user_id = \? AND option_id NOT IN/.test(base)) {
            const [pollId, userId, ...keep] = params;
            world.votes = world.votes.filter(v => !(v.poll_id === pollId && v.user_id === userId && !keep.includes(v.option_id)));
            return pg ? [] : { affectedRows: 1 };
        }
        if (/^INSERT INTO poll_votes/.test(base)) return insertVote(base, params);
        if (/^INSERT INTO polls /.test(base)) {
            const [messageId, chatId, createdBy, question, multiple, anonymous, closesIn] = params;
            const id = world.nextId.poll++;
            world.polls.set(id, {
                id, message_id: messageId, chat_id: chatId, created_by: createdBy, question,
                multiple_choice: !!multiple, anonymous: !!anonymous,
                closes_at: closesIn === undefined ? null : world.now + closesIn, closed_at: null, deleted: false
            });
            return inserted(id);
        }
        if (/^INSERT INTO poll_options/.test(base)) {
            const [pollId, position, text] = params;
            const id = world.nextId.option++;
            world.options.set(id, { id, poll_id: pollId, position, option_text: text });
            return pg ? [] : { insertId: id };
        }
        if (base === 'UPDATE polls SET closed_at = CURRENT_TIMESTAMP WHERE id = ? AND closed_at IS NULL') {
            const poll = world.polls.get(Number(params[0]));
            if (!poll || poll.closed_at !== null) return changed(0);
            poll.closed_at = world.now;
            return changed(1);
        }
        if (/^SELECT id FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= CURRENT_TIMESTAMP/.test(base)) {
            return [...world.polls.values()].filter(p => p.closed_at === null && p.closes_at !== null && p.closes_at <= world.now).map(p => ({ id: p.id }));
        }
        if (base === 'UPDATE polls SET closed_at = closes_at WHERE id = ? AND closed_at IS NULL') {
            const poll = world.polls.get(Number(params[0]));
            if (!poll || poll.closed_at !== null) return changed(0);
            poll.closed_at = poll.closes_at;
            return changed(1);
        }

        // --- messages (the normal delivery path)
        if (/^INSERT INTO messages \(chat_id, sender_id, message_type, content, reply_to_message_id, status\)/.test(base)) {
            const [chatId, senderId, type, content, replyTo] = params;
            const id = world.nextId.message++;
            world.messages.set(id, { id, chat_id: chatId, sender_id: senderId, message_type: type, content, reply_to_message_id: replyTo, deleted: false });
            return inserted(id);
        }
        if (base === 'DELETE FROM messages WHERE id = ?') {
            world.messages.delete(Number(params[0]));
            return pg ? [] : { affectedRows: 1 };
        }
        if (/FROM messages m JOIN users u ON m\.sender_id = u\.id/.test(base)) {
            const message = world.messages.get(Number(params[0]));
            return message ? [{ ...message, username: world.users[message.sender_id], deleted_for_everyone: 0 }] : [];
        }
        if (/^SELECT id, deleted_for_everyone FROM messages WHERE id = \? AND chat_id = \?/.test(base)) {
            const message = world.messages.get(Number(params[0]));
            return message && message.chat_id === Number(params[1]) ? [{ id: message.id, deleted_for_everyone: message.deleted ? 1 : 0 }] : [];
        }
        if (/^SELECT last_read_message_id FROM group_members/.test(base)) return [{ last_read_message_id: 0 }];
        if (/^SELECT id FROM messages WHERE id = \? AND chat_id = \?/.test(base)) {
            const message = world.messages.get(Number(params[0]));
            return message ? [{ id: message.id }] : [];
        }
        if (/^SELECT MAX\(id\) AS id FROM messages/.test(base)) return [{ id: world.nextId.message - 1 }];

        // --- scheduled messages
        if (/^SELECT COUNT\(\*\) AS count FROM scheduled_messages/.test(base)) {
            return [{ count: [...world.scheduled.values()].filter(s => s.user_id === params[0] && ['pending', 'sending'].includes(s.status)).length }];
        }
        if (/^INSERT INTO scheduled_messages/.test(base)) {
            world.lastScheduleInsert = base;
            const [userId, chatId, content, replyTo, seconds] = params;
            const id = world.nextId.scheduled++;
            world.scheduled.set(id, {
                id, user_id: userId, chat_id: chatId, content, reply_to_message_id: replyTo, send_at: world.now + seconds,
                status: 'pending', failure_reason: null, sent_message_id: null, attempts: 0, claimed_at: null
            });
            return inserted(id);
        }
        if (/^SELECT .* FROM scheduled_messages sm WHERE sm\.id = \?( AND sm\.user_id = \?)?$/.test(base)) {
            const row = world.scheduled.get(Number(params[0]));
            if (!row || (params.length > 1 && row.user_id !== params[1])) return [];
            return [scheduledRow(row)];
        }
        if (/^SELECT .* FROM scheduled_messages sm JOIN group_members gm/.test(base)) {
            return [...world.scheduled.values()]
                .filter(s => s.user_id === params[0] && ['pending', 'sending', 'failed'].includes(s.status) && isMember(s.chat_id, s.user_id))
                .map(scheduledRow);
        }
        if (/^SELECT .* FROM scheduled_messages sm LEFT JOIN group_members gm/.test(base)) {
            return [...world.scheduled.values()]
                .filter(s => s.user_id === params[0] && s.status === 'failed' && !isMember(s.chat_id, s.user_id))
                .map(scheduledRow);
        }
        if (/^UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL WHERE status = 'sending' AND claimed_at </.test(base)) {
            let n = 0;
            for (const row of world.scheduled.values()) {
                if (row.status === 'sending' && row.claimed_at !== null && row.claimed_at < world.now - 120) {
                    row.status = 'pending';
                    row.claimed_at = null;
                    n++;
                }
            }
            return changed(n);
        }
        if (/^SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= CURRENT_TIMESTAMP/.test(base)) {
            return [...world.scheduled.values()].filter(s => s.status === 'pending' && s.send_at <= world.now).map(s => ({ id: s.id }));
        }
        if (/^UPDATE scheduled_messages SET status = 'sending'/.test(base)) {
            const row = world.scheduled.get(Number(params[0]));
            if (!row || row.status !== 'pending' || row.send_at > world.now) return changed(0);
            row.status = 'sending';
            row.claimed_at = world.now;
            row.attempts++;
            return changed(1);
        }
        if (/^UPDATE scheduled_messages SET status = 'sent', sent_message_id = \?/.test(base)) {
            const row = world.scheduled.get(Number(params[1]));
            row.status = 'sent';
            row.sent_message_id = params[0];
            return changed(1);
        }
        if (/^UPDATE scheduled_messages SET status = 'failed', failure_reason = \?/.test(base)) {
            const row = world.scheduled.get(Number(params[1]));
            row.status = 'failed';
            row.failure_reason = params[0];
            return changed(1);
        }
        if (/^UPDATE scheduled_messages SET status = 'cancelled'/.test(base)) {
            const row = world.scheduled.get(Number(params[0]));
            if (!row || row.user_id !== params[1] || !['pending', 'failed'].includes(row.status)) return changed(0);
            row.status = 'cancelled';
            return changed(1);
        }
        if (/^UPDATE scheduled_messages SET .* WHERE id = \? AND user_id = \? AND status IN \('pending', 'failed'\)$/.test(base)) {
            const [id, userId] = params.slice(-2);
            const row = world.scheduled.get(Number(id));
            if (!row || row.user_id !== userId || !['pending', 'failed'].includes(row.status)) return changed(0);
            let i = 0;
            if (/content = \?/.test(base)) row.content = params[i++];
            if (/send_at = /.test(base)) row.send_at = world.now + params[i++];
            row.status = 'pending';
            row.failure_reason = null;
            return changed(1);
        }

        // --- reminders
        if (/^SELECT m\.id, m\.chat_id, m\.deleted_for_everyone FROM messages m JOIN group_members gm/.test(base)) {
            const [userId, , messageId] = params;
            const message = world.messages.get(Number(messageId));
            return message && isMember(message.chat_id, userId) ? [{ id: message.id, chat_id: message.chat_id, deleted_for_everyone: message.deleted ? 1 : 0 }] : [];
        }
        if (/^DELETE FROM message_reminders WHERE user_id = \? AND message_id = \? AND status = 'pending'/.test(base)) {
            for (const [id, r] of world.reminders) {
                if (r.user_id === params[0] && r.message_id === params[1] && r.status === 'pending') world.reminders.delete(id);
            }
            return pg ? [] : { affectedRows: 1 };
        }
        if (/^SELECT COUNT\(\*\) AS count FROM message_reminders/.test(base)) return [{ count: 0 }];
        if (/^INSERT INTO message_reminders/.test(base)) {
            const [userId, messageId, chatId, seconds] = params;
            const id = world.nextId.reminder++;
            world.reminders.set(id, { id, user_id: userId, message_id: messageId, chat_id: chatId, remind_at: world.now + seconds, status: 'pending', fired_at: null });
            return inserted(id);
        }
        if (/FROM message_reminders r JOIN messages m .* WHERE r\.id = \?$/.test(base)) {
            const r = world.reminders.get(Number(params[0]));
            return r ? [reminderRow(r)] : [];
        }
        if (/^SELECT id FROM message_reminders WHERE status = 'pending' AND remind_at <= CURRENT_TIMESTAMP/.test(base)) {
            return [...world.reminders.values()].filter(r => r.status === 'pending' && r.remind_at <= world.now).map(r => ({ id: r.id }));
        }
        if (/^UPDATE message_reminders SET status = 'fired'/.test(base)) {
            const r = world.reminders.get(Number(params[0]));
            if (!r || r.status !== 'pending') return changed(0);
            r.status = 'fired';
            r.fired_at = world.now;
            return changed(1);
        }
        if (/^UPDATE message_reminders SET status = 'cancelled' WHERE id = \?/.test(base)) {
            world.reminders.get(Number(params[0])).status = 'cancelled';
            return changed(1);
        }
        if (/^DELETE FROM message_reminders WHERE id = \? AND user_id = \?/.test(base)) {
            const r = world.reminders.get(Number(params[0]));
            if (!r || r.user_id !== params[1]) return changed(0);
            world.reminders.delete(r.id);
            return changed(1);
        }

        // Bookkeeping of the normal message path (chat timestamp, archive, read receipts, counts)
        if (/^UPDATE/.test(base)) return pg ? (returning ? [{ id: 1 }] : []) : { affectedRows: 1 };
        if (/^SELECT COUNT\(\*\) AS count/.test(base)) return [{ count: 0 }];
        if (/^INSERT INTO message_mentions/.test(base)) return pg ? [] : { insertId: 1 };
        throw new Error(`Unexpected query: ${base}`);
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

function addPoll(world, { multiple = false, anonymous = false, closesIn = null } = {}) {
    const messageId = world.nextId.message++;
    world.messages.set(messageId, { id: messageId, chat_id: CHAT, sender_id: ALICE, message_type: 'poll', content: 'Lunch?', deleted: false });
    const id = world.nextId.poll++;
    world.polls.set(id, {
        id, message_id: messageId, chat_id: CHAT, created_by: ALICE, question: 'Lunch?', multiple_choice: multiple, anonymous,
        closes_at: closesIn === null ? null : world.now + closesIn, closed_at: null, deleted: false
    });
    const optionIds = ['Pizza', 'Sushi', 'Salad'].map((text, position) => {
        const optionId = world.nextId.option++;
        world.options.set(optionId, { id: optionId, poll_id: id, position, option_text: text });
        return optionId;
    });
    return { pollId: id, messageId, optionIds };
}

const votesOf = (world, pollId, userId) => world.votes.filter(v => v.poll_id === pollId && v.user_id === userId).map(v => v.option_id).sort();

describe('phase 8: time handling is timezone-proof', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { secondsFromNow, isoFromSecondsUntil, isIsoWithOffset } = load('utils/timeSql.js');
    const now = Date.parse('2026-10-29T12:00:00.000Z');

    test('the same instant written in different timezones gives the same delay', () => {
        const utc = secondsFromNow('2026-10-29T20:00:00.000Z', now);
        const berlin = secondsFromNow('2026-10-29T21:00:00+01:00', now);
        const newYork = secondsFromNow('2026-10-29T16:00:00-04:00', now);
        assert.deepEqual(utc, { ok: true, seconds: 8 * 3600 });
        assert.deepEqual(berlin, utc);
        assert.deepEqual(newYork, utc);
    });

    test('a time without an offset is refused (it would silently mean the server timezone)', () => {
        assert.equal(isIsoWithOffset('2026-10-29T20:00'), false);
        assert.equal(secondsFromNow('2026-10-29T20:00:00', now).ok, false);
        assert.equal(secondsFromNow('tomorrow', now).ok, false);
        assert.equal(secondsFromNow(12345, now).ok, false);
    });

    test('past times and times more than a year away are refused', () => {
        assert.equal(secondsFromNow('2026-10-29T11:59:00Z', now).ok, false);
        assert.equal(secondsFromNow('2027-12-01T00:00:00Z', now).ok, false);
        assert.equal(secondsFromNow('2027-10-28T00:00:00Z', now).ok, true);
    });

    test('times go back out as UTC ISO strings computed from "seconds until"', () => {
        assert.equal(isoFromSecondsUntil(3600, now), '2026-10-29T13:00:00.000Z');
        assert.equal(isoFromSecondsUntil(-60, now), '2026-10-29T11:59:00.000Z');
        assert.equal(isoFromSecondsUntil(null, now), null);
    });

    for (const dbType of ['mysql', 'postgresql']) {
        test(`stored relative to the database clock with a bound parameter (${dbType})`, () => {
            const fake = setupFakeDb(dbType, () => []);
            const { plusSecondsSql, secondsUntilSql } = fake.load('utils/timeSql.js');
            assert.equal((plusSecondsSql().match(/\?/g) || []).length, 1);
            assert.match(plusSecondsSql(), /^CURRENT_TIMESTAMP \+ /);
            assert.match(secondsUntilSql('p.closes_at'), dbType === 'postgresql' ? /EXTRACT\(EPOCH FROM \(p\.closes_at - CURRENT_TIMESTAMP\)\)/ : /TIMESTAMPDIFF\(SECOND, CURRENT_TIMESTAMP, p\.closes_at\)/);
        });
    }
});

describe('phase 8: poll input', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { cleanPollInput } = load('utils/polls.js');

    test('2 to 12 distinct options, trimmed to one line, empty rows ignored', () => {
        const ok = cleanPollInput('  Where?\n ', ['  Park ', '', 'Beach\nfront', '   ']);
        assert.deepEqual(ok, { ok: true, question: 'Where?', options: ['Park', 'Beach front'] });
        assert.equal(cleanPollInput('Q', ['only one']).ok, false);
        assert.equal(cleanPollInput('Q', Array.from({ length: 13 }, (_, i) => `o${i}`)).ok, false);
        assert.equal(cleanPollInput('Q', Array.from({ length: 12 }, (_, i) => `o${i}`)).ok, true);
        assert.equal(cleanPollInput('Q', ['Yes', 'yes']).ok, false);
        assert.equal(cleanPollInput('', ['a', 'b']).ok, false);
        assert.equal(cleanPollInput('Q', ['a', 'x'.repeat(101)]).ok, false);
        assert.equal(cleanPollInput('Q', ['a', 5]).ok, false);
    });
});

for (const dbType of ['mysql', 'postgresql']) {
    describe(`phase 8: voting (${dbType})`, () => {
        function setup(options) {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            const polls = fake.load('utils/polls.js');
            const poll = addPoll(world, options);
            return { world, polls, poll, io: recordingIo() };
        }

        test('single choice: a new vote moves the old one, never two votes', async () => {
            const { world, polls, poll, io } = setup();
            const [pizza, sushi] = poll.optionIds;

            assert.ok((await polls.setVotes(io, BOB, poll.pollId, [pizza])).poll);
            const moved = await polls.setVotes(io, BOB, poll.pollId, [sushi]);
            assert.deepEqual(votesOf(world, poll.pollId, BOB), [sushi]);
            assert.deepEqual(moved.poll.myVotes, [sushi]);
            assert.equal(moved.poll.voterCount, 1);
            assert.equal(moved.poll.options.find(o => o.id === sushi).percent, 100);

            const two = await polls.setVotes(io, BOB, poll.pollId, [pizza, sushi]);
            assert.equal(two.error.status, 400);
            assert.deepEqual(votesOf(world, poll.pollId, BOB), [sushi]);
        });

        test('a burst of repeated and conflicting vote events still leaves one vote', async () => {
            const { world, polls, poll, io } = setup();
            const [pizza, sushi, salad] = poll.optionIds;
            const choices = [pizza, pizza, sushi, pizza, salad, salad, pizza, sushi, pizza, pizza];
            await Promise.all(choices.map(id => polls.setVotes(io, BOB, poll.pollId, [id])));
            assert.equal(votesOf(world, poll.pollId, BOB).length, 1);
        });

        test('multiple choice: the selection is set exactly, repeats add nothing', async () => {
            const { world, polls, poll, io } = setup({ multiple: true });
            const [pizza, sushi, salad] = poll.optionIds;

            await Promise.all(Array.from({ length: 8 }, () => polls.setVotes(io, BOB, poll.pollId, [pizza, sushi])));
            assert.deepEqual(votesOf(world, poll.pollId, BOB), [pizza, sushi]);

            const result = await polls.setVotes(io, BOB, poll.pollId, [sushi, salad, sushi]);
            assert.deepEqual(votesOf(world, poll.pollId, BOB), [sushi, salad]);
            assert.deepEqual(result.poll.myVotes.sort(), [sushi, salad]);

            await polls.setVotes(io, BOB, poll.pollId, []);
            assert.deepEqual(votesOf(world, poll.pollId, BOB), []);
        });

        test('non-members, closed polls, deleted polls and foreign options are refused', async () => {
            const { world, polls, poll, io } = setup();
            assert.equal((await polls.setVotes(io, EVE, poll.pollId, [poll.optionIds[0]])).error.status, 404);
            assert.equal((await polls.setVotes(io, BOB, poll.pollId, [999])).error.status, 400);
            assert.equal((await polls.setVotes(io, BOB, poll.pollId, ['1; DROP TABLE'])).error.status, 400);
            assert.equal((await polls.setVotes(io, BOB, 'abc', [poll.optionIds[0]])).error.status, 400);

            world.polls.get(poll.pollId).closed_at = world.now;
            assert.equal((await polls.setVotes(io, BOB, poll.pollId, [poll.optionIds[0]])).error.status, 409);

            world.polls.get(poll.pollId).closed_at = null;
            world.polls.get(poll.pollId).deleted = true;
            assert.equal((await polls.setVotes(io, BOB, poll.pollId, [poll.optionIds[0]])).error.status, 410);
            assert.equal(world.votes.length, 0);
        });

        test('a poll whose closing time has passed refuses votes before the scheduler closes it', async () => {
            const { world, polls, poll, io } = setup({ closesIn: 60 });
            world.now += 61;
            assert.equal((await polls.setVotes(io, BOB, poll.pollId, [poll.optionIds[0]])).error.status, 409);
        });

        test('live update: counts to the chat room, own selection only to the voter, no names when anonymous', async () => {
            const { polls, poll, io } = setup({ anonymous: true });
            await polls.setVotes(io, BOB, poll.pollId, [poll.optionIds[1]]);

            const roomCopy = io.emitted.find(e => e.event === 'poll_updated' && e.room === `chat_${CHAT}`).data;
            const ownCopy = io.emitted.find(e => e.event === 'poll_updated' && e.room === `user_${BOB}`).data;
            assert.equal(roomCopy.myVotes, undefined);
            assert.deepEqual(ownCopy.myVotes, [poll.optionIds[1]]);
            assert.equal(roomCopy.options[1].votes, 1);
            assert.equal(roomCopy.options[1].percent, 100);
            assert.ok(roomCopy.options.every(o => o.voters.length === 0));
            assert.ok(!JSON.stringify(roomCopy).includes('bob'));
        });

        test('non-anonymous polls show who voted', async () => {
            const { polls, poll, io } = setup();
            await polls.setVotes(io, BOB, poll.pollId, [poll.optionIds[0]]);
            const result = await polls.setVotes(io, ALICE, poll.pollId, [poll.optionIds[0]]);
            assert.deepEqual(result.poll.options[0].voters.map(v => v.name).sort(), ['alice', 'bob']);
            assert.equal(result.poll.options[0].percent, 100);
            assert.equal(result.poll.options[1].percent, 0);
        });

        test('only the creator can close early; the scheduler closes polls at their time', async () => {
            const { world, polls, poll, io } = setup({ closesIn: 300 });
            assert.equal((await polls.closePoll(io, BOB, poll.pollId)).error.status, 403);
            assert.equal((await polls.closePoll(io, EVE, poll.pollId)).error.status, 404);
            const closed = await polls.closePoll(io, ALICE, poll.pollId);
            assert.equal(closed.poll.closed, true);
            assert.ok(io.emitted.some(e => e.event === 'poll_updated' && e.data.closed));

            const other = addPoll(world, { closesIn: 60 });
            assert.equal(await polls.closeDuePolls(io), 0);
            world.now += 60;
            assert.equal(await polls.closeDuePolls(io), 1);
            assert.notEqual(world.polls.get(other.pollId).closed_at, null);
            assert.equal(await polls.closeDuePolls(io), 0);
        });

        test('"View votes" data: who closed it and when (creator early, or automatically at its time)', async () => {
            const { world, polls, poll, io } = setup({ closesIn: 300 });
            const open = await polls.getPollState(poll.pollId, BOB);
            assert.equal(open.closed, false);
            assert.equal(open.closedBy, null);
            assert.equal(open.closedAt, null);
            assert.equal(open.createdByName, 'alice');

            world.now += 10;
            const early = (await polls.closePoll(io, ALICE, poll.pollId)).poll;
            assert.deepEqual({ ...early.closedBy }, { userId: ALICE, name: 'alice' });
            assert.equal(early.closedAutomatically, false);
            assert.ok(Math.abs(Date.parse(early.closedAt) - Date.now()) < 5000);

            const timed = addPoll(world, { closesIn: 60 });
            world.now += 60;
            // Past its time but before the scheduler tick: closed, automatically, at closesAt
            const due = await polls.getPollState(timed.pollId, BOB);
            assert.equal(due.closed, true);
            assert.equal(due.closedAutomatically, true);
            assert.equal(due.closedBy, null);
            assert.equal(due.closedAt, due.closesAt);
            await polls.closeDuePolls(io);
            const auto = await polls.getPollState(timed.pollId, BOB);
            assert.equal(auto.closedAutomatically, true);
            assert.equal(auto.closedBy, null);
            assert.equal(auto.closedAt, auto.closesAt);

            const noEnd = addPoll(world);
            await polls.closePoll(io, ALICE, noEnd.pollId);
            assert.equal((await polls.getPollState(noEnd.pollId, BOB)).closedBy.userId, ALICE);
        });

        test('GET /api/polls/:pollId: members only, and no voter ids or names for anonymous polls', async () => {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            const polls = fake.load('utils/polls.js');
            const { getPoll } = fake.load('controllers/pollController.js');
            const io = recordingIo();
            const anonymous = addPoll(world, { anonymous: true });
            const named = addPoll(world);
            await polls.setVotes(io, BOB, anonymous.pollId, [anonymous.optionIds[0]]);
            await polls.setVotes(io, BOB, named.pollId, [named.optionIds[0]]);

            const get = async (userId, pollId) => {
                const res = fakeRes();
                await getPoll({ user: { id: userId }, params: { pollId } }, res);
                return res;
            };

            assert.equal((await get(EVE, named.pollId)).statusCode, 404);

            const anon = await get(ALICE, anonymous.pollId);
            assert.equal(anon.statusCode, 200);
            assert.equal(anon.body.data.options[0].votes, 1);
            assert.ok(anon.body.data.options.every(o => o.voters.length === 0));
            const json = JSON.stringify(anon.body.data.options);
            assert.ok(!json.includes('bob') && !json.includes('userId'));
            assert.deepEqual([...anon.body.data.myVotes], []); // only the caller's own votes

            const visible = await get(ALICE, named.pollId);
            assert.deepEqual(visible.body.data.options[0].voters.map(v => v.name), ['bob']);
        });

        test('creating a poll posts a poll message to the chat with its options', async () => {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            const polls = fake.load('utils/polls.js');
            const io = recordingIo();

            const refused = await polls.createPoll(io, EVE, { chatId: CHAT, question: 'Q', options: ['a', 'b'] });
            assert.equal(refused.error.code, 'NOT_A_MEMBER');

            const result = await polls.createPoll(io, ALICE, {
                chatId: CHAT, question: 'Movie night?', options: ['Fri', 'Sat', ''], multipleChoice: true, closesInSeconds: 3600
            });
            assert.equal(result.message.message_type, 'poll');
            assert.equal(result.message.poll.question, 'Movie night?');
            assert.deepEqual(result.message.poll.options.map(o => o.text), ['Fri', 'Sat']);
            assert.equal(result.message.poll.multipleChoice, true);
            assert.ok(result.message.poll.closesAt);
            const broadcast = io.emitted.find(e => e.event === 'new_message');
            assert.equal(broadcast.room, `chat_${CHAT}`);
            assert.equal(broadcast.data.poll.options.length, 2);
        });

        test('poll_vote socket events: membership checked, repeats cannot double-vote', async () => {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            const poll = addPoll(world);
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
                await Promise.all(Array.from({ length: 6 }, () => bob.handlers.poll_vote({ pollId: poll.pollId, optionIds: [poll.optionIds[0]] })));
                await bob.handlers.poll_vote({ pollId: poll.pollId, optionIds: [poll.optionIds[2]] });
                assert.deepEqual(votesOf(world, poll.pollId, BOB), [poll.optionIds[2]]);
                assert.deepEqual(bob.errors, []);

                await bob.handlers.poll_vote({ pollId: poll.pollId, optionIds: poll.optionIds.slice(0, 2) });
                assert.equal(bob.errors[0].event, 'poll_vote');
                assert.deepEqual(votesOf(world, poll.pollId, BOB), [poll.optionIds[2]]);

                await eve.handlers.poll_vote({ pollId: poll.pollId, optionIds: [poll.optionIds[0]] });
                assert.equal(eve.errors[0].message, 'Poll not found');
                assert.deepEqual(votesOf(world, poll.pollId, EVE), []);

                await bob.handlers.poll_vote(null);
                assert.equal(bob.errors.length, 2);
            } finally {
                await new Promise(resolve => io.close(() => resolve()));
                console.log = log;
            }
        });
    });

    describe(`phase 8: scheduled messages (${dbType})`, () => {
        function setup(world = createWorld(dbType)) {
            const fake = setupFakeDb(dbType, world.handler);
            return { world, scheduled: fake.load('utils/scheduledMessages.js'), io: recordingIo() };
        }

        test('stored relative to the database clock; members only', async () => {
            const { world, scheduled, io } = setup();
            const refused = await scheduled.createScheduled(io, EVE, { chatId: CHAT, content: 'hi', sendInSeconds: 60 });
            assert.equal(refused.error.code, 'NOT_A_MEMBER');
            const empty = await scheduled.createScheduled(io, ALICE, { chatId: CHAT, content: '   ', sendInSeconds: 60 });
            assert.equal(empty.error.status, 400);

            const created = await scheduled.createScheduled(io, ALICE, { chatId: CHAT, content: ' see you <b>soon</b> ', sendInSeconds: 3600 });
            assert.equal(created.scheduledMessage.status, 'pending');
            assert.equal(created.scheduledMessage.content, 'see you <b>soon</b>'); // raw: clients escape on render
            assert.match(world.lastScheduleInsert, dbType === 'postgresql' ? /CURRENT_TIMESTAMP \+ \(CAST\(\? AS INTEGER\) \* INTERVAL '1 second'\)/ : /CURRENT_TIMESTAMP \+ INTERVAL \? SECOND/);
            assert.equal(world.scheduled.get(created.scheduledMessage.id).send_at, world.now + 3600);
            const sendAt = Date.parse(created.scheduledMessage.sendAt);
            assert.ok(Math.abs(sendAt - (Date.now() + 3600 * 1000)) < 5000);
            assert.ok(io.emitted.some(e => e.event === 'scheduled_message_updated' && e.room === `user_${ALICE}`));
        });

        test('sent at its time through the normal message path', async () => {
            const { world, scheduled, io } = setup();
            const { scheduledMessage } = await scheduled.createScheduled(io, ALICE, { chatId: CHAT, content: 'Happy birthday!', sendInSeconds: 600 });

            assert.equal((await scheduled.processDueScheduledMessages(io)).sent, 0);
            assert.equal(io.emitted.filter(e => e.event === 'new_message').length, 0);

            world.now += 600;
            const result = await scheduled.processDueScheduledMessages(io);
            assert.equal(result.sent, 1);
            const sent = io.emitted.find(e => e.event === 'new_message');
            assert.equal(sent.room, `chat_${CHAT}`);
            assert.equal(sent.data.content, 'Happy birthday!');
            assert.equal(sent.data.sender_id, ALICE);
            // Same bookkeeping as a live send: chat timestamp and the sender's read position
            assert.ok(world.statements.some(s => s === 'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'));
            assert.ok(io.emitted.some(e => e.event === 'read_position_updated' && e.room === `user_${ALICE}`));

            const row = world.scheduled.get(scheduledMessage.id);
            assert.equal(row.status, 'sent');
            assert.equal(row.sent_message_id, sent.data.id);
            assert.equal((await scheduled.processDueScheduledMessages(io)).sent, 0);
        });

        test('overlapping ticks send it once', async () => {
            const { world, scheduled, io } = setup();
            await scheduled.createScheduled(io, ALICE, { chatId: CHAT, content: 'once', sendInSeconds: 10 });
            world.now += 10;
            await Promise.all([scheduled.processDueScheduledMessages(io), scheduled.processDueScheduledMessages(io), scheduled.processDueScheduledMessages(io)]);
            assert.equal(io.emitted.filter(e => e.event === 'new_message').length, 1);
            assert.equal([...world.messages.values()].filter(m => m.content === 'once').length, 1);
        });

        test('survives a restart: a fresh server instance sends what the old one stored', async () => {
            const world = createWorld(dbType);
            const before = setup(world);
            await before.scheduled.createScheduled(before.io, ALICE, { chatId: CHAT, content: 'after restart', sendInSeconds: 120 });

            // New process: modules reloaded, nothing kept in memory; the clock moved on while it was down
            world.now += 3600;
            const after = setup(world);
            const result = await after.scheduled.processDueScheduledMessages(after.io);
            assert.equal(result.sent, 1);
            assert.equal(after.io.emitted.find(e => e.event === 'new_message').data.content, 'after restart');

            // A row the old process claimed but never finished goes back to pending, then out
            const stuck = await after.scheduled.createScheduled(after.io, ALICE, { chatId: CHAT, content: 'stuck', sendInSeconds: 10 });
            Object.assign(world.scheduled.get(stuck.scheduledMessage.id), { status: 'sending', claimed_at: world.now });
            world.now += 200;
            const recovered = await after.scheduled.processDueScheduledMessages(after.io);
            assert.equal(recovered.recovered, 1);
            assert.equal(recovered.sent, 1);
        });

        test('left the chat by then: discarded, and the author is told', async () => {
            const { world, scheduled, io } = setup();
            const { scheduledMessage } = await scheduled.createScheduled(io, BOB, { chatId: CHAT, content: 'bye', sendInSeconds: 60 });
            world.members[CHAT].delete(BOB);
            world.now += 60;

            const result = await scheduled.processDueScheduledMessages(io);
            assert.equal(result.failed, 1);
            assert.equal(io.emitted.filter(e => e.event === 'new_message').length, 0);
            const row = world.scheduled.get(scheduledMessage.id);
            assert.equal(row.status, 'failed');
            assert.equal(row.failure_reason, scheduled.FAILURE_REASONS.NOT_A_MEMBER);
            const notice = io.emitted.find(e => e.event === 'scheduled_message_updated' && e.data.status === 'failed');
            assert.equal(notice.room, `user_${BOB}`);
            assert.equal(notice.data.failureReason, scheduled.FAILURE_REASONS.NOT_A_MEMBER);

            // Still listed (outside the chat) so it can be dismissed
            const listed = await scheduled.listScheduled(BOB);
            assert.deepEqual(listed.map(s => s.status), ['failed']);
            assert.ok((await scheduled.cancelScheduled(io, BOB, scheduledMessage.id)).scheduledMessage);
        });

        test('edit, reschedule and cancel: owner only, never after it was sent', async () => {
            const { world, scheduled, io } = setup();
            const { scheduledMessage } = await scheduled.createScheduled(io, ALICE, { chatId: CHAT, content: 'draft', sendInSeconds: 600 });

            assert.equal((await scheduled.updateScheduled(io, BOB, scheduledMessage.id, { content: 'hijack' })).error.status, 404);
            const edited = await scheduled.updateScheduled(io, ALICE, scheduledMessage.id, { content: 'final', sendInSeconds: 1200 });
            assert.equal(edited.scheduledMessage.content, 'final');
            assert.equal(world.scheduled.get(scheduledMessage.id).send_at, world.now + 1200);
            assert.equal((await scheduled.updateScheduled(io, ALICE, scheduledMessage.id, {})).error.status, 400);

            assert.equal((await scheduled.cancelScheduled(io, BOB, scheduledMessage.id)).error.status, 404);
            world.now += 1200;
            await scheduled.processDueScheduledMessages(io);
            assert.equal((await scheduled.updateScheduled(io, ALICE, scheduledMessage.id, { content: 'late' })).error.status, 409);
            assert.equal((await scheduled.cancelScheduled(io, ALICE, scheduledMessage.id)).error.status, 409);

            const other = await scheduled.createScheduled(io, ALICE, { chatId: CHAT, content: 'never', sendInSeconds: 60 });
            assert.ok((await scheduled.cancelScheduled(io, ALICE, other.scheduledMessage.id)).scheduledMessage);
            world.now += 60;
            assert.equal((await scheduled.processDueScheduledMessages(io)).sent, 0);
        });
    });

    describe(`phase 8: reminders (${dbType})`, () => {
        function setup() {
            const world = createWorld(dbType);
            const fake = setupFakeDb(dbType, world.handler);
            const messageId = world.nextId.message++;
            world.messages.set(messageId, { id: messageId, chat_id: CHAT, sender_id: BOB, message_type: 'text', content: 'Call the plumber', deleted: false });
            return { world, reminders: fake.load('utils/reminders.js'), io: recordingIo(), messageId };
        }

        test('fires privately to the user who set it, linking to the message', async () => {
            const { world, reminders, io, messageId } = setup();
            assert.equal((await reminders.createReminder(io, EVE, { messageId, remindInSeconds: 60 })).error.status, 404);

            const { reminder } = await reminders.createReminder(io, ALICE, { messageId, remindInSeconds: 3600 });
            assert.equal(reminder.status, 'pending');
            assert.equal(reminder.message.content, 'Call the plumber');

            // Setting a new time replaces it
            await reminders.createReminder(io, ALICE, { messageId, remindInSeconds: 60 });
            assert.equal([...world.reminders.values()].filter(r => r.status === 'pending').length, 1);

            assert.equal((await reminders.fireDueReminders(io)).fired, 0);
            world.now += 60;
            assert.equal((await reminders.fireDueReminders(io)).fired, 1);
            const due = io.emitted.filter(e => e.event === 'reminder_due');
            assert.equal(due.length, 1);
            assert.equal(due[0].room, `user_${ALICE}`);
            assert.equal(due[0].data.chatId, CHAT);
            assert.equal(due[0].data.messageId, messageId);
            assert.equal((await reminders.fireDueReminders(io)).fired, 0);
        });

        test('left the chat or message deleted: cancelled without telling anyone', async () => {
            const { world, reminders, io, messageId } = setup();
            await reminders.createReminder(io, BOB, { messageId, remindInSeconds: 60 });
            world.members[CHAT].delete(BOB);
            world.now += 60;
            const result = await reminders.fireDueReminders(io);
            assert.deepEqual(result, { fired: 0, cancelled: 1 });
            assert.equal(io.emitted.filter(e => e.event === 'reminder_due').length, 0);
        });

        test('only the owner can remove it', async () => {
            const { reminders, io, messageId } = setup();
            const { reminder } = await reminders.createReminder(io, ALICE, { messageId, remindInSeconds: 60 });
            assert.equal((await reminders.deleteReminder(io, BOB, reminder.id)).error.status, 404);
            assert.ok((await reminders.deleteReminder(io, ALICE, reminder.id)).reminder);
        });
    });
}

describe('phase 8: validation and routes', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const validation = load('utils/validation.js');
    const { validationResult } = require('express-validator');

    async function run(chain, req) {
        const request = { params: {}, query: {}, body: {}, ...req };
        for (const rule of chain) await rule.run(request);
        return validationResult(request).array().map(e => e.msg);
    }
    const inAnHour = () => new Date(Date.now() + 3600 * 1000).toISOString();

    test('scheduled send needs a future ISO time with an offset', async () => {
        assert.deepEqual(await run(validation.validateScheduleMessage, { body: { chatId: 5, content: 'hi', sendAt: inAnHour() } }), []);
        assert.ok((await run(validation.validateScheduleMessage, { body: { chatId: 5, content: 'hi', sendAt: '2020-01-01T00:00:00Z' } })).includes('Pick a time in the future'));
        assert.ok((await run(validation.validateScheduleMessage, { body: { chatId: 5, content: 'hi', sendAt: '2030-01-01T09:00' } })).length > 0);
        assert.ok((await run(validation.validateScheduleMessage, { body: { chatId: 'x', content: 5, sendAt: inAnHour() } })).length >= 2);
        assert.ok((await run(validation.validateUpdateScheduled, { params: { scheduledId: '3' }, body: {} })).length > 0);
        assert.deepEqual(await run(validation.validateUpdateScheduled, { params: { scheduledId: '3' }, body: { sendAt: inAnHour() } }), []);
    });

    test('poll creation and votes', async () => {
        const good = { chatId: 5, question: 'Q?', options: ['a', 'b'] };
        assert.deepEqual(await run(validation.validateCreatePoll, { body: good }), []);
        assert.deepEqual(await run(validation.validateCreatePoll, { body: { ...good, closesAt: null } }), []);
        assert.ok((await run(validation.validateCreatePoll, { body: { ...good, options: ['a'] } })).length > 0);
        assert.ok((await run(validation.validateCreatePoll, { body: { ...good, options: Array(13).fill('x') } })).length > 0);
        assert.ok((await run(validation.validateCreatePoll, { body: { ...good, multipleChoice: 'yes' } })).length > 0);
        assert.ok((await run(validation.validateCreatePoll, { body: { ...good, closesAt: '2020-01-01T00:00:00Z' } })).length > 0);
        assert.deepEqual(await run(validation.validatePollVote, { params: { pollId: '1' }, body: { optionIds: [] } }), []);
        assert.ok((await run(validation.validatePollVote, { params: { pollId: '1' }, body: { optionIds: 'x' } })).length > 0);
        assert.ok((await run(validation.validatePollVote, { params: { pollId: '1' }, body: { optionIds: [0] } })).length > 0);
    });

    test('reminders', async () => {
        assert.deepEqual(await run(validation.validateCreateReminder, { body: { messageId: 9, remindAt: inAnHour() } }), []);
        assert.ok((await run(validation.validateCreateReminder, { body: { messageId: 9 } })).length > 0);
        assert.ok((await run(validation.validateRemindersQuery, { query: { status: 'all' } })).length > 0);
    });

    test('every new route requires auth and is rate limited', () => {
        const pollRouter = load('routes/polls.js');
        const { scheduledRouter, remindersRouter } = load('routes/schedule.js');
        const { authenticateToken } = load('middleware/auth.js');
        for (const router of [pollRouter, scheduledRouter, remindersRouter]) {
            const layers = router.stack;
            // router.use(authenticateToken, ...) comes before every route
            assert.equal(layers[0].handle, authenticateToken);
            const routes = layers.filter(l => l.route);
            assert.ok(routes.length > 0);
            const limited = router === pollRouter
                ? routes.every(l => l.route.stack.length >= 4) // limiter + validation + check + controller
                : layers.slice(0, 2).every(l => !l.route); // auth and limiter mounted for the whole router
            assert.ok(limited);
        }
    });
});
