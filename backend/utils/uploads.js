/**
 * Uploaded files: where they live on disk, and how a message gets to use one.
 *
 * A client never tells the server where a file is. It uploads through
 * POST /api/messages/upload and gets back a file id; sends only pass that id,
 * and everything else (path, name, mime type, size) comes from the files row
 * the server wrote. Each upload can be attached to one message (files.attached_at);
 * forwarding later reuses that row, which is fine because the forwarder can see it.
 */

const fs = require('fs');
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

// Only these are ever shown in the browser; everything else, whatever its name, is a download.
// SVG is not here: it can carry script.
const INLINE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.mp4', '.webm', '.mov', '.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac'
]);

// Even if a browser did render something from /uploads, this page could run nothing
const UPLOADS_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox";

function isInlineMedia(filePath) {
    return INLINE_EXTENSIONS.has(path.extname(String(filePath)).toLowerCase());
}

/**
 * "attachment" header with the name the file was uploaded under (RFC 6266), safe for any name:
 * quotes and non-ASCII only appear percent-encoded
 */
function attachmentHeader(name) {
    if (!name) return 'attachment';
    const fallback = String(name).replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(String(name)).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * setHeaders for express.static on /uploads. The type of a download is forced to a generic one, so
 * a legacy file named x.html can't come back as text/html whatever else happens.
 */
function setUploadHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', UPLOADS_CSP);
    if (!isInlineMedia(filePath)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        if (!res.getHeader('Content-Disposition')) res.setHeader('Content-Disposition', 'attachment');
    }
}

/**
 * Express middleware before express.static: downloads keep the name they were uploaded under,
 * since stored names are random. If the lookup fails the file still downloads, under its stored name.
 */
async function nameDownloads(req, res, next) {
    if (isInlineMedia(req.path)) return next();
    try {
        const row = await queryOne('SELECT original_name FROM files WHERE stored_name = ?', [path.posix.basename(req.path)]);
        if (row && row.original_name) res.setHeader('Content-Disposition', attachmentHeader(row.original_name));
    } catch (error) {
        console.error('Download name lookup error:', error.message);
    }
    next();
}

/**
 * Message type for a file, from the mime type the server recorded at upload
 */
function messageTypeForMime(mimeType) {
    if (typeof mimeType === 'string') {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'voice';
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

/**
 * Delete files rows that no message points to any more, and their files on disk.
 * A forwarded copy reuses the original's file row, so a file stays while any copy is left.
 * @param {number[]} fileIds - files whose messages were just deleted
 * @returns {Promise<number>} files removed
 */
async function deleteOrphanedFiles(fileIds) {
    const ids = [...new Set((fileIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(', ');
    const orphans = await executeQuery(`
        SELECT f.id, f.upload_path
        FROM files f
        WHERE f.id IN (${placeholders})
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)
    `, ids);
    if (orphans.length === 0) return 0;

    const orphanIds = orphans.map(row => Number(row.id));
    // Checked again in the DELETE, in case a message picked one of them up meanwhile
    await executeQuery(`
        DELETE FROM files
        WHERE id IN (${orphanIds.map(() => '?').join(', ')})
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = files.id)
    `, orphanIds);

    let removed = 0;
    for (const row of orphans) {
        const fullPath = resolveUploadPath(row.upload_path);
        if (!fullPath) continue; // never touch anything outside the uploads folder
        try {
            await fs.promises.unlink(fullPath);
            removed++;
        } catch (error) {
            if (error.code === 'ENOENT') {
                removed++; // already gone
            } else {
                console.error(`Could not delete uploaded file ${row.id}:`, error.message);
            }
        }
    }
    return removed;
}

module.exports = {
    deleteOrphanedFiles,
    UPLOAD_DIR,
    isInsideDir,
    resolveUploadPath,
    guardStaticPath,
    setUploadHeaders,
    nameDownloads,
    attachmentHeader,
    isInlineMedia,
    messageTypeForMime,
    claimUploadedFile,
    releaseUploadedFile
};
