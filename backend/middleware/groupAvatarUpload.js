/**
 * Group avatar upload: one image in memory (nothing reaches disk until the admin check
 * and the content check in utils/groupAvatar.js have passed)
 */

const multer = require('multer');
const { GROUP_AVATAR_TYPES, groupAvatarMaxBytes } = require('../config/groups');

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: groupAvatarMaxBytes(), files: 1, fields: 5 },
    fileFilter: (req, file, cb) => {
        if (GROUP_AVATAR_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('The avatar must be a JPEG, PNG or WebP image'), false);
        }
    }
});

function handleAvatarUploadError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? `The avatar must be at most ${Math.round(groupAvatarMaxBytes() / 1024)} KB`
            : 'Avatar upload error: ' + err.message;
        return res.status(400).json({ success: false, message });
    }
    if (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
    next();
}

module.exports = {
    uploadGroupAvatar: avatarUpload.single('avatar'),
    handleAvatarUploadError
};
