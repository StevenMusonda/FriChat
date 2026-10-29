/**
 * Privacy settings, enforced on the server.
 *
 * Each user picks an audience ('everyone' | 'contacts' | 'nobody') for their online status and last
 * seen, their profile photo, their bio (which also covers the custom status) and for who may add them
 * to groups, plus on/off switches for read receipts and typing indicators. "Contacts" are the people
 * you share a chat with, not counting direct chats that are still a message request.
 *
 * Every API response that carries another user's avatar, presence, bio or custom status goes through
 * applyUserPrivacy() for the viewer asking, so a hidden field is never sent (it comes back as null).
 * Socket broadcasts of presence, typing and read receipts use the room helpers below instead of
 * broadcasting to everyone. Someone who blocked the viewer is treated as "nobody" for that viewer.
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const { AUDIENCES } = require('../config/profile');
const { secondsUntilSql, isoFromSecondsUntil } = require('./timeSql');
const { getBlockerIds, getBlockRelations } = require('./blocks');

const DEFAULT_SETTINGS = Object.freeze({
    lastSeen: 'everyone',
    photo: 'everyone',
    bio: 'everyone',
    groups: 'everyone',
    readReceipts: true,
    typingIndicators: true
});

// API field -> privacy_settings column
const AUDIENCE_COLUMNS = {
    lastSeen: 'last_seen_audience',
    photo: 'photo_audience',
    bio: 'bio_audience',
    groups: 'groups_audience'
};
const SWITCH_COLUMNS = {
    readReceipts: 'read_receipts',
    typingIndicators: 'typing_indicators'
};

// The only avatar paths ever handed to clients: files the server wrote itself (utils/avatars.js)
const USER_AVATAR_PATTERN = /^uploads\/avatars\/[a-f0-9]{32}\.webp$/;

const GROUP_ADD_REFUSED = {
    status: 403,
    code: 'PRIVACY_GROUP_ADD',
    message: 'One or more of these people don\'t allow you to add them to groups.'
};

// MySQL returns 0/1 (sometimes as strings), PostgreSQL true/false
function toBool(value) {
    return value === true || value === 1 || value === '1';
}

function isAudience(value) {
    return AUDIENCES.includes(value);
}

function safeAvatarUrl(value) {
    return typeof value === 'string' && USER_AVATAR_PATTERN.test(value) ? value : null;
}

/**
 * privacy_settings row (or the matching columns of a joined row) -> settings; missing = defaults
 */
function shapeSettings(row) {
    const settings = { ...DEFAULT_SETTINGS };
    if (!row) return settings;
    for (const [field, column] of Object.entries(AUDIENCE_COLUMNS)) {
        if (isAudience(row[column])) settings[field] = row[column];
    }
    for (const [field, column] of Object.entries(SWITCH_COLUMNS)) {
        if (row[column] !== null && row[column] !== undefined) settings[field] = toBool(row[column]);
    }
    return settings;
}

async function getPrivacySettings(userId) {
    const row = await queryOne(
        'SELECT last_seen_audience, photo_audience, bio_audience, groups_audience, read_receipts, typing_indicators FROM privacy_settings WHERE user_id = ?',
        [userId]
    );
    return shapeSettings(row);
}

/**
 * Merge changes ({ lastSeen, photo, bio, groups, readReceipts, typingIndicators }, all optional)
 * into the stored settings. Callers validate the values first.
 * @returns {Promise<{ previous: object, settings: object }>}
 */
async function savePrivacySettings(userId, changes) {
    const previous = await getPrivacySettings(userId);
    const settings = { ...previous };
    for (const field of Object.keys(AUDIENCE_COLUMNS)) {
        if (isAudience(changes[field])) settings[field] = changes[field];
    }
    for (const field of Object.keys(SWITCH_COLUMNS)) {
        if (typeof changes[field] === 'boolean') settings[field] = changes[field];
    }

    const values = [
        userId, settings.lastSeen, settings.photo, settings.bio, settings.groups,
        settings.readReceipts, settings.typingIndicators
    ];
    const insert = `INSERT INTO privacy_settings
        (user_id, last_seen_audience, photo_audience, bio_audience, groups_audience, read_receipts, typing_indicators)
        VALUES (?, ?, ?, ?, ?, ?, ?)`;
    if (dbType === 'postgresql') {
        await executeQuery(`${insert} ON CONFLICT (user_id) DO UPDATE SET
            last_seen_audience = EXCLUDED.last_seen_audience, photo_audience = EXCLUDED.photo_audience,
            bio_audience = EXCLUDED.bio_audience, groups_audience = EXCLUDED.groups_audience,
            read_receipts = EXCLUDED.read_receipts, typing_indicators = EXCLUDED.typing_indicators,
            updated_at = CURRENT_TIMESTAMP`, values);
    } else {
        await executeQuery(`${insert} ON DUPLICATE KEY UPDATE
            last_seen_audience = VALUES(last_seen_audience), photo_audience = VALUES(photo_audience),
            bio_audience = VALUES(bio_audience), groups_audience = VALUES(groups_audience),
            read_receipts = VALUES(read_receipts), typing_indicators = VALUES(typing_indicators)`, values);
    }
    return { previous, settings };
}

