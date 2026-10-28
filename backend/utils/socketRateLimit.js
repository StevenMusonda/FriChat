/**
 * Token-bucket rate limiting for Socket.IO events (limits in config/socketLimits.js).
 * In memory, like middleware/rateLimit.js: per server instance.
 */

const defaultConfig = require('../config/socketLimits');

class TokenBucket {
    constructor({ capacity, refillPerSecond }, now = Date.now()) {
        this.capacity = capacity;
        this.refillPerSecond = refillPerSecond;
        this.tokens = capacity;
        this.updatedAt = now;
    }

    refill(now) {
        const elapsed = Math.max(0, now - this.updatedAt) / 1000;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
        this.updatedAt = now;
    }

    /**
     * Take one token. Returns 0 when allowed, otherwise ms until one is available.
     */
    take(now = Date.now()) {
        this.refill(now);
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return 0;
        }
        return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
    }

    isFull(now = Date.now()) {
        this.refill(now);
        return this.tokens >= this.capacity;
    }
}

/**
 * @param {Object} config - same shape as config/socketLimits.js
 * @param {Function} now - clock (tests pass a fake one)
 */
function createSocketRateLimiter(config = defaultConfig, now = () => Date.now()) {
    const groupByEvent = {};
    for (const [name, group] of Object.entries(config.groups)) {
        for (const event of group.events) groupByEvent[event] = { name, ...group };
    }

    const userBuckets = new Map(); // `${userId}:${group}` -> TokenBucket
    const socketState = new WeakMap(); // socket -> { buckets: Map, violations: number[] }

    function stateFor(socket) {
        let state = socketState.get(socket);
        if (!state) {
            state = { buckets: new Map(), violations: [] };
            socketState.set(socket, state);
        }
        return state;
    }

    /**
     * @returns {{ allowed: true } | { allowed: false, retryAfterMs, silent, abusive }}
     */
    function check(socket, event) {
        const group = groupByEvent[event];
        if (!group) return { allowed: true };

        const time = now();
        const state = stateFor(socket);

        let socketBucket = state.buckets.get(group.name);
        if (!socketBucket) {
            socketBucket = new TokenBucket(group.perSocket, time);
            state.buckets.set(group.name, socketBucket);
        }

        const userKey = `${socket.userId}:${group.name}`;
        let userBucket = userBuckets.get(userKey);
        if (!userBucket) {
            userBucket = new TokenBucket(group.perUser, time);
            userBuckets.set(userKey, userBucket);
        }

        // Socket bucket first; if the user bucket then refuses, the socket token is given back
        const socketWait = socketBucket.take(time);
        if (socketWait === 0) {
            const userWait = userBucket.take(time);
            if (userWait === 0) return { allowed: true };
            socketBucket.tokens = Math.min(socketBucket.capacity, socketBucket.tokens + 1);
            return refuse(state, group, userWait, time);
        }
        return refuse(state, group, socketWait, time);
    }

    function refuse(state, group, retryAfterMs, time) {
        const windowStart = time - config.abuse.violationWindowMs;
        state.violations = state.violations.filter(t => t > windowStart);
        state.violations.push(time);
        return {
            allowed: false,
            retryAfterMs,
            silent: !!group.silent,
            abusive: state.violations.length >= config.abuse.maxViolations
        };
    }

    /**
     * Drop per-user buckets that have filled up again (nothing to remember)
     */
    function sweep() {
        const time = now();
        for (const [key, bucket] of userBuckets) {
            if (bucket.isFull(time)) userBuckets.delete(key);
        }
    }

    return { check, sweep, userBuckets };
}

/**
 * Wrap socket.on so limited events go through the limiter first. Throttled events are dropped and
 * answered with `rate_limited` (unless silent); a socket that keeps abusing the limit is disconnected.
 */
function limitSocketEvents(socket, limiter) {
    const on = socket.on.bind(socket);
    return (event, handler) => on(event, (...args) => {
        const result = limiter.check(socket, event);
        if (result.allowed) return handler(...args);

        if (result.abusive) {
            socket.emit('rate_limited', { event, retryAfterMs: result.retryAfterMs, disconnected: true });
            if (typeof socket.disconnect === 'function') socket.disconnect(true);
            return undefined;
        }
        if (!result.silent) {
            socket.emit('rate_limited', { event, retryAfterMs: result.retryAfterMs });
        }
        return undefined;
    });
}

module.exports = { TokenBucket, createSocketRateLimiter, limitSocketEvents };
