/**
 * Group limits and the invite-link switch
 */

const GROUP_NAME_MAX_LENGTH = 100;
const GROUP_DESCRIPTION_MAX_LENGTH = 500;
const MEMBER_TAG_MAX_LENGTH = 30;

// Invite links
const INVITE_EXPIRY_OPTIONS = ['1h', '1d', '7d', 'never'];
const INVITE_MAX_USES_LIMIT = 1000;

// Group avatars: stored under uploads/group-avatars, resized to a square when sharp is installed
const GROUP_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const GROUP_AVATAR_SIZE_PX = 256;

function groupAvatarMaxBytes() {
    return parseInt(process.env.GROUP_AVATAR_MAX_BYTES) || 2 * 1024 * 1024;
}

/**
 * ENABLE_INVITE_LINKS (default true). Read on every call so it can change without a code edit.
 */
function inviteLinksEnabled() {
    const value = process.env.ENABLE_INVITE_LINKS;
    return value === undefined || value === '' || String(value).trim().toLowerCase() !== 'false';
}

module.exports = {
    GROUP_NAME_MAX_LENGTH,
    GROUP_DESCRIPTION_MAX_LENGTH,
    MEMBER_TAG_MAX_LENGTH,
    INVITE_EXPIRY_OPTIONS,
    INVITE_MAX_USES_LIMIT,
    GROUP_AVATAR_TYPES,
    GROUP_AVATAR_SIZE_PX,
    groupAvatarMaxBytes,
    inviteLinksEnabled
};