// ===== Contacts =====

// Chats the two share, ignoring direct chats that are a message request not (yet) accepted
const SHARED_CHAT_JOINS = `
    FROM group_members mine
    JOIN group_members other ON other.chat_id = mine.chat_id AND other.user_id <> mine.user_id
    LEFT JOIN message_requests mr ON mr.chat_id = mine.chat_id AND mr.status <> 'accepted'`;

/**
 * Everyone userId shares an accepted chat with
 * @returns {Promise<Set<number>>}
 */
async function getContactIds(userId) {
    const rows = await executeQuery(`
        SELECT DISTINCT other.user_id
        ${SHARED_CHAT_JOINS}
        WHERE mine.user_id = ? AND mr.chat_id IS NULL
    `, [userId]);
    return new Set(rows.map(row => Number(row.user_id)));
}

async function isContact(userId, otherUserId) {
    if (Number(userId) === Number(otherUserId)) return true;
    const row = await queryOne(`
        SELECT mine.chat_id
        ${SHARED_CHAT_JOINS}
        WHERE mine.user_id = ? AND other.user_id = ? AND mr.chat_id IS NULL
        LIMIT 1
    `, [userId, otherUserId]);
    return !!row;
}

// ===== Filtering user data for a viewer =====

/**
 * The privacy-relevant columns and settings of these users, by id
 */
async function loadProfiles(userIds) {
    const ids = [...new Set(userIds.map(Number))].filter(id => Number.isInteger(id) && id > 0);
    const profiles = new Map();
    if (ids.length === 0) return profiles;

    const rows = await executeQuery(`
        SELECT u.id, u.status, u.last_seen, u.avatar_url, u.bio,
            u.custom_status_text, u.custom_status_emoji,
            ${secondsUntilSql('u.custom_status_expires_at')} AS status_expires_in,
            ps.last_seen_audience, ps.photo_audience, ps.bio_audience, ps.groups_audience,
            ps.read_receipts, ps.typing_indicators
        FROM users u
        LEFT JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE u.id IN (${ids.map(() => '?').join(', ')})
    `, ids);
    for (const row of rows) profiles.set(Number(row.id), row);
    return profiles;
}

/**
 * { text, emoji, expiresAt } while the custom status is set and not expired, else null
 */
function customStatusOf(row, now = Date.now()) {
    if (!row || (!row.custom_status_text && !row.custom_status_emoji)) return null;
    const expiresIn = row.status_expires_in;
    const hasExpiry = expiresIn !== null && expiresIn !== undefined && expiresIn !== '';
    if (hasExpiry && Number(expiresIn) <= 0) return null;
    return {
        text: row.custom_status_text || null,
        emoji: row.custom_status_emoji || null,
        expiresAt: hasExpiry ? isoFromSecondsUntil(expiresIn, now) : null
    };
}

/**
 * May a viewer with this relationship see something shared with `audience`?
 */
function audienceAllows(audience, { self = false, contact = false, blockedViewer = false } = {}) {
    if (self) return true;
    if (blockedViewer) return false;
    if (audience === 'everyone') return true;
    if (audience === 'contacts') return contact;
    return false;
}

/**
 * Everything needed to filter these subjects for this viewer (contacts are only looked up when a
 * subject actually uses the 'contacts' audience)
 */
async function buildView(viewerId, subjectIds) {
    const profiles = await loadProfiles(subjectIds);
    const needsContacts = [...profiles.values()].some(row => {
        const settings = shapeSettings(row);
        return Number(row.id) !== Number(viewerId)
            && [settings.lastSeen, settings.photo, settings.bio].includes('contacts');
    });
    return {
        viewerId: Number(viewerId),
        profiles,
        contacts: needsContacts ? await getContactIds(viewerId) : new Set(),
        blockers: await getBlockerIds(viewerId)
    };
}

