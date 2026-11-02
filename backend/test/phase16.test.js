/**
 * Phase 16: small group calls.
 *   - GROUP_CALL_MAX limits
 *   - the room with a fake store, io and clock: start, ring, join, leave, full room, non-members,
 *     blocked pairs, per-pair relay only inside the room, busy across 1:1 and group calls,
 *     reconnect grace, the call ending with the last person, history and notices
 *   - the group call SQL on both fake drivers
 *   - GET /api/calls/active and group rows in GET /api/calls through the real routes
 *   - notice wording and page wiring from the real frontend files
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { setupFakeDb } = require('./helpers/fakeDb');
const { runFrontendScript } = require('./helpers/frontendScripts');

const ALICE = 1;
const BOB = 2;
const CAROL = 3;
const DAVE = 4;
const ERIN = 5;
const OUTSIDER = 9;
const GROUP = 20;
const OTHER_GROUP = 21;
const DIRECT_AB = 10;

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n' };
const CANDIDATE = { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };

function fakeIo() {
    const emitted = [];
    const target = (room, except = []) => ({
        emit: (event, data) => emitted.push({ room, except, event, data }),
        except: (id) => target(room, [...except, id])
    });
    return { emitted, to: (room) => target(room) };
}

function fakeSocket(userId, id = `s${userId}`) {
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

function harness({ members = [ALICE, BOB, CAROL, DAVE, ERIN], blocks = [], dnd = [], max = 4 } = {}) {
    const { createCallManager } = setupFakeDb('mysql', () => []).load('utils/calls.js');
    const io = fakeIo();
    const timers = fakeTimers();
    let clock = 1_000_000;
    const world = { members: { [GROUP]: members, [OTHER_GROUP]: [ALICE, BOB, CAROL] }, blocks: [...blocks] };
    const db = { rows: [], ended: [], answered: [], notices: [], joins: [], leaves: [] };
    const blockSets = (userId) => ({
        blocked: new Set(world.blocks.filter(([a]) => a === userId).map(([, b]) => b)),
        blockedBy: new Set(world.blocks.filter(([, b]) => b === userId).map(([a]) => a))
    });
    const store = {
        async checkCallAllowed(chatId, callerId) {
            if (chatId === DIRECT_AB) return callerId === ALICE ? { calleeId: BOB } : { calleeId: ALICE };
            return world.members[chatId] && world.members[chatId].includes(callerId)
                ? { error: { code: 'NOT_DIRECT', message: 'Calls are only available in one-to-one chats' } }
                : { error: { code: 'NOT_A_MEMBER', message: 'Access denied to this chat' } };
        },
        async getGroupForCall(chatId, userId) {
            const memberIds = world.members[chatId];
            return memberIds && memberIds.includes(userId) ? { name: 'Friends', memberIds } : null;
        },
        async isChatMember(chatId, userId) { return (world.members[chatId] || []).includes(userId); },
        async blockSets(userId) { return blockSets(userId); },
        async insertCall(row) { db.rows.push(row); return db.rows.length; },
        async markAnswered(id) { db.answered.push(id); },
        async markEnded(id, status, reason) { db.ended.push({ id, status, reason }); },
        async postCallNotice(_io, call, status) { db.notices.push({ code: `direct:${status}` }); },
        async postGroupNotice(_io, call, code) { db.notices.push({ code, sender: call.callerId, chatId: call.chatId }); },
        async recordJoin(callId, userId) { db.joins.push({ callId, userId }); },
        async recordLeave(callId, userId) { db.leaves.push({ callId, userId }); },
        async callerCard(viewerId, userId) { return { id: userId, username: `user${userId}`, fullName: null, avatarUrl: viewerId === userId ? 'me.png' : null }; },
        async isDnd(userId) { return dnd.includes(userId); }
    };
    const pushes = [];
    const push = {
        notifyIncomingCall() {},
        notifyMissedCall() {},
        notifyIncomingGroupCall: (_io, call, card, userId) => pushes.push({ kind: 'incoming', to: userId, callId: call.id }),
        notifyMissedGroupCall: (_io, call, card, userId) => pushes.push({ kind: 'missed', to: userId, callId: call.id })
    };
    const manager = createCallManager({ io, store, push, timers, now: () => clock, limits: { ringTimeoutMs: 30000, reconnectGraceMs: 15000, groupCallMax: max } });
    return {
        io, timers, db, pushes, manager, world, store,
        advance: (ms) => { clock += ms; },
        toRoom: (room, event) => io.emitted.filter(e => e.room === room && (!event || e.event === event)),
        ringsFor: (userId) => io.emitted.filter(e => e.room === `user_${userId}` && e.event === 'call_invite')
    };
}

async function startedCall(h, type = 'video') {
    const alice = fakeSocket(ALICE);
    const callId = await h.manager.invite(alice, { chatId: GROUP, type });
    return { alice, callId };
}

async function joined(h, callId, ...userIds) {
    const sockets = [];
    for (const userId of userIds) {
        const socket = fakeSocket(userId);
        await h.manager.join(socket, { callId });
        sockets.push(socket);
    }
    return sockets;
}

function ids(event) {
    return event.data.participants.map(person => person.id);
}

// The relayed events go out to a socket id room
function relayed(h, socketId, event) {
    return h.toRoom(socketId, event).map(entry => entry.data);
}

describe('phase 16: GROUP_CALL_MAX', () => {
    const { groupCallMax } = require('../config/calls');

    test('defaults to 4 and is kept between 2 and 8', () => {
        assert.equal(groupCallMax({}), 4);
        assert.equal(groupCallMax({ GROUP_CALL_MAX: 'lots' }), 4);
        assert.equal(groupCallMax({ GROUP_CALL_MAX: '3' }), 3);
        assert.equal(groupCallMax({ GROUP_CALL_MAX: '1' }), 2);
        assert.equal(groupCallMax({ GROUP_CALL_MAX: '50' }), 8);
    });

    test('new events are rate limited with their 1:1 groups', () => {
        const { groups } = require('../config/socketLimits');
        assert.ok(groups.call.events.includes('call_join'));
        assert.ok(groups.call.events.includes('call_leave'));
        assert.ok(groups.callSignal.events.includes('call_media_state'));
    });
});

describe('phase 16: starting and ringing', () => {
    test('any member can start: one row with no callee, a notice, ringing for the other members', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        assert.deepEqual(h.db.rows[0], { chatId: GROUP, callerId: ALICE, calleeId: null, type: 'video', status: 'ringing' });
        assert.equal(h.db.notices[0].code, 'call:group:video:started');
        assert.equal(alice.last('call_ringing').data.group, true);
        assert.equal(alice.last('call_ringing').data.ringing, 4);
        for (const userId of [BOB, CAROL, DAVE, ERIN]) {
            const [ring] = h.ringsFor(userId);
            assert.equal(ring.data.callId, callId);
            assert.equal(ring.data.group, true);
            assert.equal(ring.data.chatName, 'Friends');
            assert.equal(ring.data.caller.id, ALICE);
        }
        assert.equal(h.ringsFor(ALICE).length, 0);
        assert.deepEqual(h.pushes.map(p => p.to), [BOB, CAROL, DAVE, ERIN]);
        const list = h.toRoom(alice.id, 'call_participants')[0];
        assert.deepEqual(ids(list), [ALICE]);
        assert.equal(h.toRoom(`chat_${GROUP}`, 'call_room_update')[0].data.active, true);
    });

    test('blocked and do-not-disturb members get no ring and no push', async () => {
        const h = harness({ dnd: [BOB], blocks: [[CAROL, ALICE], [ALICE, DAVE]] });
        await startedCall(h);
        assert.equal(h.ringsFor(BOB).length, 0);
        assert.equal(h.ringsFor(CAROL).length, 0);
        assert.equal(h.ringsFor(DAVE).length, 0);
        assert.equal(h.ringsFor(ERIN).length, 1);
        assert.deepEqual(h.pushes.map(p => p.to), [ERIN]);
    });

    test('a member already in another call is not rung', async () => {
        const h = harness();
        h.world.members[OTHER_GROUP] = [BOB, CAROL];
        await h.manager.invite(fakeSocket(BOB), { chatId: OTHER_GROUP, type: 'voice' });
        await startedCall(h);
        assert.equal(h.ringsFor(BOB).length, 0);
        assert.equal(h.ringsFor(DAVE).length, 1);
    });

    test('a non-member cannot start; bad input is refused; nothing is stored', async () => {
        const h = harness();
        const outsider = fakeSocket(OUTSIDER);
        await h.manager.invite(outsider, { chatId: GROUP, type: 'video' });
        assert.equal(outsider.last('call_error').data.code, 'NOT_A_MEMBER');
        await h.manager.invite(outsider, { chatId: GROUP, type: 'hologram' });
        assert.equal(outsider.last('call_error').data.code, 'INVALID');
        assert.equal(h.db.rows.length, 0);
        assert.equal(h.manager.getActiveCallFor(OUTSIDER), null);
    });

    test('call_invite in a chat with a running call joins it, also when two people start together', async () => {
        const h = harness();
        const alice = fakeSocket(ALICE);
        const bob = fakeSocket(BOB);
        await Promise.all([
            h.manager.invite(alice, { chatId: GROUP, type: 'video' }),
            h.manager.invite(bob, { chatId: GROUP, type: 'voice' })
        ]);
        assert.equal(h.db.rows.length, 1);
        const list = h.toRoom(bob.id, 'call_participants').at(-1);
        assert.deepEqual(ids(list), [ALICE, BOB]);
        assert.equal(list.data.type, 'video', 'the running call decides the type');
    });

    test('Dismiss stops one person\'s ring (all their tabs) and leaves the call running', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        const bob = fakeSocket(BOB);
        await h.manager.reject(bob, { callId });
        const cancel = h.toRoom(`user_${BOB}`, 'call_cancel')[0];
        assert.equal(cancel.data.reason, 'declined');
        assert.equal(h.manager.isLive(callId), true);
        assert.equal(h.db.ended.length, 0);
    });

    test('ringing times out for those still ringing, without ending the call', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        await h.timers.fire(30000);
        assert.equal(h.toRoom(`user_${BOB}`, 'call_timeout').length, 1);
        assert.equal(h.manager.isLive(callId), true);
    });

    test('someone who joined is not rung again; a reloaded page gets the ring back only if still ringing', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        assert.equal(h.toRoom(`user_${BOB}`, 'call_cancel')[0].data.reason, 'answered_elsewhere');
        await h.manager.leave(bob, { callId });
        const bobTab = fakeSocket(BOB, 'sB2');
        await h.manager.sync(bobTab, {});
        assert.equal(bobTab.last('call_invite'), undefined, 'left, but not rung again');

        const carolTab = fakeSocket(CAROL, 'sC2');
        await h.manager.sync(carolTab, {});
        assert.equal(carolTab.last('call_invite').data.callId, callId);
    });
});

describe('phase 16: joining and leaving', () => {
    test('the joiner is told to offer to everyone there; existing participants get the new list', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob, carol] = await joined(h, callId, BOB, CAROL);

        const bobList = h.toRoom(bob.id, 'call_participants')[0];
        assert.deepEqual(bobList.data.offerTo, [ALICE]);
        const carolList = h.toRoom(carol.id, 'call_participants')[0];
        assert.deepEqual(carolList.data.offerTo, [ALICE, BOB]);
        assert.deepEqual(ids(carolList), [ALICE, BOB, CAROL]);

        const aliceLists = h.toRoom(alice.id, 'call_participants');
        assert.deepEqual(ids(aliceLists.at(-1)), [ALICE, BOB, CAROL]);
        assert.ok(aliceLists.every(list => list.data.offerTo === undefined), 'those already there wait for offers');
        assert.equal(h.toRoom(bob.id, 'call_participants').at(-1).data.offerTo, undefined);
    });

    test('the second person connects the call: answered once, timer from then on', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        h.advance(5000);
        const [bob] = await joined(h, callId, BOB);
        h.advance(7000);
        await joined(h, callId, CAROL);
        assert.deepEqual(h.db.answered, [callId]);
        assert.equal(h.toRoom(bob.id, 'call_participants').at(-1).data.elapsedMs, 7000);
    });

    test('a fifth joiner gets CALL_FULL and a clear message; someone leaving frees the place', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB, CAROL, DAVE);
        const erin = fakeSocket(ERIN);
        await h.manager.join(erin, { callId });
        const error = erin.last('call_error').data;
        assert.equal(error.code, 'CALL_FULL');
        assert.equal(error.event, 'call_join');
        assert.match(error.message, /call is full/);
        assert.equal(h.manager.getActiveCallFor(ERIN), null);

        await h.manager.leave(bob, { callId });
        await h.manager.join(erin, { callId });
        assert.deepEqual(ids(h.toRoom(erin.id, 'call_participants').at(-1)), [ALICE, CAROL, DAVE, ERIN]);
    });

    test('joiners racing for the last place cannot overfill the room', async () => {
        const h = harness({ max: 2 });
        const { callId } = await startedCall(h);
        const bob = fakeSocket(BOB);
        const carol = fakeSocket(CAROL);
        await Promise.all([h.manager.join(bob, { callId }), h.manager.join(carol, { callId })]);
        assert.equal(h.manager._calls.get(callId).participants.size, 2);
        assert.equal(carol.last('call_error').data.code, 'CALL_FULL');
    });

    test('non-members are refused on join and on every later event', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const outsider = fakeSocket(OUTSIDER);
        await h.manager.join(outsider, { callId });
        assert.equal(outsider.last('call_error').data.code, 'NOT_A_MEMBER');
        assert.equal(h.manager.getActiveCallFor(OUTSIDER), null);

        const [bob] = await joined(h, callId, BOB);
        h.world.members[GROUP] = h.world.members[GROUP].filter(id => id !== BOB);
        await h.manager.offer(bob, { callId, to: ALICE, sdp: OFFER });
        assert.equal(bob.last('call_error').data.code, 'NOT_A_MEMBER');
        assert.equal(relayed(h, alice.id, 'call_offer').length, 0, 'nothing is relayed for them');
        assert.equal(h.toRoom(`user_${BOB}`, 'call_hangup')[0].data.reason, 'removed');
        assert.deepEqual(ids(h.toRoom(alice.id, 'call_participants').at(-1)), [ALICE]);
    });

    test('removing a member from the group takes them out of the call and stops their ring', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        await joined(h, callId, BOB);
        await h.manager.memberRemoved(BOB, GROUP);
        assert.equal(h.toRoom(`user_${BOB}`, 'call_hangup')[0].data.reason, 'removed');
        assert.equal(h.manager.getActiveCallFor(BOB), null);

        await h.manager.memberRemoved(CAROL, GROUP);
        assert.equal(h.toRoom(`user_${CAROL}`, 'call_cancel')[0].data.callId, callId);
    });

    test('a user is in one call at a time, across group and 1:1 calls', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);

        // In a group call: can't start or join anything else, and a 1:1 caller gets busy
        await h.manager.invite(alice, { chatId: OTHER_GROUP, type: 'voice' });
        assert.equal(alice.last('call_error').data.code, 'ALREADY_IN_CALL');

        const carol = fakeSocket(CAROL);
        const secondCall = await h.manager.invite(carol, { chatId: OTHER_GROUP, type: 'voice' });
        await h.manager.join(bob, { callId: secondCall });
        assert.equal(bob.last('call_error').data.code, 'ALREADY_IN_CALL');
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);

        const direct = harness();
        const directAlice = fakeSocket(ALICE);
        const direct1 = await direct.manager.invite(directAlice, { chatId: DIRECT_AB, type: 'voice' });
        await direct.manager.accept(fakeSocket(BOB), { callId: direct1 });
        const dave = fakeSocket(DAVE);
        const groupCall = await direct.manager.invite(dave, { chatId: GROUP, type: 'voice' });
        const inDirect = fakeSocket(BOB, 'sB9');
        await direct.manager.join(inDirect, { callId: groupCall });
        assert.equal(inDirect.last('call_error').data.code, 'ALREADY_IN_CALL');
    });

    test('calling someone who is in a group call gets call_busy', async () => {
        const h = harness();
        h.world.members[GROUP] = [BOB, CAROL];
        const carol = fakeSocket(CAROL);
        const callId = await h.manager.invite(carol, { chatId: GROUP, type: 'voice' });
        await joined(h, callId, BOB);
        const alice = fakeSocket(ALICE);
        await h.manager.invite(alice, { chatId: DIRECT_AB, type: 'voice' });
        assert.equal(alice.last('call_busy').data.calleeId, BOB);
    });

    test('the same user on a second tab can\'t join twice', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        await joined(h, callId, BOB);
        const tab = fakeSocket(BOB, 'sB2');
        await h.manager.join(tab, { callId });
        assert.equal(tab.last('call_error').data.code, 'OTHER_DEVICE');
    });

    test('joining a call that ended says so', async () => {
        const h = harness();
        const bob = fakeSocket(BOB);
        await h.manager.join(bob, { callId: 77 });
        assert.equal(bob.last('call_error').data.code, 'NOT_FOUND');
        assert.equal(h.manager.getActiveCallFor(BOB), null);
    });

    test('members can leave and rejoin while the call runs, and a rejoin is one participant', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        await h.manager.leave(bob, { callId });
        assert.deepEqual(ids(h.toRoom(alice.id, 'call_participants').at(-1)), [ALICE]);
        assert.equal(h.manager.isLive(callId), true);
        await h.manager.join(bob, { callId });
        await h.manager.leave(bob, { callId });
        await h.manager.leave(alice, { callId });
        assert.match(h.db.notices.at(-1).code, /^call:group:video:completed:\d+:2:1,2$/);
    });

    test('another tab of a participant can\'t make them leave', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        await joined(h, callId, BOB);
        await h.manager.leave(fakeSocket(BOB, 'other'), { callId });
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);
    });
});

describe('phase 16: blocks', () => {
    test('a blocked pair can\'t share a room, whichever side blocked; each gets a clear message', async () => {
        const h = harness({ blocks: [[BOB, CAROL]] });
        const { callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);

        const carol = fakeSocket(CAROL);
        await h.manager.join(carol, { callId });
        const refused = carol.last('call_error').data;
        assert.equal(refused.code, 'BLOCKED');
        assert.match(refused.message, /block between you and someone/);
        assert.ok(!refused.message.includes('user'), 'it doesn\'t say who');
        assert.equal(h.manager.getActiveCallFor(CAROL), null);

        await h.manager.leave(bob, { callId });
        await joined(h, callId, CAROL);
        const again = fakeSocket(BOB);
        await h.manager.join(again, { callId });
        assert.match(again.last('call_error').data.message, /You blocked someone in this call/);
    });

    test('two blocked people joining at once: only the first gets in', async () => {
        const h = harness({ blocks: [[BOB, CAROL]] });
        const { callId } = await startedCall(h);
        const bob = fakeSocket(BOB);
        const carol = fakeSocket(CAROL);
        await Promise.all([h.manager.join(bob, { callId }), h.manager.join(carol, { callId })]);
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);
        assert.equal(h.manager.getActiveCallFor(CAROL), null);
    });

    test('whoever\'s checks finish first, the one who asked first gets in', async () => {
        const h = harness({ blocks: [[BOB, CAROL]] });
        const { callId } = await startedCall(h);
        const blockSets = h.store.blockSets;
        h.store.blockSets = async (userId) => {
            if (userId === BOB) await new Promise(resolve => setTimeout(resolve, 5));
            return blockSets(userId);
        };
        await Promise.all([h.manager.join(fakeSocket(BOB), { callId }), h.manager.join(fakeSocket(CAROL), { callId })]);
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);
        assert.equal(h.manager.getActiveCallFor(CAROL), null);
    });

    test('a block made during the call removes the blocked person, and others stay', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        await joined(h, callId, BOB, CAROL);
        await h.manager.userBlocked(ALICE, BOB);
        assert.equal(h.toRoom(`user_${BOB}`, 'call_hangup')[0].data.reason, 'removed');
        assert.deepEqual(ids(h.toRoom(alice.id, 'call_participants').at(-1)), [ALICE, CAROL]);
    });

    test('a block between people who aren\'t in the same room changes nothing', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        await joined(h, callId, BOB);
        await h.manager.userBlocked(CAROL, ALICE);
        assert.equal(h.manager.getActiveCallFor(ALICE).callId, callId);
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);
    });
});

describe('phase 16: per-pair signaling', () => {
    async function threeInCall() {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob, carol] = await joined(h, callId, BOB, CAROL);
        return { h, alice, bob, carol, callId };
    }

    test('offer, answer and ICE reach only the addressed participant, marked with the sender', async () => {
        const { h, alice, bob, carol, callId } = await threeInCall();
        await h.manager.offer(carol, { callId, to: ALICE, sdp: OFFER });
        await h.manager.answer(alice, { callId, to: CAROL, sdp: ANSWER });
        await h.manager.iceCandidate(carol, { callId, to: BOB, candidate: CANDIDATE });

        assert.deepEqual(relayed(h, alice.id, 'call_offer'), [{ callId, from: CAROL, sdp: OFFER, iceRestart: false }]);
        assert.deepEqual(relayed(h, carol.id, 'call_answer'), [{ callId, from: ALICE, sdp: ANSWER, iceRestart: false }]);
        assert.equal(relayed(h, bob.id, 'call_ice_candidate')[0].from, CAROL);
        assert.equal(relayed(h, bob.id, 'call_offer').length, 0);
        assert.equal(relayed(h, alice.id, 'call_ice_candidate').length, 0);
    });

    test('a restart offer stays a restart offer', async () => {
        const { h, alice, carol, callId } = await threeInCall();
        await h.manager.offer(carol, { callId, to: ALICE, sdp: OFFER, iceRestart: true });
        assert.equal(relayed(h, alice.id, 'call_offer')[0].iceRestart, true);
    });

    test('nothing crosses the room boundary: not to outsiders, not from outsiders, not to yourself', async () => {
        const { h, alice, carol, callId } = await threeInCall();
        const outsider = fakeSocket(DAVE);
        await h.manager.offer(outsider, { callId, to: ALICE, sdp: OFFER });
        assert.equal(outsider.last('call_error').data.code, 'NOT_FOUND');
        assert.equal(relayed(h, alice.id, 'call_offer').length, 0);

        for (const to of [DAVE, OUTSIDER, CAROL, 'x', undefined]) {
            await h.manager.offer(carol, { callId, to, sdp: OFFER });
            assert.equal(carol.last('call_error').data.code, 'NOT_IN_CALL');
        }

        // A participant of one room can't reach into another
        const carolDave = harness();
        carolDave.world.members[OTHER_GROUP] = [DAVE, ERIN];
        const first = await startedCall(carolDave);
        const dave = fakeSocket(DAVE);
        const second = await carolDave.manager.invite(dave, { chatId: OTHER_GROUP, type: 'voice' });
        await carolDave.manager.offer(first.alice, { callId: second, to: DAVE, sdp: OFFER });
        assert.equal(first.alice.last('call_error').data.code, 'NOT_FOUND');
        assert.equal(relayed(carolDave, dave.id, 'call_offer').length, 0);
    });

    test('another tab of a participant can\'t signal for them', async () => {
        const { h, alice, callId } = await threeInCall();
        const tab = fakeSocket(CAROL, 'other');
        await h.manager.offer(tab, { callId, to: ALICE, sdp: OFFER });
        assert.equal(tab.last('call_error').data.code, 'OTHER_DEVICE');
        assert.equal(relayed(h, alice.id, 'call_offer').length, 0);
    });

    test('oversized or malformed payloads are refused or dropped, like 1:1', async () => {
        const { h, alice, carol, callId } = await threeInCall();
        await h.manager.offer(carol, { callId, to: ALICE, sdp: { type: 'offer', sdp: 'x'.repeat(30001) } });
        assert.equal(carol.last('call_error').data.code, 'INVALID');
        await h.manager.offer(carol, { callId, to: ALICE, sdp: { type: 'answer', sdp: 'v=0' } });
        assert.equal(carol.last('call_error').data.code, 'INVALID');
        await h.manager.iceCandidate(carol, { callId, to: ALICE, candidate: { candidate: 'x'.repeat(1001) } });
        assert.equal(relayed(h, alice.id, 'call_offer').length, 0);
        assert.equal(relayed(h, alice.id, 'call_ice_candidate').length, 0);
    });

    test('one sender\'s events stay in order even when the membership check takes turns', async () => {
        const { h, alice, carol, callId } = await threeInCall();
        await Promise.all([
            h.manager.offer(carol, { callId, to: ALICE, sdp: OFFER }),
            h.manager.iceCandidate(carol, { callId, to: ALICE, candidate: CANDIDATE }),
            h.manager.iceCandidate(carol, { callId, to: ALICE, candidate: null })
        ]);
        assert.deepEqual(h.toRoom(alice.id).filter(e => /offer|ice/.test(e.event)).map(e => e.event), ['call_offer', 'call_ice_candidate', 'call_ice_candidate']);
    });

    test('mute and camera reach the others through the participant list', async () => {
        const { h, alice, bob, callId } = await threeInCall();
        await h.manager.mediaState(bob, { callId, muted: true, cameraOff: true, screen: 'yes' });
        const list = h.toRoom(alice.id, 'call_participants').at(-1).data.participants;
        const entry = list.find(person => person.id === BOB);
        assert.equal(entry.muted, true);
        assert.equal(entry.cameraOff, true);
        assert.equal(entry.screen, false, 'only a real true counts');
    });

    test('each viewer gets their own card for a person (privacy of the photo)', async () => {
        const { h, alice, callId } = await threeInCall();
        const list = h.toRoom(alice.id, 'call_participants').at(-1).data.participants;
        assert.equal(list.find(person => person.id === ALICE).avatarUrl, 'me.png');
        assert.equal(list.find(person => person.id === BOB).avatarUrl, null);
        const view = await h.manager.activeCallForChat(GROUP, BOB);
        assert.equal(view.callId, callId);
        assert.equal(view.participants.find(person => person.id === BOB).avatarUrl, 'me.png');
    });
});

describe('phase 16: reconnecting', () => {
    test('a dropped socket keeps its place during the grace period and comes back with call_sync', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        await h.manager.disconnect(bob);
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);

        const back = fakeSocket(BOB, 'sB-new');
        await h.manager.sync(back, { callId });
        assert.equal(back.last('call_sync').data.active, true);
        assert.equal(h.toRoom(alice.id, 'call_peer_reconnected')[0].data.from, BOB);
        assert.equal([...h.timers.pending.values()].filter(timer => timer.ms === 15000).length, 0, 'the grace timer was cancelled');
        await h.timers.fire(15000);
        assert.equal(h.manager.getActiveCallFor(BOB).callId, callId);

        await h.manager.offer(back, { callId, to: ALICE, sdp: OFFER });
        assert.equal(relayed(h, alice.id, 'call_offer').length, 1);
    });

    test('after the grace period they are out; the call goes on for the others', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        await h.manager.disconnect(bob);
        await h.timers.fire(15000);
        assert.equal(h.manager.getActiveCallFor(BOB), null);
        assert.equal(h.toRoom(`user_${BOB}`, 'call_hangup')[0].data.reason, 'connection_lost');
        assert.deepEqual(ids(h.toRoom(alice.id, 'call_participants').at(-1)), [ALICE]);
        assert.equal(h.manager.isLive(callId), true);
    });

    test('call_sync from a tab that isn\'t in the call says so', async () => {
        const h = harness();
        const { callId } = await startedCall(h);
        await joined(h, callId, BOB);
        const tab = fakeSocket(BOB, 'other');
        await h.manager.sync(tab, { callId });
        assert.equal(tab.last('call_sync').data.otherDevice, true);
        const carol = fakeSocket(CAROL);
        await h.manager.sync(carol, { callId });
        assert.equal(carol.last('call_sync').data.active, false);
    });

    test('if everyone drops, the last grace period ends the call', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        await h.manager.disconnect(alice);
        await h.manager.disconnect(bob);
        await h.timers.fire(15000);
        assert.equal(h.manager.isLive(callId), false);
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'completed', reason: 'hangup' }]);
    });
});

describe('phase 16: ending, history and notices', () => {
    test('the call ends when the last person leaves, not before', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob, carol] = await joined(h, callId, BOB, CAROL);
        h.advance(750 * 1000);
        await h.manager.leave(alice, { callId });
        await h.manager.leave(bob, { callId });
        assert.equal(h.manager.isLive(callId), true, 'the one who started it leaving doesn\'t end it');
        assert.equal(h.db.ended.length, 0);

        await h.manager.leave(carol, { callId });
        assert.equal(h.manager.isLive(callId), false);
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'completed', reason: 'hangup' }]);
        assert.equal(h.db.notices.at(-1).code, 'call:group:video:completed:750:3:1,2,3');
        assert.equal(h.toRoom(`chat_${GROUP}`, 'call_room_update').at(-1).data.active, false);
        assert.deepEqual(h.db.leaves.map(l => l.userId), [ALICE, BOB, CAROL]);
        assert.equal(h.manager.getActiveCallFor(CAROL), null);
    });

    test('those who never joined get a missed-call push, unless they dismissed it; ringing stops', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        await h.manager.reject(fakeSocket(CAROL), { callId });
        await h.manager.leave(bob, { callId });
        await h.manager.leave(alice, { callId });
        assert.deepEqual(h.pushes.filter(p => p.kind === 'missed').map(p => p.to), [DAVE, ERIN]);
        assert.equal(h.toRoom(`user_${DAVE}`, 'call_cancel')[0].data.reason, 'cancelled');
        assert.equal(h.toRoom(`user_${CAROL}`, 'call_log_updated').length, 1);
    });

    test('nobody came: a missed call with no duration', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        h.advance(20000);
        await h.manager.leave(alice, { callId });
        assert.deepEqual(h.db.ended, [{ id: callId, status: 'missed', reason: 'timeout' }]);
        assert.equal(h.db.notices.at(-1).code, 'call:group:video:missed:0:1:1');
        assert.deepEqual(h.db.answered, []);
    });

    test('a new call can start in the chat once the last one ended', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        await h.manager.leave(alice, { callId });
        const next = await h.manager.invite(alice, { chatId: GROUP, type: 'voice' });
        assert.notEqual(next, callId);
        assert.equal(h.manager.isLive(next), true);
        assert.equal((await h.manager.activeCallForChat(GROUP, ALICE)).type, 'voice');
    });

    test('call_hangup and a closing tab both count as leaving', async () => {
        const h = harness();
        const { alice, callId } = await startedCall(h);
        const [bob] = await joined(h, callId, BOB);
        await h.manager.hangup(bob, { callId, reason: 'hangup' });
        assert.equal(h.manager.getActiveCallFor(BOB), null);
        await h.manager.hangup(alice, { callId });
        assert.equal(h.manager.isLive(callId), false);
    });
});

// ===== SQL on both drivers =====

for (const dbType of ['mysql', 'postgresql']) {
    describe(`phase 16: group call SQL (${dbType})`, () => {
        const pg = dbType === 'postgresql';

        function load(handler) {
            const calls = [];
            const { load: loadModule } = setupFakeDb(dbType, (sql, params) => {
                calls.push({ sql: sql.replace(/\$\d+/g, '?'), params });
                return handler(sql.replace(/\$\d+/g, '?'), params);
            });
            return { calls, group: loadModule('utils/groupCalls.js').groupStore };
        }

        test('only a group chat this user belongs to can have a call', async () => {
            const rows = [{ chat_type: 'group', chat_name: 'Friends', user_id: 1 }, { chat_type: 'group', chat_name: 'Friends', user_id: 2 }];
            const { group } = load(() => rows);
            assert.deepEqual(await group.getGroupForCall(GROUP, 2), { name: 'Friends', memberIds: [1, 2] });
            assert.equal(await group.getGroupForCall(GROUP, 3), null);
            const direct = load(() => [{ chat_type: 'direct', chat_name: null, user_id: 1 }]);
            assert.equal(await direct.group.getGroupForCall(DIRECT_AB, 1), null);
        });

        test('a first join inserts, a rejoin clears left_at, and a person is never counted twice', async () => {
            const first = load((sql) => (/^SELECT/.test(sql) ? [] : (pg ? [{ id: 1 }] : { insertId: 1 })));
            await first.group.recordJoin(5, 2);
            assert.ok(first.calls.some(c => /^INSERT INTO call_participants/.test(c.sql)));

            const rejoin = load((sql) => (/^SELECT/.test(sql) ? [{ id: 8 }] : (pg ? [] : { affectedRows: 1 })));
            await rejoin.group.recordJoin(5, 2);
            assert.ok(rejoin.calls.some(c => /^UPDATE call_participants SET left_at = NULL WHERE id = \?/.test(c.sql)));
            assert.ok(!rejoin.calls.some(c => /^INSERT/.test(c.sql)));
        });

        test('leaving stamps left_at for that person in that call', async () => {
            const { calls, group } = load(() => (pg ? [] : { affectedRows: 1 }));
            await group.recordLeave(5, 2);
            assert.deepEqual(calls[0].params, [5, 2]);
        });
    });
}

describe('phase 16: schema and migrations', () => {
    const database = path.join(__dirname, '..', '..', 'database');
    const read = (file) => fs.readFileSync(path.join(database, file), 'utf8');

    test('both engines have a migration and both fresh schemas match it', () => {
        assert.match(read('add_group_calls.sql'), /ALTER TABLE calls MODIFY callee_id INT NULL/);
        assert.match(read('add_group_calls_postgresql.sql'), /ALTER TABLE calls ALTER COLUMN callee_id DROP NOT NULL/);
        for (const file of ['add_group_calls.sql', 'add_group_calls_postgresql.sql', 'schema.sql', 'schema_postgresql.sql']) {
            assert.match(read(file), /CREATE TABLE (IF NOT EXISTS )?call_participants/, file);
            assert.match(read(file), /UNIQUE (KEY \w+ )?\(call_id, user_id\)/, file);
        }
        assert.ok(!/callee_id INT NOT NULL/.test(read('schema.sql')));
        assert.ok(!/callee_id INTEGER NOT NULL/.test(read('schema_postgresql.sql')));
    });
});

// ===== REST =====

describe('phase 16: /api/calls routes', () => {
    function routes(handler) {
        const { load } = setupFakeDb('mysql', handler);
        return load('routes/calls.js');
    }

    function handlers(router, route) {
        const layer = router.stack.find(l => l.route && l.route.path === route);
        return layer.route.stack.map(s => s.handle);
    }

    async function run(stack, req) {
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
            set(name, value) { this.headers[name] = value; return this; }
        };
        for (const handler of stack) {
            let next = false;
            await handler(req, res, () => { next = true; });
            if (!next) break;
        }
        return res;
    }

    test('GET /active: non-members get 403 and bad ids 400, whatever is running', async () => {
        const router = routes(() => []);
        const io = { callManager: { activeCallForChat: async () => ({ callId: 1 }) } };
        const refused = await run(handlers(router, '/active'), { query: { chatId: '20' }, user: { id: OUTSIDER }, headers: {}, io });
        assert.equal(refused.statusCode, 403);
        const invalid = await run(handlers(router, '/active'), { query: { chatId: 'x' }, user: { id: ALICE }, headers: {}, io });
        assert.equal(invalid.statusCode, 400);
    });

    test('GET /active: a member gets the running call, or null', async () => {
        const router = routes(() => [{ id: 1 }]);
        const seen = [];
        const io = { callManager: { activeCallForChat: async (chatId, viewerId) => { seen.push([chatId, viewerId]); return { callId: 3 }; } } };
        const res = await run(handlers(router, '/active'), { query: { chatId: '20' }, user: { id: BOB }, headers: {}, io });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data.callId, 3);
        assert.deepEqual(seen, [[20, BOB]]);
        assert.equal(res.headers['Cache-Control'], 'no-store');
        const none = await run(handlers(router, '/active'), { query: { chatId: '20' }, user: { id: BOB }, headers: {}, io: null });
        assert.equal(none.body.data, null);
    });

    test('GET /: group calls come with the group, who joined, and whether they can be rejoined', async () => {
        const seen = [];
        const router = routes((sql, params) => {
            seen.push({ sql, params });
            if (/FROM calls c JOIN users u/.test(sql)) {
                return [
                    { id: 7, chat_id: GROUP, caller_id: ALICE, callee_id: null, call_type: 'video', status: 'active', started_at: new Date('2026-10-30T10:00:00Z'), answered_at: new Date('2026-10-30T10:00:05Z'), ended_at: null, other_id: ALICE, other_username: 'alice', other_full_name: null, other_avatar_url: null },
                    { id: 6, chat_id: GROUP, caller_id: BOB, callee_id: null, call_type: 'voice', status: 'completed', started_at: new Date('2026-10-30T09:00:00Z'), answered_at: new Date('2026-10-30T09:00:00Z'), ended_at: new Date('2026-10-30T09:12:30Z'), other_id: BOB, other_username: 'bob', other_full_name: null, other_avatar_url: null }
                ];
            }
            if (/FROM chats WHERE id IN/.test(sql)) return [{ id: GROUP, chat_name: 'Friends', avatar_url: null }];
            if (/FROM call_participants/.test(sql)) return [{ call_id: 7, user_id: ALICE }, { call_id: 7, user_id: CAROL }, { call_id: 6, user_id: BOB }, { call_id: 6, user_id: DAVE }, { call_id: 6, user_id: ERIN }];
            return [];
        });
        const io = { callManager: { isLive: (id) => id === 7 } };
        const res = await run(handlers(router, '/'), { query: {}, user: { id: CAROL }, headers: {}, io });
        assert.equal(res.statusCode, 200);
        const [live, past] = res.body.data;
        assert.equal(live.group, true);
        assert.equal(live.groupName, 'Friends');
        assert.equal(live.live, true);
        assert.equal(live.joined, true);
        assert.equal(past.live, false);
        assert.equal(past.joined, false);
        assert.equal(past.participantCount, 3);
        assert.equal(past.durationSeconds, 750);
        const list = seen.find(call => /FROM calls c JOIN users u/.test(call.sql)).sql;
        assert.match(list, /c\.callee_id IS NULL/, 'group calls of any chat the user is in');
        assert.match(list, /c\.chat_id IN \(SELECT gm\.chat_id FROM group_members gm WHERE gm\.user_id = \?\)/);
    });
});

// ===== Frontend =====

describe('phase 16: frontend', () => {
    const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
    const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

    function notices(userId = ALICE) {
        const sandbox = {
            console: { log() {}, error() {}, warn() {} },
            setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, URLSearchParams,
            window: { isSecureContext: true, addEventListener() {} },
            navigator: { userAgent: '', mediaDevices: {} },
            CONFIG: { ENDPOINTS: {} },
            document: { getElementById: () => null, querySelector: () => null },
            getCurrentUser: () => ({ userId })
        };
        vm.createContext(sandbox);
        runFrontendScript(read('js/calls.js'), sandbox);
        return sandbox.FriChat;
    }

    const message = (content, senderId = ALICE, extra = {}) => ({ content, sender_id: senderId, full_name: '<b>Alice</b>', username: 'alice', ...extra });

    test('notices read per viewer', () => {
        const ended = message('call:group:video:completed:750:3:1,2,3');
        assert.equal(notices(BOB).describeCallNotice(ended), 'Call ended, 12:30, 3 participants');
        assert.equal(notices(DAVE).describeCallNotice(ended), 'Missed group call');
        assert.equal(notices(DAVE).isMissedCallNotice(ended), true);
        assert.equal(notices(BOB).isMissedCallNotice(ended), false);

        const started = message('call:group:video:started');
        assert.equal(notices(BOB).describeCallNotice(started), '<b>Alice</b> started a video call', 'plain text: the caller escapes it');
        assert.equal(notices(ALICE).describeCallNotice(started), 'You started a video call');
        assert.equal(notices(BOB).isMissedCallNotice(started), false);

        const nobody = message('call:group:voice:missed:0:1:1');
        assert.equal(notices(ALICE).describeCallNotice(nobody), 'No one joined your call');
        assert.equal(notices(BOB).describeCallNotice(nobody), 'Missed group call');
    });

    test('notices count as call notices and old ones still parse', () => {
        const friChat = notices(BOB);
        assert.equal(friChat.isCallNotice(message('call:group:voice:started')), true);
        assert.equal(friChat.isCallNotice(message('call:video:missed:0')), true);
        assert.equal(friChat.isCallNotice(message('call:group:bad')), false);
        assert.equal(friChat.describeCallNotice(message('call:video:completed:252', BOB)), 'Video call, 4:12');
    });

    test('the page has the screen, ring, banner and buttons, and the script after calls.js', () => {
        const html = read('chat.html');
        for (const id of ['groupCallScreen', 'groupCallGrid', 'groupCallMuteBtn', 'groupCallCameraBtn', 'groupCallScreenBtn', 'groupCallLeaveBtn', 'groupCallCount', 'groupCallStatus', 'groupRingModal', 'groupRingJoinBtn', 'groupRingDismissBtn', 'groupCallBanner', 'groupCallBannerJoin']) {
            assert.ok(html.includes(`id="${id}"`), id);
        }
        assert.ok(html.indexOf('js/calls.js') < html.indexOf('js/groupCalls.js'));
        assert.ok(html.includes('FriChat.initializeGroupCalls()'));
    });

    test('the service worker cache was bumped and precaches the new script', () => {
        const sw = read('sw.js');
        assert.ok(sw.includes('\'js/groupCalls.js\''));
        const version = Number(/frichat-shell-v(\d+)/.exec(sw)[1]);
        assert.ok(version >= 19);
    });

    test('new socket events reach calls.js; the first-call note has the agreed text', () => {
        const socketCode = read('js/websocket.js');
        assert.ok(socketCode.includes('\'call_participants\''));
        assert.ok(socketCode.includes('\'call_room_update\''));
        assert.ok(read('js/groupCalls.js').includes('Group calls work best with up to 4 people.'));
    });

    test('names in groupCalls.js only go in through textContent', () => {
        const code = read('js/groupCalls.js');
        const inner = [...code.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map(match => match[1].trim());
        assert.deepEqual(inner, ['SVG_MIC_OFF', 'el(source).innerHTML']);
        assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(code));
    });
});
