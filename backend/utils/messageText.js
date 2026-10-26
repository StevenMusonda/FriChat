/**
 * The one text rule for message content, used by every write path
 * (REST send, socket send_message, edit, forward, and anything added later such as webhooks).
 *
 * Text is stored RAW: control characters stripped, line endings normalized, trimmed and
 * length-limited. It is never HTML-escaped here; clients escape at render time.
 */

const { MAX_MESSAGE_LENGTH } = require('../config/messages');

// C0 controls except tab and newline, DEL, and C1 controls
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Plain-text cleanup without length rules (also used for chat names)
 */
function stripControlChars(value) {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARS, '');
}

/**
 * Clean message text for storage.
 * @param {*} value - whatever the client sent
 * @param {Object} options - { required: true when empty text is an error (text messages, edits) }
 * @returns {{ ok: true, text: string|null } | { ok: false, error: string }}
 *          text is null when the message has no text (only allowed when not required)
 */
function cleanMessageText(value, { required = false } = {}) {
    if (value === undefined || value === null) {
        return required ? { ok: false, error: 'Message cannot be empty' } : { ok: true, text: null };
    }

    if (typeof value !== 'string') {
        return { ok: false, error: 'Message content must be text' };
    }

    const text = stripControlChars(value).trim();

    if (text.length === 0) {
        return required ? { ok: false, error: 'Message cannot be empty' } : { ok: true, text: null };
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
        return { ok: false, error: `Message must be at most ${MAX_MESSAGE_LENGTH} characters` };
    }

    return { ok: true, text };
}

module.exports = {
    cleanMessageText,
    stripControlChars
};