/**
 * What this viewer may see of one user. `fallback` supplies values when the user has no profile row.
 */
function visibleFields(view, subjectId, fallback = {}) {
    const id = Number(subjectId);
    // Fail closed: a row we can't tie to a user shows nothing
    if (!Number.isInteger(id) || id < 1) {
        return { avatarUrl: null, status: null, lastSeen: null, bio: null, customStatus: null };
    }
    const row = view.profiles.get(id);
    const settings = shapeSettings(row);
    const relation = {
        self: id === view.viewerId,
        contact: view.contacts.has(id),
        blockedViewer: view.blockers.has(id)
    };
    const source = row || fallback;
    const canSeePresence = audienceAllows(settings.lastSeen, relation);
    const canSeePhoto = audienceAllows(settings.photo, relation);
    const canSeeBio = audienceAllows(settings.bio, relation);

    return {
        avatarUrl: canSeePhoto ? safeAvatarUrl(source.avatar_url !== undefined ? source.avatar_url : source.avatarUrl) : null,
        status: canSeePresence ? (source.status || null) : null,
        lastSeen: canSeePresence ? (source.last_seen || null) : null,
        bio: canSeeBio ? (source.bio || null) : null,
        customStatus: canSeeBio ? customStatusOf(row) : null
    };
}

/**
 * Filter user rows in place for the viewer. `keys` names each row's fields; a key set to null is
 * left alone, a key that's given is always written (null when hidden).
 *   id (default 'id'), avatar ('avatar_url'), status ('status'), lastSeen (null), bio (null),
 *   customStatus ('custom_status')
 */
async function applyUserPrivacy(viewerId, rows, keys = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const {
        id = 'id',
        avatar = 'avatar_url',
        status = 'status',
        lastSeen = null,
        bio = null,
        customStatus = 'custom_status'
    } = keys;

    const view = await buildView(viewerId, rows.map(row => row[id]));
    for (const row of rows) {
        const visible = visibleFields(view, row[id], {
            avatar_url: avatar ? row[avatar] : null,
            status: status ? row[status] : null,
            last_seen: lastSeen ? row[lastSeen] : null
        });
        if (avatar) row[avatar] = visible.avatarUrl;
        if (status) row[status] = visible.status;
        if (lastSeen) row[lastSeen] = visible.lastSeen;
        if (bio) row[bio] = visible.bio;
        if (customStatus) row[customStatus] = visible.customStatus;
    }
    return rows;
}

/**
 * One user's profile card as the viewer may see it, or null if the user doesn't exist
 */
async function getVisibleProfile(viewerId, userId) {
    const user = await queryOne('SELECT id, username, full_name FROM users WHERE id = ?', [userId]);
    if (!user) return null;
    const view = await buildView(viewerId, [user.id]);
    const visible = visibleFields(view, user.id);
    return {
        id: Number(user.id),
        username: user.username,
        fullName: user.full_name || null,
        avatarUrl: visible.avatarUrl,
        bio: visible.bio,
        customStatus: visible.customStatus,
        status: visible.status,
        lastSeen: visible.lastSeen
    };
}

// ===== Live updates =====

/**
 * Where a presence change of userId may go:
 *   { broadcast: true, except: rooms } - every connected user except these
 *   { broadcast: false, rooms }        - only these user rooms
 */
async function presenceTargets(userId) {
    const settings = await getPrivacySettings(userId);
    const { blocked } = await getBlockRelations(userId);
    const hidden = new Set(blocked.map(Number));

    if (settings.lastSeen === 'everyone') {
        return { broadcast: true, except: [...hidden].map(id => `user_${id}`) };
    }
    if (settings.lastSeen === 'contacts') {
        const contacts = await getContactIds(userId);
        return { broadcast: false, rooms: [...contacts].filter(id => !hidden.has(id)).map(id => `user_${id}`) };
    }
    return { broadcast: false, rooms: [] };
}

/**
 * Emit user_status for userId to exactly the people allowed to see it. `from` is the user's socket
 * for broadcasts (so the sending tab doesn't get its own event), or io.
 */
