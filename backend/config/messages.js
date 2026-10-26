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
    REPLY_SNIPPET_LENGTH: 120
};
