/**
 * Upload hardening. multer writes every message upload to uploads/.incoming under a random name
 * with no extension (dotfiles are never served), then processUpload decides what happens to it:
 *
 *   1. the type comes from the file's magic bytes (file-type), never its name or the client's MIME
 *   2. ClamAV, when configured, scans the original bytes; a hit is moved to the quarantine folder
 *   3. images are decoded and re-encoded by sharp: EXIF/GPS and anything appended to the pixels go
 *   4. the file moves to uploads/<images|videos|audio|files>/<random><extension for its real type>
 *
 * The folders for quarantined files and report evidence are outside the uploads folder, so nothing
 * in them has a URL (see privateDir).
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { UPLOAD_DIR, isInsideDir, resolveUploadPath } = require('./uploads');
const { baseMimeType, getUploadLimits, maxSizeFor } = require('../middleware/upload');
const { clamavConfig, UPLOAD_MAX_IMAGE_PIXELS } = require('../config/moderation');
const { insertAndGetId } = require('../config/database');
const auditLog = require('./auditLog');

// Same container, so browsers and recorders disagree about the label: MediaRecorder's audio/webm
// and audio/mp4 are detected as video/webm and video/mp4. A claimed type is accepted when the
// detected one is in its family. Types with no entry must match exactly.
const ISO_MEDIA = ['video/mp4', 'audio/mp4', 'audio/x-m4a', 'video/x-m4v', 'video/quicktime'];
const WEBM = ['video/webm', 'audio/webm'];
const OGG = ['audio/ogg', 'audio/opus', 'video/ogg', 'application/ogg'];
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZIP = ['application/zip', DOCX];
const FAMILIES = {
    'video/mp4': ISO_MEDIA,
    'video/quicktime': ISO_MEDIA,
    'audio/mp4': ISO_MEDIA,
    'video/webm': WEBM,
    'audio/webm': WEBM,
    'audio/ogg': OGG,
    'application/zip': ZIP,
    'application/x-zip-compressed': ZIP,
    [DOCX]: ZIP,
    'application/msword': ['application/x-cfb'] // .doc is an OLE container
};

const EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/aac': '.aac',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    [DOCX]: '.docx',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip'
};

const REENCODED_IMAGES = {
    'image/jpeg': (image) => image.rotate().jpeg({ quality: 88 }),
    'image/png': (image) => image.rotate().png({ compressionLevel: 9 }),
    // Animation is kept, so no .rotate() (sharp refuses it on multi-page images)
    'image/gif': (image) => image.gif(),
    'image/webp': (image) => image.webp({ quality: 85 })
};

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

// file-type is ESM-only; a dynamic import loads it from this CommonJS code
let fileTypeModule;
function loadFileType() {
    if (!fileTypeModule) fileTypeModule = import('file-type');
    return fileTypeModule;
}

function randomName(extension = '') {
    return crypto.randomBytes(16).toString('hex') + extension;
}

/**
 * Absolute folder for files that must never have a URL. An operator's path that points into the
 * public uploads folder is ignored, so a typo can't publish quarantined files.
 */
function privateDir(envName, defaultName) {
    const fallback = path.resolve('private', defaultName);
    const chosen = process.env[envName] ? path.resolve(process.env[envName]) : fallback;
    if (chosen === UPLOAD_DIR || isInsideDir(UPLOAD_DIR, chosen)) {
        console.error(`${envName} must be outside the uploads folder; using ${fallback}`);
        return fallback;
    }
    return chosen;
}

function subDirFor(mimetype) {
    if (mimetype.startsWith('image/')) return 'images';
    if (mimetype.startsWith('video/')) return 'videos';
    if (mimetype.startsWith('audio/')) return 'audio';
    return 'files';
}

/**
 * Decide a file's real type from the first bytes and the client's claim.
 * @param {string|null} detected - from file-type, or null when it found no signature
 * @param {string} claimed - the client's type, already on the allowlist
 * @param {string[]} allowedTypes
 * @returns {string|null} the type to store, or null to refuse
 */
function resolveVerifiedType(detected, claimed, allowedTypes) {
    if (!detected) return null; // HTML, SVG, scripts and plain text have no signature
    const type = baseMimeType(detected);

    // An image is stored as what it really is, whatever it was labelled
    if (claimed.startsWith('image/')) {
        return type.startsWith('image/') && allowedTypes.includes(type) && REENCODED_IMAGES[type] ? type : null;
    }
    return (FAMILIES[claimed] || [claimed]).includes(type) ? claimed : null;
}

async function detectFileType(filePath) {
    const { fileTypeFromFile } = await loadFileType();
    const result = await fileTypeFromFile(filePath);
    return result ? result.mime : null;
}

/**
 * Stream a file to clamd with the INSTREAM command
 * @returns {Promise<{ clean: boolean, signature?: string }>} rejects when clamd can't answer
 */
