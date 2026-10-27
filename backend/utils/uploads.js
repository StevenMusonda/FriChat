/**
 * Uploaded files: where they live on disk, and how a message gets to use one.
 *
 * A client never tells the server where a file is. It uploads through
 * POST /api/messages/upload and gets back a file id; sends only pass that id,
 * and everything else (path, name, mime type, size) comes from the files row
 * the server wrote. Each upload can be attached to one message (files.attached_at);
 * forwarding later reuses that row, which is fine because the forwarder can see it.
 */

const path = require('path');
const { executeQuery, queryOne } = require('../config/database');

// Same setting middleware/upload.js writes to; stored upload_path values are relative to the cwd too
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_PATH || './uploads');

/**
 * True when candidate is strictly inside dir (dir itself does not count)
 */
function isInsideDir(dir, candidate) {
    const rel = path.relative(dir, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Absolute path of a stored upload_path, or null if it would leave the uploads directory
 */
function resolveUploadPath(storedPath) {
    if (typeof storedPath !== 'string' || storedPath === '' || storedPath.includes('\0')) {
        return null;
    }
    const full = path.resolve(storedPath);
    return isInsideDir(UPLOAD_DIR, full) ? full : null;
}

/**
 * Express middleware placed in front of express.static: refuses any request
 * whose decoded path would resolve outside root (encoded ../, backslashes, NUL)
 */
function guardStaticPath(root) {
    const absRoot = path.resolve(root);
    return (req, res, next) => {
        let requested;
        try {
            requested = decodeURIComponent(req.path);
        } catch (error) {
            return res.status(400).end();
        }
        if (requested.includes('\0') || !isInsideDir(absRoot, path.join(absRoot, requested))) {
            return res.status(404).end();
        }
        next();
    };
}

/**
 * Message type for a file, from the mime type the server recorded at upload
 */
function messageTypeForMime(mimeType) {
    if (typeof mimeType === 'string') {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
    }
    return 'file';
}

/**
 * Reserve an uploaded file for a new message.
 * The file must exist, be uploaded by userId, not be attached yet and sit inside the uploads directory.
 * The reservation is a single conditional UPDATE, so two sends racing for one file can't both win.
 * @returns {Promise<{file: {id: number, messageType: string}} | {error: string}>}
 */
async function claimUploadedFile(fileId, userId) {
    const id = Number(fileId);
    if (!Number.isInteger(id) || id < 1) {
        return { error: 'Invalid file reference' };
    }

    const file = await queryOne(
        'SELECT id, mime_type, upload_path, uploaded_by, attached_at FROM files WHERE id = ?',
        [id]
    );

    // Someone else's upload looks the same as a missing one
    if (!file || Number(file.uploaded_by) !== Number(userId) || !resolveUploadPath(file.upload_path)) {
        return { error: 'File not found' };
    }
    if (file.attached_at) {
        return { error: 'File is already attached to a message' };
    }

    const claimSql = 'UPDATE files SET attached_at = CURRENT_TIMESTAMP WHERE id = ? AND uploaded_by = ? AND attached_at IS NULL';
    let claimed;
    if (process.env.DB_TYPE === 'postgresql') {
        const rows = await executeQuery(claimSql + ' RETURNING id', [id, userId]);
        claimed = rows.length === 1;
    } else {
        const result = await executeQuery(claimSql, [id, userId]);
        claimed = result.affectedRows === 1;
    }

    if (!claimed) {
        return { error: 'File is already attached to a message' };
    }

    return { file: { id, messageType: messageTypeForMime(file.mime_type) } };
}

/**
 * Undo a claim when the message insert that followed it failed
 */
async function releaseUploadedFile(fileId) {
    try {
        await executeQuery('UPDATE files SET attached_at = NULL WHERE id = ?', [fileId]);
    } catch (error) {
        console.error('Release file claim error:', error);
    }
}

module.exports = {
    UPLOAD_DIR,
    isInsideDir,
    resolveUploadPath,
    guardStaticPath,
    messageTypeForMime,
    claimUploadedFile,
    releaseUploadedFile
};
