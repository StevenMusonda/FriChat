/**
 * User Controller
 * Your own profile (display name, bio, photo, custom status) and privacy settings, and other
 * people's profile cards. Every field of another user goes through utils/privacy.js.
 */

const { executeQuery, queryOne } = require('../config/database');
const { sanitizeHtml } = require('../utils/validation');
const privacy = require('../utils/privacy');
const avatars = require('../utils/avatars');
const { STATUS_DURATIONS } = require('../config/profile');
const { plusSecondsSql } = require('../utils/timeSql');
const { getBlockRelations } = require('../utils/blocks');
const birthdays = require('../utils/birthdays');

// Stricter audience = fewer people; a photo whose audience shrinks gets a new file name
const AUDIENCE_RANK = { everyone: 0, contacts: 1, nobody: 2 };

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error);
    res.status(500).json({ success: false, message });
}

/**
 * Privacy settings plus the birthday audience (kept in utils/birthdays.js)
 */
async function fullPrivacySettings(userId) {
    return { ...(await privacy.getPrivacySettings(userId)), birthday: await birthdays.getBirthdayAudience(userId) };
}

/**
 * Your own profile with everything (privacy only applies to other people)
 */
async function ownProfile(userId) {
    const profile = await privacy.getVisibleProfile(userId, userId);
    if (!profile) return null;
    return { ...profile, birthday: await birthdays.getOwnBirthday(userId), privacy: await fullPrivacySettings(userId) };
}

/**
 * GET /api/users/me
 */
async function getMe(req, res) {
    try {
        res.json({ success: true, data: await ownProfile(req.user.id) });
    } catch (error) {
        serverError(res, 'Get own profile', error, 'Failed to load your profile');
    }
}

/**
 * PUT /api/users/me/profile Body: { displayName?, bio? } (validateProfileUpdate trims and limits)
 */
async function updateProfile(req, res) {
    try {
        const userId = req.user.id;
        const { displayName, bio } = req.body;

        if (displayName !== undefined) {
            // Full names are HTML-escaped on write like at registration (legacy rule, see sanitizeHtml)
            await executeQuery('UPDATE users SET full_name = ? WHERE id = ?', [sanitizeHtml(displayName || '') || null, userId]);
        }
        if (bio !== undefined) {
            // Stored raw; clients render it with textContent
            await executeQuery('UPDATE users SET bio = ? WHERE id = ?', [bio || null, userId]);
        }

        await privacy.emitProfileUpdate(req.io, userId);
        res.json({ success: true, message: 'Profile updated', data: await ownProfile(userId) });
    } catch (error) {
        serverError(res, 'Update profile', error, 'Failed to update your profile');
    }
}

/**
 * POST /api/users/me/avatar (multipart field "avatar"): replaces the old photo
 */
async function uploadAvatar(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Choose a photo to upload' });
        }
        const saved = await avatars.saveUserAvatar(req.file.buffer);
        if (saved.error) {
            return res.status(saved.status).json({ success: false, message: saved.error });
        }

        const userId = req.user.id;
        const previous = await queryOne('SELECT avatar_url FROM users WHERE id = ?', [userId]);
        await executeQuery('UPDATE users SET avatar_url = ? WHERE id = ?', [saved.avatarUrl, userId]);
        if (previous && previous.avatar_url && previous.avatar_url !== saved.avatarUrl) {
            await avatars.deleteUserAvatar(previous.avatar_url);
        }

        await privacy.emitProfileUpdate(req.io, userId);
        res.json({ success: true, message: 'Profile photo updated', data: await ownProfile(userId) });
    } catch (error) {
        serverError(res, 'Upload profile photo', error, 'Failed to update your profile photo');
    }
}

/**
 * DELETE /api/users/me/avatar
 */
async function removeAvatar(req, res) {
    try {
        const userId = req.user.id;
        const previous = await queryOne('SELECT avatar_url FROM users WHERE id = ?', [userId]);
        await executeQuery('UPDATE users SET avatar_url = NULL WHERE id = ?', [userId]);
        if (previous && previous.avatar_url) {
            await avatars.deleteUserAvatar(previous.avatar_url);
        }

        await privacy.emitProfileUpdate(req.io, userId);
        res.json({ success: true, message: 'Profile photo removed', data: await ownProfile(userId) });
    } catch (error) {
        serverError(res, 'Remove profile photo', error, 'Failed to remove your profile photo');
    }
}

/**
 * PUT /api/users/me/status Body: { text?, emoji?, duration: '30m'|'1h'|'4h'|'1d'|'1w'|'never' }
 */
async function setCustomStatus(req, res) {
    try {
        const userId = req.user.id;
        const text = req.body.text || null;
        const emoji = req.body.emoji || null;
        const seconds = STATUS_DURATIONS[req.body.duration] || null;

        if (seconds) {
            await executeQuery(
                `UPDATE users SET custom_status_text = ?, custom_status_emoji = ?, custom_status_expires_at = ${plusSecondsSql()} WHERE id = ?`,
                [text, emoji, seconds, userId]
            );
        } else {
            await executeQuery(
                'UPDATE users SET custom_status_text = ?, custom_status_emoji = ?, custom_status_expires_at = NULL WHERE id = ?',
                [text, emoji, userId]
            );
        }

        await privacy.emitProfileUpdate(req.io, userId);
        res.json({ success: true, message: 'Status set', data: await ownProfile(userId) });
    } catch (error) {
        serverError(res, 'Set custom status', error, 'Failed to set your status');
    }
}

