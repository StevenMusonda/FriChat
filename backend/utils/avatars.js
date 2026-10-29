/**
 * Profile photos.
 *
 * Uploads arrive in memory (middleware/userAvatarUpload.js). The type is decided from the file's
 * first bytes, never the client's mime type or file name. Unlike group avatars, a profile photo is
 * only stored after sharp has decoded it and re-encoded the pixels as a fresh square WebP (centre
 * crop): nothing of the uploaded file itself (scripts, HTML, SVG, polyglot trailers, EXIF/GPS) is
 * kept, and the file is always served as image/webp with nosniff (helmet). Without sharp, uploads
 * are refused. Files get random names under uploads/avatars; the old file is deleted on replace.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, isInsideDir } = require('./uploads');
const { detectImageType } = require('./groupAvatar');
const { PROFILE_AVATAR_TYPES, PROFILE_AVATAR_SIZE_PX } = require('../config/profile');
const { USER_AVATAR_PATTERN } = require('./privacy');

const AVATAR_SUBDIR = 'avatars';

// Refuse decompression bombs before sharp allocates the pixels
const MAX_INPUT_PIXELS = 24 * 1000 * 1000;

let sharpModule;
function loadSharp() {
    if (sharpModule === undefined) {
        try {
            sharpModule = require('sharp');
        } catch (error) {
            sharpModule = null;
        }
    }
    return sharpModule;
}

function avatarDir() {
    return path.join(UPLOAD_DIR, AVATAR_SUBDIR);
}

function randomName() {
    return crypto.randomBytes(16).toString('hex') + '.webp';
}

/**
 * Validate, crop to a square, resize, re-encode and store a profile photo.
 * @returns {Promise<{ avatarUrl: string } | { error: string, status: number }>}
 *          avatarUrl is relative to the backend root, e.g. 'uploads/avatars/<hex>.webp'
 */
async function saveUserAvatar(buffer) {
    const detected = detectImageType(buffer);
    if (!detected || !PROFILE_AVATAR_TYPES.includes(detected)) {
        return { status: 400, error: 'The photo must be a JPEG, PNG or WebP image' };
    }

    const sharp = loadSharp();
    if (!sharp) {
        return { status: 503, error: 'Profile photos are not available on this server (image processing is not installed)' };
    }

    let output;
    try {
        output = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false })
            .rotate() // apply EXIF orientation before metadata is dropped
            .resize(PROFILE_AVATAR_SIZE_PX, PROFILE_AVATAR_SIZE_PX, { fit: 'cover', position: 'centre' })
            .webp({ quality: 82 })
            .toBuffer();
    } catch (error) {
        return { status: 400, error: 'That image could not be read. Try a different file.' };
    }

    // Belt and braces: what goes to disk is a WebP sharp produced
    if (detectImageType(output) !== 'image/webp') {
        return { status: 400, error: 'That image could not be read. Try a different file.' };
    }

    const dir = avatarDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const fileName = randomName();
    await fs.promises.writeFile(path.join(dir, fileName), output, { flag: 'wx' });
    return { avatarUrl: `uploads/${AVATAR_SUBDIR}/${fileName}` };
}

/**
 * Full path of a stored profile photo, or null for anything that isn't one
 */
function storedAvatarPath(avatarUrl) {
    if (typeof avatarUrl !== 'string' || !USER_AVATAR_PATTERN.test(avatarUrl)) return null;
    const full = path.join(avatarDir(), path.basename(avatarUrl));
    return isInsideDir(avatarDir(), full) ? full : null;
}

/**
 * Delete a stored profile photo. Only ever touches files directly inside uploads/avatars.
 */
async function deleteUserAvatar(avatarUrl) {
    const full = storedAvatarPath(avatarUrl);
    if (!full) return;
    try {
        await fs.promises.unlink(full);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Delete profile photo error:', error);
    }
}

/**
 * Move a stored photo to a new random name, so a URL someone saw before a privacy change stops working
 * @returns {Promise<string|null>} the new avatarUrl, or null if there was no stored file
 */
async function rotateUserAvatar(avatarUrl) {
    const full = storedAvatarPath(avatarUrl);
    if (!full) return null;
    const fileName = randomName();
    try {
        await fs.promises.rename(full, path.join(avatarDir(), fileName));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    return `uploads/${AVATAR_SUBDIR}/${fileName}`;
}

module.exports = {
    AVATAR_SUBDIR,
    saveUserAvatar,
    deleteUserAvatar,
    rotateUserAvatar,
    isSharpAvailable: () => !!loadSharp()
};
