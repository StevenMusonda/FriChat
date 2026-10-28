/**
 * Group avatars.
 *
 * Uploads arrive in memory (middleware/groupAvatarUpload.js). The type is decided from the file's
 * first bytes, not the client's mime type. With sharp installed the image is re-encoded as a
 * 256x256 WebP, which also drops EXIF data such as GPS position; without it the original bytes
 * are kept (size and type limits still apply). Files get random names under uploads/group-avatars.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, isInsideDir } = require('./uploads');
const { GROUP_AVATAR_TYPES, GROUP_AVATAR_SIZE_PX } = require('../config/groups');

const AVATAR_SUBDIR = 'group-avatars';
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Refuse decompression bombs before sharp allocates the pixels (24 megapixels is plenty for an avatar)
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

/**
 * Mime type from magic bytes: JPEG, PNG or WebP, else null
 */
function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

function avatarDir() {
    return path.join(UPLOAD_DIR, AVATAR_SUBDIR);
}

/**
 * Validate, resize (when possible) and store an avatar.
 * @returns {Promise<{ avatarUrl: string, resized: boolean } | { error: string }>}
 *          avatarUrl is relative to the backend root, e.g. 'uploads/group-avatars/<hex>.webp'
 */
async function saveGroupAvatar(buffer) {
    const detected = detectImageType(buffer);
    if (!detected || !GROUP_AVATAR_TYPES.includes(detected)) {
        return { error: 'The avatar must be a JPEG, PNG or WebP image' };
    }

    let output = buffer;
    let extension = EXTENSIONS[detected];
    let resized = false;

    const sharp = loadSharp();
    if (sharp) {
        try {
            output = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
                .rotate() // apply EXIF orientation before metadata is dropped
                .resize(GROUP_AVATAR_SIZE_PX, GROUP_AVATAR_SIZE_PX, { fit: 'cover', position: 'centre' })
                .webp({ quality: 82 })
                .toBuffer();
            extension = '.webp';
            resized = true;
        } catch (error) {
            return { error: 'That image could not be read. Try a different file.' };
        }
    }

    const dir = avatarDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const fileName = crypto.randomBytes(16).toString('hex') + extension;
    await fs.promises.writeFile(path.join(dir, fileName), output, { flag: 'wx' });

    return { avatarUrl: `uploads/${AVATAR_SUBDIR}/${fileName}`, resized };
}

/**
 * Delete a stored avatar file. Only ever touches files directly inside uploads/group-avatars.
 */
async function deleteGroupAvatar(avatarUrl) {
    if (typeof avatarUrl !== 'string') return;
    const match = /^uploads\/group-avatars\/([a-f0-9]{32}\.(?:webp|jpg|png))$/.exec(avatarUrl);
    if (!match) return;

    const full = path.join(avatarDir(), match[1]);
    if (!isInsideDir(avatarDir(), full)) return;
    try {
        await fs.promises.unlink(full);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Delete group avatar error:', error);
    }
}

module.exports = {
    AVATAR_SUBDIR,
    detectImageType,
    saveGroupAvatar,
    deleteGroupAvatar,
    isSharpAvailable: () => !!loadSharp()
};