/**
 * DELETE /api/users/me/status
 */
async function clearCustomStatus(req, res) {
    try {
        const userId = req.user.id;
        await executeQuery(
            'UPDATE users SET custom_status_text = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL WHERE id = ?',
            [userId]
        );
        await privacy.emitProfileUpdate(req.io, userId);
        res.json({ success: true, message: 'Status cleared', data: await ownProfile(userId) });
    } catch (error) {
        serverError(res, 'Clear custom status', error, 'Failed to clear your status');
    }
}

/**
 * GET /api/users/me/privacy
 */
async function getPrivacy(req, res) {
    try {
        res.json({ success: true, data: await fullPrivacySettings(req.user.id) });
    } catch (error) {
        serverError(res, 'Get privacy settings', error, 'Failed to load your privacy settings');
    }
}

/**
 * PUT /api/users/me/privacy Body: any of { lastSeen, photo, bio, groups, readReceipts, typingIndicators }
 */
async function updatePrivacy(req, res) {
    try {
        const userId = req.user.id;
        const { previous, settings } = await privacy.savePrivacySettings(userId, req.body);
        if (privacy.isAudience(req.body.birthday)) await birthdays.saveBirthdayAudience(userId, req.body.birthday);
        settings.birthday = await birthdays.getBirthdayAudience(userId);

        // Someone who saved the photo URL while it was visible to them loses it with a stricter audience
        if (AUDIENCE_RANK[settings.photo] > AUDIENCE_RANK[previous.photo]) {
            const row = await queryOne('SELECT avatar_url FROM users WHERE id = ?', [userId]);
            const rotated = row && row.avatar_url ? await avatars.rotateUserAvatar(row.avatar_url) : null;
            if (rotated) {
                await executeQuery('UPDATE users SET avatar_url = ? WHERE id = ?', [rotated, userId]);
            }
        }

        if (req.io) {
            // Your other tabs; contacts get the profile (presence included) as they may now see it
            req.io.to(`user_${userId}`).emit('privacy_settings_updated', settings);
            await privacy.emitProfileUpdate(req.io, userId);

            // Presence for everyone else: a hidden status reads as "unknown"
            if (settings.lastSeen !== previous.lastSeen && settings.lastSeen !== 'everyone') {
                const { blocked } = await getBlockRelations(userId);
                const keep = settings.lastSeen === 'contacts' ? await privacy.getContactIds(userId) : new Set();
                const except = [userId, ...blocked, ...keep].map(id => `user_${id}`);
                req.io.except(except).emit('user_status', { userId: Number(userId), status: null });
            }
        }

        res.json({ success: true, message: 'Privacy settings saved', data: settings });
    } catch (error) {
        serverError(res, 'Update privacy settings', error, 'Failed to save your privacy settings');
    }
}

/**
 * GET /api/users/:userId - the profile card, as the signed-in user may see it
 */
async function getUserProfile(req, res) {
    try {
        const viewerId = req.user.id;
        const userId = Number(req.params.userId);
        const profile = await privacy.getVisibleProfile(viewerId, userId);
        if (!profile) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const { blocked } = await getBlockRelations(viewerId);
        res.json({
            success: true,
            data: {
                ...profile,
                birthday: await birthdays.visibleBirthday(viewerId, userId),
                isSelf: userId === Number(viewerId),
                isContact: await privacy.isContact(viewerId, userId),
                blockedByMe: blocked.includes(userId)
            }
        });
    } catch (error) {
        serverError(res, 'Get user profile', error, 'Failed to load the profile');
    }
}

/**
 * PUT /api/users/me/birthday Body: { day, month, year? } (validateBirthday checks it is a real date)
 */
async function setBirthday(req, res) {
    try {
        const userId = req.user.id;
        const year = req.body.year === undefined || req.body.year === null ? null : req.body.year;
        await birthdays.saveBirthday(userId, { day: req.body.day, month: req.body.month, year });
        res.json({ success: true, message: 'Birthday saved', data: await ownProfile(userId) });
    } catch (error) {
        serverError(res, 'Set birthday', error, 'Failed to save your birthday');
    }
}

/**
 * DELETE /api/users/me/birthday
 */
async function clearBirthday(req, res) {
    try {
        await birthdays.clearBirthday(req.user.id);
        res.json({ success: true, message: 'Birthday removed', data: await ownProfile(req.user.id) });
    } catch (error) {
        serverError(res, 'Clear birthday', error, 'Failed to remove your birthday');
    }
}

/**
 * GET /api/chats/:chatId/birthdays?date=YYYY-MM-DD - members of a group whose birthday is on the
 * viewer's local date, as their privacy settings allow (members only)
 */
async function getChatBirthdays(req, res) {
    try {
        const result = await birthdays.birthdaysInChat(req.user.id, req.params.chatId, req.query.date);
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }
        res.json({ success: true, data: result.birthdays });
    } catch (error) {
        serverError(res, 'Chat birthdays', error, 'Failed to load birthdays');
    }
}

module.exports = {
    setBirthday,
    clearBirthday,
    getChatBirthdays,
    getMe,
    updateProfile,
    uploadAvatar,
    removeAvatar,
    setCustomStatus,
    clearCustomStatus,
    getPrivacy,
    updatePrivacy,
    getUserProfile
};
