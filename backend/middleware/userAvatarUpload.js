/**
 * Profile photo upload: one image in memory (nothing reaches disk until utils/avatars.js has
 * checked the bytes and re-encoded them)
 */

const multer = require('multer');
const { PROFILE_AVATAR_TYPES, profileAvatarMaxBytes } = require('../config/profile');

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: profileAvatarMaxBytes(), files: 1, fields: 5 },
    fileFilter: (req, file, cb) => {
        if (PROFILE_AVATAR_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('The photo must be a JPEG, PNG or WebP image'), false);
        }
    }
});

function handleUserAvatarUploadError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? `The photo must be at most ${Math.round(profileAvatarMaxBytes() / (1024 * 1024))} MB`
            : 'Photo upload error: ' + err.message;
        return res.status(400).json({ success: false, message });
    }
    if (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
    next();
}

module.exports = {
    uploadUserAvatar: avatarUpload.single('avatar'),
    handleUserAvatarUploadError
};
