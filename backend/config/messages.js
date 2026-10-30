/**
 * Message action limits
 * Keep EDIT_WINDOW_MINUTES in step with MESSAGE_EDIT_WINDOW_MINUTES in frontend/js/config.js
 * (the frontend only uses it to decide whether to offer "Edit"; the server enforces it)
 */

module.exports = {
    // How long after sending the sender may still edit a text message
    EDIT_WINDOW_MINUTES: 15,

    // Same limit as new messages (validateMessage)
    MAX_MESSAGE_LENGTH: 5000,

    // Forward: messages per request, and target chats per request
    MAX_FORWARD_MESSAGES: 5,
    MAX_FORWARD_CHATS: 10,

    // Characters of the original shown in a reply's quote block
    REPLY_SNIPPET_LENGTH: 120,

    // Voice notes: longest recording, and how many waveform bars the recorder may send.
    // Keep in step with VOICE_MAX_SECONDS / VOICE_WAVEFORM_BARS in frontend/js/config.js
    VOICE_MAX_SECONDS: 300,
    // Timers in browsers drift a little; this much over the limit is still accepted
    VOICE_DURATION_GRACE_MS: 3000,
    VOICE_WAVEFORM_MAX_BARS: 64,

    // Disappearing messages: the timers a chat can use (0 = off). Keep in step with
    // DISAPPEARING_OPTIONS in frontend/js/config.js
    DISAPPEARING_DURATIONS: [0, 24 * 60 * 60, 7 * 24 * 60 * 60, 90 * 24 * 60 * 60],
    // Expired messages deleted per scheduler tick (the rest go on the next tick)
    EXPIRED_BATCH_SIZE: 200
};
