/**
 * Profile and privacy limits
 */

const DISPLAY_NAME_MAX_LENGTH = 100;
const BIO_MAX_LENGTH = 160;
const STATUS_TEXT_MAX_LENGTH = 80;
const STATUS_EMOJI_MAX_CHARS = 8; // code points; users.custom_status_emoji is VARCHAR(16)

// Custom status "clear after" choices, in seconds ('never' = until the user clears it)
const STATUS_DURATIONS = {
    '30m': 30 * 60,
    '1h': 60 * 60,
    '4h': 4 * 60 * 60,
    '1d': 24 * 60 * 60,
    '1w': 7 * 24 * 60 * 60
};
const STATUS_DURATION_OPTIONS = [...Object.keys(STATUS_DURATIONS), 'never'];

// Who may see / do something: 'contacts' = people you share an accepted chat with
const AUDIENCES = ['everyone', 'contacts', 'nobody'];

// Profile photos: always re-encoded by sharp as a square WebP under uploads/avatars
const PROFILE_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PROFILE_AVATAR_SIZE_PX = 512;

function profileAvatarMaxBytes() {
    return parseInt(process.env.PROFILE_AVATAR_MAX_BYTES) || 5 * 1024 * 1024;
}

module.exports = {
    DISPLAY_NAME_MAX_LENGTH,
    BIO_MAX_LENGTH,
    STATUS_TEXT_MAX_LENGTH,
    STATUS_EMOJI_MAX_CHARS,
    STATUS_DURATIONS,
    STATUS_DURATION_OPTIONS,
    AUDIENCES,
    PROFILE_AVATAR_TYPES,
    PROFILE_AVATAR_SIZE_PX,
    profileAvatarMaxBytes
};
