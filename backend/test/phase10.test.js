/**
 * Phase 10 on both fake drivers: voice notes (audio allowlist and size cap, recorder mime types,
 * waveform/duration validation, "played" only for members, once, and only with read receipts) and
 * disappearing messages (who may change the timer, the system notice, expires_at on every insert,
 * the sweep deleting rows and files on disk while a forwarded copy keeps its file, live removal
 * events, and no message text in push previews).
 *
 * The real PostgreSQL run of the same flow is described in FEATURES_SETUP.md (Phase 10, verification).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validationResult } = require('express-validator');
const { setupFakeDb, fakeIo } = require('./helpers/fakeDb');

const ALICE = 1;
const BOB = 2;
const EVE = 3; // not a member of anything
const DIRECT = 10;
const GROUP = 20;

async function runRules(rules, req) {
    for (const rule of rules) await rule.run(req);
    return validationResult(req).array();
}

/**
 * In-memory world for the timer, the sweep and voice plays
 */
function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        pg,
        members: {
            [DIRECT]: { [ALICE]: 'member', [BOB]: 'member' },
            [GROUP]: { [ALICE]: 'admin', [BOB]: 'member' }
        },
        chats: {
            [DIRECT]: { chat_type: 'direct', disappearing_seconds: null },
            [GROUP]: { chat_type: 'group', disappearing_seconds: null }
        },
        blocks: [],
        receiptsOff: new Set(),
        messages: new Map(), // id -> { id, chat_id, sender_id, message_type, content, file_id, expired }
        files: new Map(), // id -> { id, upload_path }
        plays: new Set(), // `${messageId}:${userId}`
        nextMessageId: 500,
        deletedMessageSql: []
    };
    const changed = (n) => (pg ? Array.from({ length: n }, () => ({ id: 1 })) : { affectedRows: n });
    const inserted = (id) => (pg ? [{ id }] : { insertId: id });

    world.handler = (sql, params) => {
        // One set of patterns for both drivers (pg gets $1, $2 ...)
        sql = sql.replace(/\$\d+/g, '?');

        // Membership + chat (utils/groups.getMembership)
        if (/^SELECT gm\.id, gm\.role, c\.chat_type, c\.announcement_only FROM group_members gm JOIN chats c/.test(sql)) {
            const [chatId, userId] = params.map(Number);
            const role = world.members[chatId] && world.members[chatId][userId];
            return role ? [{ id: 1, role, chat_type: world.chats[chatId].chat_type, announcement_only: pg ? false : 0 }] : [];
        }
        if (/^SELECT ub\.blocker_id FROM chats c JOIN group_members gm/.test(sql)) {
            const [userId, , , chatId] = params.map(Number);
            if (world.chats[chatId].chat_type !== 'direct') return [];
            const other = Object.keys(world.members[chatId]).map(Number).find(id => id !== userId);
            const block = world.blocks.find(b => (b.blocker === other && b.blocked === userId) || (b.blocker === userId && b.blocked === other));
            return block ? [{ blocker_id: block.blocker }] : [];
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE \(blocker_id = \? AND blocked_id = \?\)/.test(sql)) {
            const [a, b] = params.map(Number);
            const block = world.blocks.find(x => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a));
            return block ? [{ blocker_id: block.blocker }] : [];
        }
        if (/FROM message_requests WHERE chat_id = \? AND recipient_id = \?/.test(sql)) return [];
        if (/^SELECT last_seen_audience, photo_audience, bio_audience, groups_audience, read_receipts, typing_indicators FROM privacy_settings/.test(sql)) {
            const userId = Number(params[0]);
            return world.receiptsOff.has(userId)
                ? [{ last_seen_audience: 'everyone', photo_audience: 'everyone', bio_audience: 'everyone', groups_audience: 'everyone', read_receipts: pg ? false : 0, typing_indicators: pg ? true : 1 }]
                : [];
        }

        // Timer
        if (sql === 'SELECT disappearing_seconds FROM chats WHERE id = ?') {
            return [{ disappearing_seconds: world.chats[Number(params[0])].disappearing_seconds }];
        }
        if (/^UPDATE chats SET disappearing_seconds = \?/.test(sql)) {
            world.chats[Number(params[1])].disappearing_seconds = params[0];
            return changed(1);
        }
        if (/^INSERT INTO messages \(chat_id, sender_id, message_type, content, status\) VALUES/.test(sql)) {
            const [chatId, senderId, type, content] = params;
            const id = world.nextMessageId++;
            world.messages.set(id, { id, chat_id: Number(chatId), sender_id: Number(senderId), message_type: type, content, file_id: null, expired: false });
            world.systemInsertSql = sql;
            return inserted(id);
        }
        // getMessageById
        if (/FROM messages m JOIN users u ON m\.sender_id = u\.id/.test(sql)) {
            const m = world.messages.get(Number(params[0]));
            return m ? [{ ...m, username: `user${m.sender_id}`, expires_in: null, is_forwarded: 0, reply_to_message_id: null }] : [];
        }

        // Sweep
        if (/^SELECT id, chat_id, file_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP/.test(sql)) {
            return [...world.messages.values()].filter(m => m.expired).map(m => ({ id: m.id, chat_id: m.chat_id, file_id: m.file_id }));
        }
        if (/^DELETE FROM messages WHERE id IN/.test(sql)) {
            world.deletedMessageSql.push(sql);
            for (const id of params) {
                world.messages.delete(Number(id));
                for (const key of [...world.plays]) if (key.startsWith(`${id}:`)) world.plays.delete(key);
            }
            return changed(params.length);
        }
        if (/^SELECT f\.id, f\.upload_path FROM files f WHERE f\.id IN/.test(sql)) {
            return params.map(Number)
                .filter(id => world.files.has(id) && ![...world.messages.values()].some(m => m.file_id === id))
                .map(id => ({ id, upload_path: world.files.get(id).upload_path }));
        }
        if (/^DELETE FROM files WHERE id IN/.test(sql)) {
            for (const id of params.map(Number)) {
                if (![...world.messages.values()].some(m => m.file_id === id)) world.files.delete(id);
            }
            return changed(params.length);
        }

        // Voice plays
        if (/^SELECT m\.id, m\.chat_id, m\.sender_id, m\.message_type, m\.deleted_for_everyone FROM messages m JOIN group_members gm/.test(sql)) {
            const [userId, messageId] = params.map(Number);
            const m = world.messages.get(messageId);
            if (!m || !(world.members[m.chat_id] && world.members[m.chat_id][userId])) return [];
            return [{ id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, message_type: m.message_type, deleted_for_everyone: pg ? false : 0 }];
        }
        if (/^INSERT (IGNORE )?INTO voice_note_plays/.test(sql)) {
            const key = `${params[0]}:${params[1]}`;
            const fresh = !world.plays.has(key);
            world.plays.add(key);
            if (pg) {
                assert.match(sql, /^INSERT INTO voice_note_plays .* ON CONFLICT \(message_id, user_id\) DO NOTHING RETURNING message_id$/);
                return fresh ? [{ message_id: params[0] }] : [];
            }
            // INSERT IGNORE reports 0 rows for a duplicate even with mysql2's FOUND_ROWS flag
            // (ON DUPLICATE KEY UPDATE x = x would report 1 and look like a first play)
            assert.match(sql, /^INSERT IGNORE INTO voice_note_plays \(message_id, user_id\) VALUES \(\?, \?\)$/);
            return { affectedRows: fresh ? 1 : 0 };
        }
        if (/^SELECT vp\.message_id, vp\.user_id, CASE WHEN ps\.read_receipts = FALSE THEN 1 ELSE 0 END AS receipts_off FROM voice_note_plays vp/.test(sql)) {
            return [...world.plays].map(key => key.split(':').map(Number))
                .filter(([messageId]) => params.map(Number).includes(messageId))
                .map(([message_id, user_id]) => ({ message_id, user_id, receipts_off: world.receiptsOff.has(user_id) ? 1 : 0 }));
        }

        // Read-state bookkeeping after the notice (recordNewMessage / markChatRead): not under test here
        if (/^SELECT/.test(sql)) return [];
        return changed(0);
    };
    return world;
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`phase 10: disappearing messages timer (${dbType})`, () => {
        function load() {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            return { world, disappearing: load('utils/disappearing.js') };
        }

        test('only valid timers are accepted', async () => {
            const { disappearing } = load();
            for (const seconds of [1, 3600, -86400, 'abc']) {
                const result = await disappearing.setTimer(fakeIo(), DIRECT, ALICE, seconds);
                assert.equal(result.error.status, 400, String(seconds));
            }
        });

        test('non-members and non-admins of a group are refused, nothing is written', async () => {
            const { world, disappearing } = load();
            const io = fakeIo();
            assert.equal((await disappearing.setTimer(io, DIRECT, EVE, 86400)).error.code, 'NOT_A_MEMBER');
            assert.equal((await disappearing.setTimer(io, GROUP, BOB, 86400)).error.code, 'ADMIN_ONLY');
            assert.equal(world.chats[GROUP].disappearing_seconds, null);
            assert.equal(world.messages.size, 0);
            assert.equal(io.emitted.length, 0);
        });

        test('a block in a direct chat stops either person from changing it', async () => {
            const { world, disappearing } = load();
            world.blocks.push({ blocker: BOB, blocked: ALICE });
            const result = await disappearing.setTimer(fakeIo(), DIRECT, ALICE, 86400);
            assert.equal(result.error.status, 403);
            assert.equal(world.chats[DIRECT].disappearing_seconds, null);
        });

        test('either member of a direct chat turns it on; a system notice announces it', async () => {
            const { world, disappearing } = load();
            const io = fakeIo();
            const result = await disappearing.setTimer(io, DIRECT, BOB, 604800);

            assert.equal(result.changed, true);
            assert.equal(world.chats[DIRECT].disappearing_seconds, 604800);
            const notice = [...world.messages.values()][0];
            assert.equal(notice.message_type, 'system');
            assert.equal(notice.content, 'disappearing:604800');
            assert.equal(notice.sender_id, BOB);
            // The notice itself has no expires_at (it isn't part of the INSERT)
            assert.ok(!/expires_at/.test(world.systemInsertSql));

            const events = io.emitted.filter(e => e.room === `chat_${DIRECT}`).map(e => e.event);
            assert.deepEqual(events, ['chat_disappearing_updated', 'new_message']);
            assert.deepEqual(io.emitted.find(e => e.event === 'chat_disappearing_updated').data, { chatId: DIRECT, seconds: 604800, changedBy: BOB });
        });

        test('group admins can change it; the same value again announces nothing; 0 turns it off', async () => {
            const { world, disappearing } = load();
            const io = fakeIo();
            assert.equal((await disappearing.setTimer(io, GROUP, ALICE, 7776000)).changed, true);
            assert.equal((await disappearing.setTimer(io, GROUP, ALICE, 7776000)).changed, false);
            assert.equal(world.messages.size, 1);

            const off = await disappearing.setTimer(io, GROUP, ALICE, 0);
            assert.equal(off.changed, true);
            assert.equal(world.chats[GROUP].disappearing_seconds, null, 'stored as NULL when off');
            assert.equal([...world.messages.values()][1].content, 'disappearing:0');
        });

        test('checkCanChangeTimer is what GET /chats/:id reports as can_change_disappearing', async () => {
            const { disappearing } = load();
            assert.equal(await disappearing.checkCanChangeTimer(GROUP, ALICE), null);
            assert.ok(await disappearing.checkCanChangeTimer(GROUP, BOB));
            assert.equal(await disappearing.checkCanChangeTimer(DIRECT, BOB), null);
        });
    });

    describe(`phase 10: expired messages are really removed (${dbType})`, () => {
        let uploadDir;
        before(() => {
            uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-p10-'));
            process.env.UPLOAD_PATH = uploadDir;
        });
        after(() => {
            delete process.env.UPLOAD_PATH;
            fs.rmSync(uploadDir, { recursive: true, force: true });
        });

        function writeUpload(name) {
            const dir = path.join(uploadDir, 'audio');
            fs.mkdirSync(dir, { recursive: true });
            const full = path.join(dir, name);
            fs.writeFileSync(full, 'audio');
            return full;
        }

        test('rows, file rows and files on disk go; a file a forwarded copy still uses stays', async () => {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            const { deleteExpiredMessages } = load('utils/disappearing.js');

            const ownPath = writeUpload('own.webm');
            const sharedPath = writeUpload('shared.webm');
            world.files.set(1, { id: 1, upload_path: ownPath });
            world.files.set(2, { id: 2, upload_path: sharedPath });
            world.messages.set(1, { id: 1, chat_id: DIRECT, sender_id: ALICE, message_type: 'voice', file_id: 1, expired: true });
            world.messages.set(2, { id: 2, chat_id: DIRECT, sender_id: ALICE, message_type: 'voice', file_id: 2, expired: true });
            world.messages.set(3, { id: 3, chat_id: GROUP, sender_id: ALICE, message_type: 'text', file_id: null, expired: true });
            world.messages.set(4, { id: 4, chat_id: GROUP, sender_id: ALICE, message_type: 'voice', file_id: 2, expired: false }); // forwarded copy
            world.messages.set(5, { id: 5, chat_id: DIRECT, sender_id: BOB, message_type: 'text', file_id: null, expired: false });
            world.plays.add('1:2');

            const io = fakeIo();
            const result = await deleteExpiredMessages(io);

            assert.deepEqual(result, { deleted: 3, filesRemoved: 1 });
            assert.deepEqual([...world.messages.keys()].sort(), [4, 5]);
            assert.equal(world.files.has(1), false);
            assert.equal(fs.existsSync(ownPath), false, 'the file is gone from disk');
            assert.equal(world.files.has(2), true);
            assert.equal(fs.existsSync(sharedPath), true, 'still used by the forwarded copy');
            assert.equal(world.plays.size, 0);

            const expired = io.emitted.filter(e => e.event === 'messages_expired');
            assert.deepEqual(expired.map(e => e.room).sort(), [`chat_${DIRECT}`, `chat_${GROUP}`]);
            assert.deepEqual(expired.find(e => e.room === `chat_${DIRECT}`).data, { chatId: DIRECT, messageIds: [1, 2] });
            assert.deepEqual(expired.find(e => e.room === `chat_${GROUP}`).data, { chatId: GROUP, messageIds: [3] });
        });

        test('nothing due: no deletes, no events', async () => {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            const { deleteExpiredMessages } = load('utils/disappearing.js');
            world.messages.set(9, { id: 9, chat_id: DIRECT, sender_id: ALICE, message_type: 'text', file_id: null, expired: false });

            const io = fakeIo();
            assert.deepEqual(await deleteExpiredMessages(io), { deleted: 0, filesRemoved: 0 });
            assert.equal(world.deletedMessageSql.length, 0);
            assert.equal(io.emitted.length, 0);
        });

        test('a stored path outside the uploads folder is never unlinked', async () => {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            const { deleteExpiredMessages } = load('utils/disappearing.js');

            const outside = path.join(os.tmpdir(), `frichat-p10-outside-${Date.now()}.txt`);
            fs.writeFileSync(outside, 'keep me');
            try {
                world.files.set(7, { id: 7, upload_path: outside });
                world.messages.set(7, { id: 7, chat_id: DIRECT, sender_id: ALICE, message_type: 'file', file_id: 7, expired: true });
                const result = await deleteExpiredMessages(fakeIo());
                assert.equal(result.filesRemoved, 0);
                assert.equal(fs.existsSync(outside), true);
            } finally {
                fs.rmSync(outside, { force: true });
            }
        });

        test('the scheduler runs the sweep every tick', async () => {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            const { runTimedJobs } = load('utils/scheduler.js');
            world.messages.set(1, { id: 1, chat_id: DIRECT, sender_id: ALICE, message_type: 'text', file_id: null, expired: true });

            const result = await runTimedJobs(fakeIo());
            assert.deepEqual(result.expired, { deleted: 1, filesRemoved: 0 });
            assert.equal(world.messages.size, 0);
        });
    });

    describe(`phase 10: expires_at on every send path (${dbType})`, () => {
        test('the expiry is computed in the INSERT from the chat timer, on the database clock', () => {
            const { load } = setupFakeDb(dbType, () => []);
            const { chatExpiresAtSql } = load('utils/timeSql.js');
            const sql = chatExpiresAtSql();
            assert.equal((sql.match(/\?/g) || []).length, 1, 'one parameter: the chat id');
            assert.match(sql, /FROM chats dc WHERE dc\.id = \?/);
            assert.match(sql, /WHEN dc\.disappearing_seconds > 0 THEN CURRENT_TIMESTAMP/);
            assert.match(sql, /ELSE NULL END/);
            assert.match(sql, dbType === 'postgresql' ? /dc\.disappearing_seconds \* INTERVAL '1 second'/ : /INTERVAL dc\.disappearing_seconds SECOND/);
        });

        test('socket, REST, upload, forward and scheduled/poll delivery all use it', () => {
            const files = ['server.js', 'controllers/messageController.js', 'utils/messageDelivery.js'];
            const source = files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
            const inserts = source.match(/INSERT INTO messages \([^)]*\)/g);
            assert.ok(inserts.length >= 6);
            for (const insert of inserts) assert.match(insert, /expires_at/, insert);
        });

        test('expired-but-not-yet-swept messages are left out of pages, search and the chat list', () => {
            const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            assert.match(read('controllers/messageController.js'), /AND \(m\.expires_at IS NULL OR m\.expires_at > CURRENT_TIMESTAMP\)/);
            assert.match(read('controllers/searchController.js'), /AND \(m\.expires_at IS NULL OR m\.expires_at > CURRENT_TIMESTAMP\)`/);
            assert.match(read('controllers/chatController.js'), /AND \(m2\.expires_at IS NULL OR m2\.expires_at > CURRENT_TIMESTAMP\)/);
        });

        test('messages carry expires_at as a UTC ISO time (seconds-until from SQL), voice notes their waveform', () => {
            const { load } = setupFakeDb(dbType, () => []);
            const { shapeMessage, MESSAGE_COLUMNS } = load('utils/messageQueries.js');
            assert.match(MESSAGE_COLUMNS, /as expires_in/);
            const now = Date.now();
            const shaped = shapeMessage({ id: 1, reply_to_message_id: null, expires_in: 3600, duration_ms: '4200', waveform: '0,50,100' });
            assert.ok(Math.abs(Date.parse(shaped.expires_at) - (now + 3600 * 1000)) < 5000);
            assert.equal(shaped.duration_ms, 4200);
            assert.deepEqual(shaped.waveform, [0, 50, 100]);
            assert.equal('expires_in' in shaped, false);

            const plain = shapeMessage({ id: 2, reply_to_message_id: null, expires_in: null, duration_ms: null, waveform: 'x,1' });
            assert.equal(plain.expires_at, null);
            assert.equal(plain.waveform, null);
        });
    });

    describe(`phase 10: voice note plays (${dbType})`, () => {
        function load() {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            world.messages.set(40, { id: 40, chat_id: DIRECT, sender_id: ALICE, message_type: 'voice', file_id: null });
            world.messages.set(41, { id: 41, chat_id: DIRECT, sender_id: ALICE, message_type: 'text', file_id: null });
            return { world, voice: load('utils/voiceNotes.js') };
        }

        test('non-members, bad ids and non-voice messages are refused', async () => {
            const { world, voice } = load();
            const io = fakeIo();
            assert.equal((await voice.markVoicePlayed(io, 40, EVE)).error, 'Message not found');
            assert.equal((await voice.markVoicePlayed(io, 'x', BOB)).error, 'Invalid message ID');
            assert.equal((await voice.markVoicePlayed(io, 41, BOB)).error, 'This is not a voice note');
            assert.equal(world.plays.size, 0);
            assert.equal(io.emitted.length, 0);
        });

        test('the first play by someone else tells the sender, once', async () => {
            const { world, voice } = load();
            const io = fakeIo();
            assert.equal((await voice.markVoicePlayed(io, 40, ALICE)).recorded, false, 'own note');
            assert.equal((await voice.markVoicePlayed(io, 40, BOB)).recorded, true);
            assert.equal((await voice.markVoicePlayed(io, 40, BOB)).recorded, false);
            assert.deepEqual(io.emitted, [{ room: `user_${ALICE}`, event: 'voice_note_played', data: { messageId: 40, chatId: DIRECT, userId: BOB } }]);
            assert.ok(world.plays.has('40:2'));
        });

        test('with read receipts off the play is kept for the listener but never shown to the sender', async () => {
            const { world, voice } = load();
            world.receiptsOff.add(BOB);
            const io = fakeIo();
            assert.equal((await voice.markVoicePlayed(io, 40, BOB)).recorded, true);
            assert.equal(io.emitted.length, 0);

            const forAlice = [{ id: 40, sender_id: ALICE, message_type: 'voice' }];
            await voice.attachVoicePlays(forAlice, ALICE);
            assert.equal(forAlice[0].voice_played, false);

            const forBob = [{ id: 40, sender_id: ALICE, message_type: 'voice' }];
            await voice.attachVoicePlays(forBob, BOB);
            assert.equal(forBob[0].played_by_me, true);
        });

        test('a sender with read receipts off sees no plays either; a block records nothing', async () => {
            const { world, voice } = load();
            world.receiptsOff.add(ALICE);
            const io = fakeIo();
            await voice.markVoicePlayed(io, 40, BOB);
            assert.equal(io.emitted.length, 0);
            const forAlice = [{ id: 40, sender_id: ALICE, message_type: 'voice' }];
            await voice.attachVoicePlays(forAlice, ALICE);
            assert.equal(forAlice[0].voice_played, false);

            const blocked = load();
            blocked.world.blocks.push({ blocker: ALICE, blocked: BOB });
            assert.equal((await blocked.voice.markVoicePlayed(fakeIo(), 40, BOB)).recorded, false);
            assert.equal(blocked.world.plays.size, 0);
        });
    });

    describe(`phase 10: push previews (${dbType})`, () => {
        test('disappearing chats and expiring messages never show text; voice notes get a label', () => {
            const { load } = setupFakeDb(dbType, () => []);
            const { buildPreview, DISAPPEARING_PREVIEW } = load('utils/push.js');
            assert.equal(buildPreview({ message_type: 'text', content: 'the secret' }, { disappearing: true }), DISAPPEARING_PREVIEW);
            assert.equal(buildPreview({ message_type: 'poll', content: 'secret question?' }, { disappearing: true }), DISAPPEARING_PREVIEW);
            assert.equal(buildPreview({ message_type: 'text', content: 'the secret', expires_at: '2030-01-01T00:00:00.000Z' }), DISAPPEARING_PREVIEW);
            assert.equal(buildPreview({ message_type: 'text', content: 'hello' }), 'hello');
            assert.equal(buildPreview({ message_type: 'voice' }), '🎤 Voice message');
        });

        test('a system notice sends no push at all', async () => {
            const queries = [];
            const { load } = setupFakeDb(dbType, (sql) => {
                queries.push(sql);
                return [];
            });
            // Real keys, so push counts as configured and the notice itself is what stops it
            const keys = require('web-push').generateVAPIDKeys();
            process.env.VAPID_PUBLIC_KEY = keys.publicKey;
            process.env.VAPID_PRIVATE_KEY = keys.privateKey;
            const push = load('utils/push.js');
            try {
                assert.equal(push.isPushConfigured(), true);
                const result = await push.notifyNewMessage(fakeIo(), { id: 1, chat_id: DIRECT, sender_id: ALICE, message_type: 'system', content: 'disappearing:86400' });
                assert.deepEqual(result, { sent: 0, removed: 0, failed: 0 });
                assert.ok(!queries.some(sql => /FROM group_members gm/.test(sql)), 'no recipients looked up');

                // ...while a normal message does look recipients up
                await push.notifyNewMessage(fakeIo(), { id: 2, chat_id: DIRECT, sender_id: ALICE, message_type: 'text', content: 'hi' });
                assert.ok(queries.some(sql => /FROM group_members gm/.test(sql)));
            } finally {
                process.env.VAPID_PUBLIC_KEY = '';
                process.env.VAPID_PRIVATE_KEY = '';
            }
        });

        test('reminder pushes for a disappearing message hide its text too', () => {
            const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'reminders.js'), 'utf8');
            assert.match(source, /CASE WHEN m\.expires_at IS NULL THEN 0 ELSE 1 END AS disappearing/);
            assert.match(source, /buildPreview\(\{ message_type: message\.messageType, content: message\.content \}, \{ disappearing: message\.disappearing \}\)/);
        });
    });
}

describe('phase 10: uploads and validation', () => {
    test('audio types are allowed, recorder codec parameters are stripped, audio has its own cap', () => {
        delete process.env.MAX_AUDIO_FILE_SIZE;
        const { load } = setupFakeDb('mysql', () => []);
        const { getUploadLimits, baseMimeType, maxSizeFor } = load('middleware/upload.js');
        const limits = getUploadLimits();
        for (const type of ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']) {
            assert.ok(limits.allowedTypes.includes(type), type);
            assert.ok(limits.audioTypes.includes(type), type);
        }
        assert.equal(baseMimeType('audio/webm;codecs=opus'), 'audio/webm');
        assert.equal(baseMimeType(' Audio/MP4 ; codecs=mp4a.40.2'), 'audio/mp4');
        assert.equal(limits.maxAudioFileSize, 10 * 1024 * 1024);
        assert.ok(limits.maxAudioFileSize <= limits.maxFileSize);
        assert.equal(maxSizeFor('audio/webm;codecs=opus'), limits.maxAudioFileSize);
        assert.equal(maxSizeFor('image/png'), limits.maxFileSize);
    });

    test('MAX_AUDIO_FILE_SIZE is never above MAX_FILE_SIZE', () => {
        process.env.MAX_AUDIO_FILE_SIZE = String(500 * 1024 * 1024);
        process.env.MAX_FILE_SIZE = String(20 * 1024 * 1024);
        try {
            const { load } = setupFakeDb('mysql', () => []);
            const { getUploadLimits } = load('middleware/upload.js');
            assert.equal(getUploadLimits().maxAudioFileSize, 20 * 1024 * 1024);
        } finally {
            delete process.env.MAX_AUDIO_FILE_SIZE;
            delete process.env.MAX_FILE_SIZE;
        }
    });

    test('audio uploads become voice messages', () => {
        const { load } = setupFakeDb('mysql', () => []);
        const { messageTypeForMime } = load('utils/uploads.js');
        assert.equal(messageTypeForMime('audio/webm'), 'voice');
        assert.equal(messageTypeForMime('audio/mp4'), 'voice');
        assert.equal(messageTypeForMime('application/pdf'), 'file');
    });

    test('voice duration and waveform rules', async () => {
        const { load } = setupFakeDb('mysql', () => []);
        const { validateUploadReply, isWaveform } = load('utils/validation.js');

        assert.deepEqual(await runRules(validateUploadReply, { body: { voiceDurationMs: '4200', voiceWaveform: '0,50,100' } }), []);
        assert.deepEqual(await runRules(validateUploadReply, { body: { voiceDurationMs: String(303000) } }), [], 'grace for timer drift');
        assert.equal((await runRules(validateUploadReply, { body: { voiceDurationMs: String(400000) } })).length, 1, 'over 5 minutes');
        assert.equal((await runRules(validateUploadReply, { body: { voiceDurationMs: '-5' } })).length, 1);

        assert.equal(isWaveform('0,100'), true);
        assert.equal(isWaveform(new Array(64).fill(50).join(',')), true);
        assert.equal(isWaveform(new Array(65).fill(50).join(',')), false);
        for (const bad of ['101', '1,,2', '1;2', '<script>', '1.5', '']) assert.equal(isWaveform(bad), false, bad);
    });

    test('disappearing timer rules: only off, 24 hours, 7 days and 90 days', async () => {
        const { load } = setupFakeDb('mysql', () => []);
        const { validateDisappearingTimer } = load('utils/validation.js');
        for (const seconds of [0, 86400, 604800, 7776000]) {
            assert.deepEqual(await runRules(validateDisappearingTimer, { params: { chatId: '5' }, body: { seconds } }), [], String(seconds));
        }
        for (const seconds of [1, 3600, '86400; DROP TABLE', 'abc', null]) {
            assert.ok((await runRules(validateDisappearingTimer, { params: { chatId: '5' }, body: { seconds } })).length > 0, String(seconds));
        }
        assert.ok((await runRules(validateDisappearingTimer, { params: { chatId: 'x' }, body: { seconds: 0 } })).length > 0);
    });

    test('a refused upload does not leave its file on disk', async () => {
        const { load } = setupFakeDb('mysql', () => []);
        const { validateUploadReply, checkUploadValidation } = load('utils/validation.js');
        const file = path.join(os.tmpdir(), `frichat-p10-refused-${Date.now()}.webm`);
        fs.writeFileSync(file, 'x');
        const req = { body: { voiceWaveform: 'nope' }, file: { path: file } };
        for (const rule of validateUploadReply) await rule.run(req);
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        checkUploadValidation(req, res, () => assert.fail('must not continue'));
        assert.equal(res.statusCode, 400);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(fs.existsSync(file), false);
    });

    test('PUT /api/chats/:chatId/disappearing is authenticated, rate limited and validated', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'chats.js'), 'utf8');
        assert.match(source, /router\.use\(authenticateToken\);[\s\S]*router\.put\('\/:chatId\/disappearing', groupActionLimiter, validateDisappearingTimer, checkValidation, chatController\.setDisappearingTimer\)/);
    });

    test('voice_played is a rate-limited socket event', () => {
        const limits = require('../config/socketLimits');
        assert.ok(Object.values(limits.groups).some(group => group.events.includes('voice_played')));
        const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.match(server, /onLimited\('voice_played'/);
    });
});
