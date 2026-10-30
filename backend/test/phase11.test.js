/**
 * Phase 11 backend: 1:1 calls.
 *   - TURN REST-API credentials (coturn scheme), STUN defaults, TTL limits, hosted static credentials
 *   - who may call (direct chat member, no block, no unaccepted request) on both fake drivers
 *   - the call state machine with a fake store, io and clock: ringing, busy, one call per user,
 *     accept on one tab, signaling only between the two bound sockets, reject/cancel/timeout/hangup
 *     with history and notices, reconnect grace and call_sync
 *   - GET /api/calls/ice-servers and GET /api/calls through the real routes (auth, validation)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setupFakeDb } = require('./helpers/fakeDb');

const ALICE = 1;
const BOB = 2;
const CAROL = 3;
const EVE = 4; // in no chat with anyone
const DIRECT_AB = 10;
const DIRECT_CB = 11;
const DIRECT_AC = 12;
const GROUP = 20;

// ===== TURN =====

describe('phase 11: ICE servers and TURN credentials', () => {
    const { buildIceServers, createTurnCredentials, turnTtlSeconds } = require('../utils/turn');

    test('STUN only by default; public Google STUN when STUN_URLS is not set', () => {
        const result = buildIceServers(ALICE, { env: {} });
        assert.equal(result.turn, false);
        assert.equal(result.iceServers.length, 1);
        assert.ok(result.iceServers[0].urls.every(url => url.startsWith('stun:')));
    });

    test('STUN_URLS overrides the default; junk entries are dropped', () => {
        const result = buildIceServers(ALICE, { env: { STUN_URLS: 'stun:stun.example.com:3478, http://evil, ' } });
        assert.deepEqual(result.iceServers, [{ urls: ['stun:stun.example.com:3478'] }]);
    });

    test('TURN_URL + TURN_SECRET: username "<expiry>:<userId>", password base64(HMAC-SHA1(secret, username))', () => {
        const now = Date.UTC(2026, 9, 30, 12, 0, 0);
        const env = { TURN_URL: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349', TURN_SECRET: 's3cret', TURN_TTL: '3600' };
        const result = buildIceServers(BOB, { env, now });
        assert.equal(result.turn, true);
        assert.equal(result.ttl, 3600);
        const turn = result.iceServers[1];
        assert.deepEqual(turn.urls, ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349']);
        const expiry = Math.floor(now / 1000) + 3600;
        assert.equal(turn.username, `${expiry}:${BOB}`);
        assert.equal(turn.credential, crypto.createHmac('sha1', 's3cret').update(`${expiry}:${BOB}`).digest('base64'));
        assert.ok(!JSON.stringify(result).includes('s3cret'), 'the secret never leaves the server');
    });

    test('credentials differ per user and expire', () => {
        const a = createTurnCredentials('k', ALICE, 600, 0);
        const b = createTurnCredentials('k', BOB, 600, 0);
        assert.notEqual(a.credential, b.credential);
        assert.equal(a.expiresAt, 600);
    });

    test('TTL is clamped to 10 minutes .. 1 day', () => {
        assert.equal(turnTtlSeconds({ TURN_TTL: '5' }), 600);
        assert.equal(turnTtlSeconds({ TURN_TTL: '999999' }), 86400);
        assert.equal(turnTtlSeconds({}), 6 * 3600);
    });

    test('hosted TURN with fixed credentials; TURN_URL without credentials is ignored', () => {
        const fixed = buildIceServers(ALICE, { env: { TURN_URL: 'turn:relay.example.com:443', TURN_USERNAME: 'u', TURN_PASSWORD: 'p' } });
        assert.deepEqual(fixed.iceServers[1], { urls: ['turn:relay.example.com:443'], username: 'u', credential: 'p' });

        const warn = console.warn;
        console.warn = () => {};
        try {
            const none = buildIceServers(ALICE, { env: { TURN_URL: 'turn:relay.example.com:443' } });
            assert.equal(none.turn, false);
            assert.equal(none.iceServers.length, 1);
        } finally {
            console.warn = warn;
        }
    });
});

// ===== Who may call (SQL, both drivers) =====

function createWorld(dbType) {
    const pg = dbType === 'postgresql';
    const world = {
        members: {
            [DIRECT_AB]: [ALICE, BOB],
            [DIRECT_CB]: [CAROL, BOB],
            [DIRECT_AC]: [ALICE, CAROL],
            [GROUP]: [ALICE, BOB, CAROL]
        },
        types: { [DIRECT_AB]: 'direct', [DIRECT_CB]: 'direct', [DIRECT_AC]: 'direct', [GROUP]: 'group' },
        blocks: [],
        requests: {},
        calls: []
    };
    world.handler = (sql, params) => {
        sql = sql.replace(/\$\d+/g, '?');
        if (/^SELECT c\.chat_type, other\.user_id AS other_id FROM chats c JOIN group_members me/.test(sql)) {
            const [userId, , chatId] = params.map(Number);
            const members = world.members[chatId] || [];
            if (!members.includes(userId)) return [];
            const others = members.filter(id => id !== userId);
            return (others.length ? others : [null]).map(other => ({ chat_type: world.types[chatId], other_id: other }));
        }
        if (/^SELECT blocker_id FROM user_blocks WHERE \(blocker_id = \? AND blocked_id = \?\)/.test(sql)) {
            const [a, b] = params.map(Number);
            const block = world.blocks.find(x => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a));
            return block ? [{ blocker_id: block.blocker }] : [];
        }
        if (/^SELECT chat_id, requester_id, recipient_id, status FROM message_requests WHERE chat_id = \?$/.test(sql)) {
            const request = world.requests[Number(params[0])];
            return request ? [{ chat_id: params[0], ...request }] : [];
        }
        if (/^INSERT INTO calls/.test(sql)) {
            const id = world.calls.length + 1;
            world.calls.push({ id, sql, params });
            return pg ? [{ id }] : { insertId: id };
        }
        if (/^SELECT/.test(sql)) return [];
        return pg ? [] : { affectedRows: 1 };
    };
    return world;
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`phase 11: who may call (${dbType})`, () => {
        function load() {
            const world = createWorld(dbType);
            const { load } = setupFakeDb(dbType, world.handler);
            return { world, calls: load('utils/calls.js') };
        }

        test('members of a direct chat may call the other member', async () => {
            const { calls } = load();
            assert.deepEqual(await calls.checkCallAllowed(DIRECT_AB, ALICE), { calleeId: BOB });
            assert.deepEqual(await calls.checkCallAllowed(DIRECT_AB, BOB), { calleeId: ALICE });
        });

        test('non-members and group chats are refused', async () => {
            const { calls } = load();
            assert.equal((await calls.checkCallAllowed(DIRECT_AB, EVE)).error.code, 'NOT_A_MEMBER');
            assert.equal((await calls.checkCallAllowed(999, ALICE)).error.code, 'NOT_A_MEMBER');
            assert.equal((await calls.checkCallAllowed(GROUP, ALICE)).error.code, 'NOT_DIRECT');
        });

        test('a block either way stops the call, worded for the caller', async () => {
            const { world, calls } = load();
            world.blocks.push({ blocker: BOB, blocked: ALICE });
            assert.equal((await calls.checkCallAllowed(DIRECT_AB, ALICE)).error.message, 'You can\'t call this user.');
            assert.match((await calls.checkCallAllowed(DIRECT_AB, BOB)).error.message, /You blocked this user/);
        });

        test('no calls until a message request is accepted (either side)', async () => {
            const { world, calls } = load();
            world.requests[DIRECT_AB] = { requester_id: ALICE, recipient_id: BOB, status: 'pending' };
            assert.equal((await calls.checkCallAllowed(DIRECT_AB, ALICE)).error.code, 'REQUEST_PENDING');
            assert.equal((await calls.checkCallAllowed(DIRECT_AB, BOB)).error.code, 'REQUEST_PENDING');
            world.requests[DIRECT_AB].status = 'accepted';
            assert.deepEqual(await calls.checkCallAllowed(DIRECT_AB, ALICE), { calleeId: BOB });
        });

        test('history rows use bound parameters only', async () => {
            const { world, calls } = load();
            await calls.insertCall({ chatId: DIRECT_AB, callerId: ALICE, calleeId: BOB, type: 'video', status: 'ringing' });
            await calls.insertCall({ chatId: DIRECT_AB, callerId: ALICE, calleeId: BOB, type: 'voice', status: 'busy' });
            assert.deepEqual(world.calls[0].params, [DIRECT_AB, ALICE, BOB, 'video', 'ringing']);
            assert.deepEqual(world.calls[1].params, [DIRECT_AB, ALICE, BOB, 'voice', 'busy', 'busy']);
            assert.ok(world.calls.every(row => !/video|voice/.test(row.sql.replace(/call_type/, ''))));
        });
    });
}

// ===== State machine =====

function fakeIo() {
    const emitted = [];
    const target = (room, except = []) => ({
        emit: (event, data) => emitted.push({ room, except, event, data }),
        except: (id) => target(room, [...except, id])
    });
    return { emitted, to: (room) => target(room) };
}

function fakeSocket(userId, id) {
    const sent = [];
    return {
        id,
        userId,
        sent,
        emit: (event, data) => sent.push({ event, data }),
        last(event) {
            return [...sent].reverse().find(entry => entry.event === event);
        }
    };
}

function fakeTimers() {
    let next = 1;
    const pending = new Map();
    return {
        pending,
        setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
        clearTimeout: (id) => { pending.delete(id); },
        async fire(ms) {
            for (const [id, timer] of [...pending]) {
                if (timer.ms === ms) {
                    pending.delete(id);
                    await timer.fn();
                }
            }
        }
    };
}

// utils/calls.js against a fake driver (the state machine itself uses the fake store below)
function loadCalls() {
    return setupFakeDb('mysql', () => []).load('utils/calls.js');
}

function createHarness({ blocked = [], dnd = [] } = {}) {
    const { createCallManager } = loadCalls();
    const io = fakeIo();
    const timers = fakeTimers();
    let clock = 1_000_000;
    const db = { rows: [], ended: [], answered: [], notices: [] };
    const directChats = { [DIRECT_AB]: [ALICE, BOB], [DIRECT_CB]: [CAROL, BOB], [DIRECT_AC]: [ALICE, CAROL] };
    const store = {
        async checkCallAllowed(chatId, callerId) {
            const members = directChats[chatId];
            if (!members || !members.includes(callerId)) return { error: { code: 'NOT_A_MEMBER', message: 'Access denied to this chat' } };
            const calleeId = members.find(id => id !== callerId);
            if (blocked.some(([a, b]) => (a === callerId && b === calleeId) || (a === calleeId && b === callerId))) {
                return { error: { code: 'BLOCKED', message: 'You can\'t call this user.' } };
            }
            return { calleeId };
        },
        async insertCall(row) {
            db.rows.push(row);
            return db.rows.length;
        },
        async markAnswered(id) { db.answered.push(id); },
        async markEnded(id, status, reason) { db.ended.push({ id, status, reason }); },
        async postCallNotice(_io, call, status, seconds) { db.notices.push({ callId: call.id, chatId: call.chatId, sender: call.callerId, status, seconds }); },
        async callerCard(viewerId, callerId) { return { id: callerId, username: `user${callerId}`, fullName: null, avatarUrl: null }; },
        async isDnd(userId) { return dnd.includes(userId); }
    };
    const pushes = [];
    const push = {
        notifyIncomingCall: (_io, call) => pushes.push({ kind: 'incoming', callId: call.id, to: call.calleeId }),
        notifyMissedCall: (_io, call) => pushes.push({ kind: 'missed', callId: call.id, to: call.calleeId })
    };
    const manager = createCallManager({
        io,
        store,
        push,
        timers,
        now: () => clock,
        limits: { ringTimeoutMs: 30000, reconnectGraceMs: 15000 }
    });
    return {
        io, timers, db, pushes, manager,
        advance: (ms) => { clock += ms; },
        emittedTo: (room, event) => io.emitted.filter(e => e.room === room && (!event || e.event === event))
    };
}

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n' };

async function ringingCall(h, type = 'video') {
    const alice = fakeSocket(ALICE, 'sA');
    const bobTab1 = fakeSocket(BOB, 'sB1');
    const bobTab2 = fakeSocket(BOB, 'sB2');
    const callId = await h.manager.invite(alice, { chatId: DIRECT_AB, type });
    return { alice, bobTab1, bobTab2, callId };
}

describe('phase 11: call state machine', () => {
    test('invite rings every tab of the callee and tells the caller it is ringing', async () => {
        const h = createHarness();
        const { alice, callId } = await ringingCall(h);
        assert.equal(callId, 1);
        const invite = h.emittedTo(`user_${BOB}`, 'call_invite')[0];
        assert.equal(invite.data.callId, 1);
        assert.equal(invite.data.type, 'video');
        assert.equal(invite.data.caller.id, ALICE);
        assert.equal(invite.data.silent, false);
        assert.equal(alice.last('call_ringing').data.callId, 1);
        assert.deepEqual(h.db.rows[0], { chatId: DIRECT_AB, callerId: ALICE, calleeId: BOB, type: 'video', status: 'ringing' });
        assert.deepEqual(h.pushes, [{ kind: 'incoming', callId: 1, to: BOB }]);
    });

    test('do-not-disturb rings silently', async () => {
        const h = createHarness({ dnd: [BOB] });
        await ringingCall(h);
        assert.equal(h.emittedTo(`user_${BOB}`, 'call_invite')[0].data.silent, true);
    });

    test('invalid requests, non-members and blocks are refused with call_error and nothing is stored', async () => {
        const h = createHarness({ blocked: [[BOB, ALICE]] });
        const alice = fakeSocket(ALICE, 'sA');
        await h.manager.invite(alice, { chatId: DIRECT_AB, type: 'hologram' });
        assert.equal(alice.last('call_error').data.code, 'INVALID');
        await h.manager.invite(alice, { chatId: 'x', type: 'voice' });
        assert.equal(alice.last('call_error').data.code, 'INVALID');
        await h.manager.invite(fakeSocket(EVE, 'sE'), { chatId: DIRECT_AB, type: 'voice' });
        await h.manager.invite(alice, { chatId: DIRECT_AB, type: 'voice' });
        assert.equal(alice.last('call_error').data.code, 'BLOCKED');
        assert.equal(h.db.rows.length, 0);
        assert.equal(h.io.emitted.length, 0);
        assert.equal(h.manager.getActiveCallFor(ALICE), null, 'a refused invite frees the caller');
    });

    test('one call per user: a second invite to someone in a call gets call_busy; the caller cannot start two', async () => {
        const h = createHarness();
        const { alice } = await ringingCall(h);
        await h.manager.invite(alice, { chatId: DIRECT_AC, type: 'voice' });
        assert.equal(alice.last('call_error').data.code, 'ALREADY_IN_CALL');

        const carol = fakeSocket(CAROL, 'sC');
        await h.manager.invite(carol, { chatId: DIRECT_CB, type: 'voice' });
        assert.equal(carol.last('call_busy').data.calleeId, BOB);
        assert.equal(h.db.rows[1].status, 'busy');
        assert.deepEqual(h.db.notices.map(n => n.status), ['busy']);
        assert.equal(h.emittedTo(`user_${BOB}`, 'call_invite').length, 1, 'Bob is not rung twice');
        assert.equal(h.manager.getActiveCallFor(CAROL), null);
    });

    test('accept on one tab stops the others ringing; only the callee can accept', async () => {
        const h = createHarness();
        const { alice, bobTab1, bobTab2, callId } = await ringingCall(h);
        await h.manager.accept(alice, { callId });
        assert.equal(alice.last('call_error').data.code, 'NOT_FOUND');
        await h.manager.accept(fakeSocket(EVE, 'sE'), { callId });

        await h.manager.accept(bobTab1, { callId });
        assert.ok(h.emittedTo('sA', 'call_accept').length === 1);
        const cancel = h.emittedTo(`user_${BOB}`, 'call_cancel')[0];
        assert.equal(cancel.data.reason, 'answered_elsewhere');
        assert.deepEqual(cancel.except, ['sB1']);
        assert.deepEqual(h.db.answered, [callId]);
        assert.equal(h.timers.pending.size, 0, 'ring timer cleared');

        await h.manager.accept(bobTab2, { callId });
        assert.equal(bobTab2.last('call_error').data.code, 'ALREADY_ANSWERED');
    });

    test('offer/answer/candidates flow only between the two bound sockets, cleaned', async () => {
        const h = createHarness();
        const { alice, bobTab1, bobTab2, callId } = await ringingCall(h);

        // Not before the call is accepted
        h.manager.offer(alice, { callId, sdp: OFFER });
        assert.equal(alice.last('call_error').data.code, 'NOT_FOUND');

        await h.manager.accept(bobTab1, { callId });
        h.manager.offer(alice, { callId, sdp: { ...OFFER, extra: '<script>' } });
        const offer = h.emittedTo('sB1', 'call_offer')[0];
        assert.deepEqual(offer.data, { callId, sdp: OFFER, iceRestart: false });

        h.manager.answer(bobTab1, { callId, sdp: ANSWER });
        assert.deepEqual(h.emittedTo('sA', 'call_answer')[0].data.sdp, ANSWER);

        h.manager.iceCandidate(bobTab1, { callId, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, junk: 1 } });
        assert.deepEqual(h.emittedTo('sA', 'call_ice_candidate')[0].data.candidate, { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 });

        // Bob's other tab, a stranger, the wrong description type, oversized SDP, malformed candidates
        h.manager.offer(bobTab2, { callId, sdp: OFFER });
        assert.equal(bobTab2.last('call_error').data.code, 'OTHER_DEVICE');
        const eve = fakeSocket(EVE, 'sE');
        h.manager.iceCandidate(eve, { callId, candidate: { candidate: 'x' } });
        assert.equal(eve.last('call_error').data.code, 'NOT_FOUND');
        h.manager.offer(alice, { callId, sdp: ANSWER });
        h.manager.offer(alice, { callId, sdp: { type: 'offer', sdp: 'x'.repeat(40000) } });
        assert.equal(alice.last('call_error').data.code, 'INVALID');
        h.manager.iceCandidate(alice, { callId, candidate: { candidate: 42 } });
        h.manager.iceCandidate(alice, { callId, candidate: { candidate: 'c', sdpMLineIndex: -1 } });

        assert.equal(h.emittedTo('sB1', 'call_offer').length, 1);
        assert.equal(h.emittedTo('sB2').length, 0, 'the other tab never sees signaling');
        assert.equal(h.emittedTo('sB1', 'call_ice_candidate').length, 0);
    });

    test('reject: the caller hears it, history says declined, a notice is posted', async () => {
        const h = createHarness();
        const { alice, bobTab2, callId } = await ringingCall(h);
        await h.manager.reject(alice, { callId }); // not the callee: ignored
        assert.equal(h.db.ended.length, 0);
        await h.manager.reject(bobTab2, { callId });
        assert.equal(h.emittedTo('sA', 'call_reject').length, 1);
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'declined', reason: 'declined' }]);
        assert.deepEqual(h.db.notices[0], { callId, chatId: DIRECT_AB, sender: ALICE, status: 'declined', seconds: 0 });
        assert.equal(h.manager.getActiveCallFor(ALICE), null);
        assert.equal(h.manager.getActiveCallFor(BOB), null);
        assert.equal(h.pushes.filter(p => p.kind === 'missed').length, 0);
    });

    test('cancel: only the caller; the callee gets call_cancel and a missed-call push', async () => {
        const h = createHarness();
        const { alice, bobTab1, callId } = await ringingCall(h);
        await h.manager.cancel(bobTab1, { callId });
        assert.equal(h.db.ended.length, 0);
        await h.manager.cancel(alice, { callId });
        assert.equal(h.emittedTo(`user_${BOB}`, 'call_cancel')[0].data.reason, 'cancelled');
        assert.equal(h.db.ended[0].status, 'cancelled');
        assert.deepEqual(h.pushes.map(p => p.kind), ['incoming', 'missed']);
    });

    test('30 seconds without an answer: call_timeout to both, missed in history', async () => {
        const h = createHarness();
        const { callId } = await ringingCall(h);
        await h.timers.fire(30000);
        assert.equal(h.emittedTo(`user_${ALICE}`, 'call_timeout').length, 1);
        assert.equal(h.emittedTo(`user_${BOB}`, 'call_timeout').length, 1);
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'missed', reason: 'timeout' }]);
        assert.equal(h.db.notices[0].status, 'missed');
        // Both are free again
        const again = await h.manager.invite(fakeSocket(BOB, 'sB1'), { chatId: DIRECT_AB, type: 'voice' });
        assert.equal(again, 2);
    });

    test('hangup after 4:12 records a completed call with its duration; other tabs cannot end it', async () => {
        const h = createHarness();
        const { alice, bobTab1, bobTab2, callId } = await ringingCall(h);
        await h.manager.accept(bobTab1, { callId });
        h.advance(252 * 1000);
        await h.manager.hangup(bobTab2, { callId });
        assert.equal(h.db.ended.length, 0);
        await h.manager.hangup(alice, { callId, reason: 'nonsense' });
        assert.equal(h.emittedTo(`user_${BOB}`, 'call_hangup')[0].data.reason, 'hangup');
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'completed', reason: 'hangup' }]);
        assert.equal(Math.round(h.db.notices[0].seconds), 252);
        assert.equal(h.emittedTo(`user_${ALICE}`, 'call_log_updated').length, 1);
    });

    test('a failed connection is stored as failed', async () => {
        const h = createHarness();
        const { alice, bobTab1, callId } = await ringingCall(h);
        await h.manager.accept(bobTab1, { callId });
        await h.manager.hangup(alice, { callId, reason: 'connection_failed' });
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'failed', reason: 'connection_failed' }]);
    });

    test('hangup while ringing: by the caller cancels, by the callee declines', async () => {
        const h1 = createHarness();
        const r1 = await ringingCall(h1);
        await h1.manager.hangup(r1.alice, { callId: r1.callId });
        assert.equal(h1.db.ended[0].status, 'cancelled');

        const h2 = createHarness();
        const r2 = await ringingCall(h2);
        await h2.manager.hangup(r2.bobTab1, { callId: r2.callId });
        assert.equal(h2.db.ended[0].status, 'declined');
    });

    test('the caller disconnecting while it rings cancels; a callee tab closing does not', async () => {
        const h = createHarness();
        const { alice, bobTab1, callId } = await ringingCall(h);
        await h.manager.disconnect(bobTab1);
        assert.equal(h.db.ended.length, 0);
        await h.manager.disconnect(alice);
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'cancelled', reason: 'caller_left' }]);
    });

    test('a dropped socket mid-call has a grace period; call_sync on the new socket keeps the call', async () => {
        const h = createHarness();
        const { alice, bobTab1, callId } = await ringingCall(h);
        await h.manager.accept(bobTab1, { callId });
        await h.manager.disconnect(alice);
        assert.equal(h.db.ended.length, 0);
        assert.equal(h.timers.pending.size, 1);

        // Signaling from Bob waits (no target) instead of going to the dead socket
        h.manager.offer(bobTab1, { callId, sdp: OFFER });
        assert.equal(h.emittedTo('sA', 'call_offer').length, 0);

        const aliceNew = fakeSocket(ALICE, 'sA2');
        h.manager.sync(aliceNew, { callId });
        assert.deepEqual(aliceNew.last('call_sync').data, { callId, active: true });
        assert.equal(h.emittedTo('sB1', 'call_peer_reconnected').length, 1);
        assert.equal(h.timers.pending.size, 0, 'grace timer cleared');

        h.manager.answer(bobTab1, { callId, sdp: ANSWER });
        assert.equal(h.emittedTo('sA2', 'call_answer').length, 1);
    });

    test('without call_sync the grace period ends the call for both', async () => {
        const h = createHarness();
        const { bobTab1, callId } = await ringingCall(h);
        await h.manager.accept(bobTab1, { callId });
        await h.manager.disconnect(bobTab1);
        await h.timers.fire(15000);
        assert.equal(h.emittedTo(`user_${ALICE}`, 'call_hangup')[0].data.reason, 'connection_lost');
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'completed', reason: 'connection_lost' }]);
    });

    test('call_sync: a stale call is reported inactive; a ringing call is shown again to the callee', async () => {
        const h = createHarness();
        const { alice, callId } = await ringingCall(h);
        const bobNewTab = fakeSocket(BOB, 'sB9');
        h.manager.sync(bobNewTab, {});
        assert.equal(bobNewTab.last('call_invite').data.callId, callId);

        const stranger = fakeSocket(EVE, 'sE');
        h.manager.sync(stranger, { callId });
        assert.deepEqual(stranger.last('call_sync').data, { callId, active: false });

        // Another tab of the caller can't take over a live call
        await h.manager.accept(fakeSocket(BOB, 'sB1'), { callId });
        const aliceOtherTab = fakeSocket(ALICE, 'sA3');
        h.manager.sync(aliceOtherTab, { callId });
        assert.equal(aliceOtherTab.last('call_sync').data.otherDevice, true);
        assert.equal(alice.sent.filter(e => e.event === 'call_sync').length, 0);
    });

    test('the caller disconnecting while the invite is still being stored cancels it quietly', async () => {
        const h = createHarness();
        const alice = fakeSocket(ALICE, 'sA');
        const pending = h.manager.invite(alice, { chatId: DIRECT_AB, type: 'voice' });
        await h.manager.disconnect(alice);
        await pending;
        assert.equal(h.emittedTo(`user_${BOB}`, 'call_invite').length, 0);
        assert.equal(h.db.ended[0].status, 'cancelled');
        assert.equal(h.manager.getActiveCallFor(ALICE), null);
        assert.equal(h.manager.getActiveCallFor(BOB), null);
    });
});

describe('phase 11: notice codes and signaling cleanup', () => {
    const { noticeCode, cleanCandidate, cleanDescription } = loadCalls();

    test('notice code carries only fixed words and a number', () => {
        assert.equal(noticeCode('video', 'missed', 0), 'call:video:missed:0');
        assert.equal(noticeCode('voice', 'completed', 251.6), 'call:voice:completed:252');
        assert.equal(noticeCode('voice', 'completed', -3), 'call:voice:completed:0');
    });

    test('candidates and descriptions', () => {
        assert.equal(cleanCandidate(null), null);
        assert.equal(cleanCandidate('x'), undefined);
        assert.equal(cleanCandidate({ candidate: 'a'.repeat(2000) }), undefined);
        assert.deepEqual(cleanCandidate({ candidate: '' }), { candidate: '', sdpMid: null, sdpMLineIndex: null });
        assert.equal(cleanDescription({ type: 'offer', sdp: '' }, 'offer'), null);
        assert.equal(cleanDescription(null, 'offer'), null);
    });
});

// ===== REST endpoints =====

describe('phase 11: /api/calls routes', () => {
    function loadRoutes() {
        const rows = [];
        const { load } = setupFakeDb('mysql', (sql, params) => {
            if (/FROM calls c JOIN users u/.test(sql)) {
                rows.push({ sql, params });
                return [
                    { id: 9, chat_id: DIRECT_AB, caller_id: ALICE, callee_id: BOB, call_type: 'video', status: 'completed', end_reason: 'hangup', started_at: new Date('2026-10-30T10:00:00Z'), answered_at: new Date('2026-10-30T10:00:05Z'), ended_at: new Date('2026-10-30T10:04:17Z'), other_id: BOB, other_username: 'bob', other_full_name: '<b>Bob</b>', other_avatar_url: null },
                    { id: 8, chat_id: DIRECT_AB, caller_id: BOB, callee_id: ALICE, call_type: 'voice', status: 'missed', end_reason: 'timeout', started_at: new Date('2026-10-30T09:00:00Z'), answered_at: null, ended_at: new Date('2026-10-30T09:00:30Z'), other_id: BOB, other_username: 'bob', other_full_name: null, other_avatar_url: null }
                ];
            }
            return [];
        });
        return { rows, load };
    }

    function routeHandlers(router, path) {
        const layer = router.stack.find(l => l.route && l.route.path === path);
        return layer.route.stack.map(s => s.handle);
    }

    async function run(handlers, req) {
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
            set(name, value) { this.headers[name] = value; return this; }
        };
        for (const handler of handlers) {
            let nextCalled = false;
            await handler(req, res, () => { nextCalled = true; });
            if (!nextCalled) break;
        }
        return res;
    }

    test('every route needs a signed-in user, and is rate limited', () => {
        const { load } = loadRoutes();
        const router = load('routes/calls.js');
        const middleware = router.stack.filter(l => !l.route).map(l => l.handle.name);
        assert.equal(middleware[0], 'authenticateToken');
        assert.equal(middleware.length, 2);
    });

    test('ice-servers: per-user, not cached', async () => {
        const { load } = loadRoutes();
        const controller = load('controllers/callController.js');
        process.env.TURN_URL = 'turn:t.example.com:3478';
        process.env.TURN_SECRET = 'abc';
        try {
            const res = await run([controller.getIceServers], { user: { id: ALICE } });
            assert.equal(res.body.success, true);
            assert.equal(res.headers['Cache-Control'], 'no-store');
            assert.equal(res.body.data.turn, true);
            assert.match(res.body.data.iceServers[1].username, new RegExp(`^\\d+:${ALICE}$`));
        } finally {
            delete process.env.TURN_URL;
            delete process.env.TURN_SECRET;
        }
    });

    test('history: own calls only, direction and duration, cursor validated, names left raw for the client to escape', async () => {
        const { load, rows } = loadRoutes();
        const router = load('routes/calls.js');
        const handlers = routeHandlers(router, '/');

        const bad = await run(handlers, { user: { id: ALICE }, query: { limit: '500' } });
        assert.equal(bad.statusCode, 400);

        const res = await run(handlers, { user: { id: ALICE }, query: { limit: '1', before: '50' } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(rows[0].params, [ALICE, ALICE, ALICE, ALICE, 50]);
        assert.match(rows[0].sql, /LIMIT 2$/);
        assert.equal(res.body.data.length, 1);
        assert.deepEqual(res.body.pagination, { hasMore: true, nextBefore: 9 });
        const [first] = res.body.data;
        assert.equal(first.direction, 'outgoing');
        assert.equal(first.durationSeconds, 252);
        assert.equal(first.otherUser.fullName, '<b>Bob</b>');
    });
});
