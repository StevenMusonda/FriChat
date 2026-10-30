/**
 * ICE servers for WebRTC calls.
 *
 * STUN: STUN_URLS (comma-separated), or public Google STUN by default.
 * TURN: TURN_URL (comma-separated, e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349")
 * with either
 *   - TURN_SECRET: the coturn REST-API scheme (static-auth-secret / use-auth-secret). The username is
 *     "<expiry unix time>:<user id>" and the password is base64(HMAC-SHA1(secret, username)), so
 *     credentials stop working at the expiry and the secret never leaves the server; or
 *   - TURN_USERNAME + TURN_PASSWORD: fixed credentials from a hosted TURN service.
 */

const crypto = require('crypto');
const {
    DEFAULT_STUN_URLS,
    DEFAULT_TURN_TTL_SECONDS,
    MIN_TURN_TTL_SECONDS,
    MAX_TURN_TTL_SECONDS
} = require('../config/calls');

const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):[^\s,]+$/i;

function parseUrls(value) {
    return String(value || '')
        .split(',')
        .map(url => url.trim())
        .filter(url => ICE_URL_PATTERN.test(url));
}

function turnTtlSeconds(env = process.env) {
    const ttl = parseInt(env.TURN_TTL, 10);
    if (!Number.isInteger(ttl)) return DEFAULT_TURN_TTL_SECONDS;
    return Math.min(MAX_TURN_TTL_SECONDS, Math.max(MIN_TURN_TTL_SECONDS, ttl));
}

/**
 * coturn REST-API credentials for one user
 * @returns {{ username: string, credential: string, expiresAt: number }} expiresAt in unix seconds
 */
function createTurnCredentials(secret, userId, ttlSeconds, nowMs = Date.now()) {
    const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
    const username = `${expiresAt}:${userId}`;
    const credential = crypto.createHmac('sha1', String(secret)).update(username).digest('base64');
    return { username, credential, expiresAt };
}

/**
 * RTCPeerConnection's iceServers for this user
 * @returns {{ iceServers: Array, ttl: number|null, turn: boolean }} ttl: seconds the TURN credentials last
 */
function buildIceServers(userId, { env = process.env, now = Date.now() } = {}) {
    const stunUrls = env.STUN_URLS !== undefined && env.STUN_URLS !== '' ? parseUrls(env.STUN_URLS) : DEFAULT_STUN_URLS;
    const iceServers = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

    const turnUrls = parseUrls(env.TURN_URL);
    if (turnUrls.length === 0) return { iceServers, ttl: null, turn: false };

    if (env.TURN_SECRET) {
        const ttl = turnTtlSeconds(env);
        const { username, credential } = createTurnCredentials(env.TURN_SECRET, userId, ttl, now);
        iceServers.push({ urls: turnUrls, username, credential });
        return { iceServers, ttl, turn: true };
    }
    if (env.TURN_USERNAME && env.TURN_PASSWORD) {
        iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
        return { iceServers, ttl: null, turn: true };
    }

    // TURN_URL without credentials would only produce auth failures in the browser
    console.warn('TURN_URL is set but neither TURN_SECRET nor TURN_USERNAME/TURN_PASSWORD is; TURN is off');
    return { iceServers, ttl: null, turn: false };
}

module.exports = { parseUrls, turnTtlSeconds, createTurnCredentials, buildIceServers };
