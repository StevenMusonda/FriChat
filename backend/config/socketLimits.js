/**
 * Socket.IO rate limits (token buckets).
 *
 * Every limited event belongs to a group. Each group has a bucket per socket and a bucket per user
 * (shared by all of the user's tabs and devices): `capacity` is the burst size, `refillPerSecond`
 * the sustained rate. An event that finds either bucket empty is dropped and answered with
 * `rate_limited`. A socket that keeps hitting the limit (`maxViolations` drops within
 * `violationWindowMs`) is disconnected.
 */

module.exports = {
    groups: {
        message: {
            events: ['send_message'],
            perSocket: { capacity: 10, refillPerSecond: 1 },
            perUser: { capacity: 20, refillPerSecond: 2 }
        },
        typing: {
            events: ['typing'],
            perSocket: { capacity: 6, refillPerSecond: 2 },
            perUser: { capacity: 12, refillPerSecond: 4 },
            silent: true // dropped typing updates aren't worth an error
        },
        reaction: {
            events: ['add_reaction', 'remove_reaction'],
            perSocket: { capacity: 10, refillPerSecond: 2 },
            perUser: { capacity: 20, refillPerSecond: 3 }
        },
        poll: {
            events: ['poll_vote'],
            perSocket: { capacity: 10, refillPerSecond: 2 },
            perUser: { capacity: 20, refillPerSecond: 3 }
        },
        receipt: {
            events: ['message_status'],
            perSocket: { capacity: 30, refillPerSecond: 5 },
            perUser: { capacity: 60, refillPerSecond: 10 },
            silent: true
        },
        join: {
            events: ['join_chat', 'authenticate'],
            perSocket: { capacity: 20, refillPerSecond: 2 },
            perUser: { capacity: 40, refillPerSecond: 4 }
        }
    },
    abuse: {
        maxViolations: 30,
        violationWindowMs: 60 * 1000
    }
};
