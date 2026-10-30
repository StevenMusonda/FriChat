/**
 * 1:1 voice and video calls (phase 11)
 * ICE servers come from the environment (see .env.example): STUN_URLS, TURN_URL, TURN_SECRET, TURN_TTL.
 * Keep RING_TIMEOUT_MS in step with CALL_RING_TIMEOUT_MS in frontend/js/config.js (the frontend only
 * uses it for its own safety timer; the server decides when a call times out).
 */

module.exports = {
    CALL_TYPES: ['voice', 'video'],

    // An unanswered call becomes "missed" after this long
    RING_TIMEOUT_MS: 30 * 1000,

    // A participant whose socket dropped mid-call has this long to reconnect (call_sync) before the call ends
    RECONNECT_GRACE_MS: 15 * 1000,

    // Largest relayed signaling payloads (a video offer is usually 4-8 KB)
    MAX_SDP_LENGTH: 30 * 1000,
    MAX_CANDIDATE_LENGTH: 1000,

    // Used when STUN_URLS isn't set
    DEFAULT_STUN_URLS: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],

    // TURN REST-API credentials live this long by default (TURN_TTL overrides, 10 minutes to 1 day)
    DEFAULT_TURN_TTL_SECONDS: 6 * 60 * 60,
    MIN_TURN_TTL_SECONDS: 10 * 60,
    MAX_TURN_TTL_SECONDS: 24 * 60 * 60,

    // Calls tab: rows per page
    HISTORY_PAGE_SIZE: 30,
    HISTORY_MAX_PAGE_SIZE: 100
};
