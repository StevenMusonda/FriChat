/**
 * File Upload Middleware
 * Handles file uploads with validation
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_PATH || './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Create subdirectories based on file type
        let subDir = 'files';
        if (file.mimetype.startsWith('image/')) {
            subDir = 'images';
        } else if (file.mimetype.startsWith('video/')) {
            subDir = 'videos';
        } else if (file.mimetype.startsWith('audio/')) {
            subDir = 'audio';
        }
        
        const fullPath = path.join(uploadDir, subDir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        
        cb(null, fullPath);
    },
    filename: function (req, file, cb) {
        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        cb(null, name + '-' + uniqueSuffix + ext);
    }
});

// What MediaRecorder produces: webm/opus (Chrome, Firefox, Edge), mp4/AAC (Safari), ogg/opus (older Firefox)
const DEFAULT_AUDIO_TYPES = 'audio/webm,audio/ogg,audio/mp4,audio/mpeg,audio/aac';
// A 5-minute voice note is about 1-2 MB as opus and up to ~5 MB as AAC
const DEFAULT_MAX_AUDIO_FILE_SIZE = 10 * 1024 * 1024;

/**
 * "audio/webm;codecs=opus" -> "audio/webm": recorders label their blobs with codec parameters,
 * the allowlist has plain types
 */
function baseMimeType(mimetype) {
    return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

function parseTypes(value) {
    return value.split(',').map(baseMimeType).filter(Boolean);
}

/**
 * Allowed MIME types and the size caps from the environment. The composer fetches them
 * (GET /api/messages/upload-limits) to refuse a file before uploading it.
 * Audio (voice notes) has its own, smaller cap: maxAudioFileSize, never above maxFileSize.
 */
function getUploadLimits() {
    const allowedImages = parseTypes(process.env.ALLOWED_IMAGE_TYPES || 'image/jpeg,image/png,image/gif,image/webp');
    const allowedVideos = parseTypes(process.env.ALLOWED_VIDEO_TYPES || 'video/mp4,video/webm,video/quicktime');
    const allowedFiles = parseTypes(process.env.ALLOWED_FILE_TYPES || 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,application/x-zip-compressed');
    const allowedAudio = parseTypes(process.env.ALLOWED_AUDIO_TYPES || DEFAULT_AUDIO_TYPES);

    const maxFileSize = parseInt(process.env.MAX_FILE_SIZE) || 104857600; // 100MB default
    const maxAudioFileSize = Math.min(parseInt(process.env.MAX_AUDIO_FILE_SIZE) || DEFAULT_MAX_AUDIO_FILE_SIZE, maxFileSize);

    return {
        maxFileSize,
        maxAudioFileSize,
        audioTypes: allowedAudio,
        allowedTypes: [...allowedImages, ...allowedVideos, ...allowedFiles, ...allowedAudio]
    };
}

/**
 * Size cap for one stored file (multer only knows one cap, so audio is checked after the upload)
 */
function maxSizeFor(mimetype, limits = getUploadLimits()) {
    return baseMimeType(mimetype).startsWith('audio/') ? limits.maxAudioFileSize : limits.maxFileSize;
}

// File filter for validation
const fileFilter = (req, file, cb) => {
    // Stored and served under the plain type, whatever parameters the browser added
    file.mimetype = baseMimeType(file.mimetype);
    if (getUploadLimits().allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`File type ${file.mimetype} not allowed`), false);
    }
};

// Configure multer
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: getUploadLimits().maxFileSize
    }
});

// Error handling middleware
const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is ' + (process.env.MAX_FILE_SIZE || 104857600) + ' bytes'
            });
        }
        return res.status(400).json({
            success: false,
            message: 'File upload error: ' + err.message
        });
    } else if (err) {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }
    next();
};

module.exports = {
    upload,
    handleUploadError,
    getUploadLimits,
    maxSizeFor,
    baseMimeType
};