function scanWithClamd(filePath, config = clamavConfig()) {
    return new Promise((resolve, reject) => {
        const socket = config.socketPath
            ? net.createConnection({ path: config.socketPath })
            : net.createConnection({ host: config.host, port: config.port });
        let reply = '';
        let settled = false;
        let stream = null;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            if (stream) stream.destroy();
            socket.destroy();
            if (error) reject(error);
            else resolve(result);
        };

        socket.setTimeout(config.timeoutMs, () => finish(new Error('clamd timed out')));
        socket.on('error', finish);
        socket.on('data', (data) => { reply += data.toString('utf8'); });
        socket.on('close', () => {
            const text = reply.replace(/\0/g, '').trim();
            const found = /^(?:stream|.*?):\s*(.+?)\s+FOUND$/.exec(text);
            if (found) finish(null, { clean: false, signature: found[1].slice(0, 255) });
            else if (/:\s*OK$/.test(text)) finish(null, { clean: true });
            else finish(new Error(`clamd said: ${text.slice(0, 200) || 'nothing'}`));
        });

        socket.on('connect', () => {
            socket.write('zINSTREAM\0');
            stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
            stream.on('error', finish);
            stream.on('data', (chunk) => {
                // Each chunk is prefixed with its length; a zero length ends the stream
                const length = Buffer.alloc(4);
                length.writeUInt32BE(chunk.length, 0);
                socket.write(length);
                if (!socket.write(chunk)) {
                    stream.pause();
                    socket.once('drain', () => stream.resume());
                }
            });
            stream.on('end', () => socket.write(Buffer.alloc(4)));
        });
    });
}

async function moveFile(from, to) {
    try {
        await fs.promises.rename(from, to);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fs.promises.copyFile(from, to);
        await fs.promises.unlink(from);
    }
}

/**
 * Move an infected upload out of reach and record it
 */
async function quarantine(req, file, type, signature) {
    const dir = privateDir('QUARANTINE_PATH', 'quarantine');
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, randomName());
    await moveFile(file.path, target);

    const id = await insertAndGetId(
        'INSERT INTO quarantined_files (original_name, quarantine_path, mime_type, file_size, signature, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
        [String(file.originalname).slice(0, 255), target, type, file.size, signature, req.user.id]
    );
    await auditLog.recordRequest(req, 'upload_quarantined', {
        targetType: 'file',
        targetId: id,
        metadata: { signature, mimeType: type, size: file.size }
    });
}

/**
 * Decode and re-encode an image in place. Through buffers, not paths: sharp keeps input files open
 * for its cache, and on Windows an open file can't be replaced or deleted.
 * @returns {Promise<number|null>} the new size, or null when sharp can't read it
 */
async function reencodeImage(sharp, filePath, type) {
    let output;
    try {
        const image = sharp(await fs.promises.readFile(filePath), {
            limitInputPixels: UPLOAD_MAX_IMAGE_PIXELS,
            failOn: 'error',
            animated: type === 'image/gif' || type === 'image/webp'
        });
        output = await REENCODED_IMAGES[type](image).toBuffer();
    } catch (error) {
        return null;
    }
    await fs.promises.writeFile(filePath, output);
    return output.length;
}

/**
 * Run an upload sitting in .incoming through every check and move it to its final place.
 * On success req.file describes the stored file; on refusal the file is gone from .incoming.
 * @returns {Promise<null | { status: number, message: string }>}
 */
async function processUpload(req) {
    const file = req.file;
    const discard = () => fs.promises.unlink(file.path).catch(() => {});
    const refuse = async (status, message) => {
        await discard();
        return { status, message };
    };

    const limits = getUploadLimits();
    const maxSize = maxSizeFor(file.mimetype, limits);
    if (file.size > maxSize) {
        return refuse(400, `That file is too large. The limit is ${Math.round(maxSize / (1024 * 1024))} MB.`);
    }

    const type = resolveVerifiedType(await detectFileType(file.path), file.mimetype, limits.allowedTypes);
    if (!type) {
        return refuse(400, 'That file\'s contents don\'t match an allowed file type.');
    }

    const isImage = type.startsWith('image/');
    const sharp = isImage ? loadSharp() : null;
    if (isImage && !sharp) {
        return refuse(503, 'Photos are not available on this server (image processing is not installed)');
    }

    const scanner = clamavConfig();
    if (scanner.enabled) {
        let verdict;
        try {
            verdict = await scanWithClamd(file.path, scanner);
        } catch (error) {
            console.error('ClamAV scan failed:', error.message);
            if (!scanner.failOpen) {
                return refuse(503, 'Uploads are unavailable right now because the virus scanner can\'t be reached.');
            }
        }
        if (verdict && !verdict.clean) {
            await quarantine(req, file, type, verdict.signature);
            return { status: 422, message: 'This file was blocked by the virus scanner.' };
        }
    }

    if (isImage) {
        const size = await reencodeImage(sharp, file.path, type);
        if (size === null) return refuse(400, 'That image could not be read. Try a different file.');
        if (size > limits.maxFileSize) return refuse(400, 'That image is too large.');
        file.size = size;
    }

    const subDir = subDirFor(type);
    const uploadRoot = process.env.UPLOAD_PATH || './uploads';
    await fs.promises.mkdir(path.join(uploadRoot, subDir), { recursive: true });
    const filename = randomName(EXTENSIONS[type] || '');
    const finalPath = path.join(uploadRoot, subDir, filename);
    await fs.promises.rename(file.path, finalPath);

    file.path = finalPath;
    file.filename = filename;
    file.mimetype = type;
    return null;
}

/**
 * Route middleware around processUpload
 */
async function secureUpload(req, res, next) {
    if (!req.file) return next();
    try {
        const refused = await processUpload(req);
        if (refused) {
            return res.status(refused.status).json({ success: false, message: refused.message });
        }
        next();
    } catch (error) {
        console.error('Upload processing error:', error);
        if (req.file.path && resolveUploadPath(req.file.path)) {
            await fs.promises.unlink(req.file.path).catch(() => {});
        }
        res.status(500).json({ success: false, message: 'Failed to process the upload' });
    }
}

module.exports = {
    privateDir,
    randomName,
    resolveVerifiedType,
    detectFileType,
    scanWithClamd,
    processUpload,
    secureUpload
};