async function emitPresence(io, userId, status, from = io) {
    if (!io) return;
    const targets = await presenceTargets(userId);
    const payload = { userId: Number(userId), status };
    if (targets.broadcast) {
        const base = from && from.broadcast ? from.broadcast : io;
        (targets.except.length > 0 ? base.except(targets.except) : base).emit('user_status', payload);
    } else if (targets.rooms.length > 0) {
        io.to(targets.rooms).emit('user_status', payload);
    }
}

/**
 * Tell contacts about a profile change (name, photo, custom status, presence), filtered the way a
 * contact may see it; the user's own tabs get the full profile. Non-contacts see the change the
 * next time they load the user.
 */
async function emitProfileUpdate(io, userId) {
    if (!io) return;
    const user = await queryOne('SELECT id, username, full_name FROM users WHERE id = ?', [userId]);
    if (!user) return;

    const own = await getVisibleProfile(userId, userId);
    io.to(`user_${userId}`).emit('user_profile_updated', own);

    const contacts = await getContactIds(userId);
    const { blocked } = await getBlockRelations(userId);
    const hidden = new Set(blocked.map(Number));
    const rooms = [...contacts].filter(id => !hidden.has(id)).map(id => `user_${id}`);
    if (rooms.length === 0) return;

    // A contact's view: 'everyone' and 'contacts' show, 'nobody' hides
    const view = { viewerId: 0, profiles: await loadProfiles([userId]), contacts: new Set([Number(userId)]), blockers: new Set() };
    const visible = visibleFields(view, userId);
    io.to(rooms).emit('user_profile_updated', {
        id: Number(user.id),
        username: user.username,
        fullName: user.full_name || null,
        avatarUrl: visible.avatarUrl,
        customStatus: visible.customStatus,
        status: visible.status
    });
}

// ===== Read receipts and typing =====

async function readReceiptsEnabled(userId) {
    return (await getPrivacySettings(userId)).readReceipts;
}

async function typingIndicatorsEnabled(userId) {
    return (await getPrivacySettings(userId)).typingIndicators;
}

/**
 * Rooms of the chat's members who turned read receipts off: they don't see anyone's reads either
 */
async function receiptlessMemberRooms(chatId) {
    const rows = await executeQuery(`
        SELECT gm.user_id
        FROM group_members gm
        JOIN privacy_settings ps ON ps.user_id = gm.user_id
        WHERE gm.chat_id = ? AND ps.read_receipts = FALSE
    `, [chatId]);
    return rows.map(row => `user_${row.user_id}`);
}

/**
 * For a viewer with read receipts off, other people's "read" shows as "delivered"
 */
function maskReadStatus(rows, receiptsOn, key = 'status') {
    if (receiptsOn || !Array.isArray(rows)) return rows;
    for (const row of rows) {
        if (row && row[key] === 'read') row[key] = 'delivered';
    }
    return rows;
}

// ===== Groups =====

/**
 * Which of userIds don't allow adderId to put them in a group
 * @returns {Promise<number[]>}
 */
async function findGroupAddRefusals(adderId, userIds) {
    const ids = [...new Set(userIds.map(Number))].filter(id => Number.isInteger(id) && id !== Number(adderId));
    if (ids.length === 0) return [];
    const rows = await executeQuery(
        `SELECT user_id, groups_audience FROM privacy_settings WHERE user_id IN (${ids.map(() => '?').join(', ')})`,
        ids
    );
    const audienceOf = new Map(rows.map(row => [Number(row.user_id), row.groups_audience]));

    const refused = [];
    let contacts = null;
    for (const id of ids) {
        const audience = isAudience(audienceOf.get(id)) ? audienceOf.get(id) : 'everyone';
        if (audience === 'everyone') continue;
        if (audience === 'contacts') {
            contacts = contacts || await getContactIds(adderId);
            if (contacts.has(id)) continue;
        }
        refused.push(id);
    }
    return refused;
}

module.exports = {
    DEFAULT_SETTINGS,
    USER_AVATAR_PATTERN,
    GROUP_ADD_REFUSED,
    isAudience,
    safeAvatarUrl,
    shapeSettings,
    getPrivacySettings,
    savePrivacySettings,
    getContactIds,
    isContact,
    customStatusOf,
    audienceAllows,
    applyUserPrivacy,
    getVisibleProfile,
    presenceTargets,
    emitPresence,
    emitProfileUpdate,
    readReceiptsEnabled,
    typingIndicatorsEnabled,
    receiptlessMemberRooms,
    maskReadStatus,
    findGroupAddRefusals
};
