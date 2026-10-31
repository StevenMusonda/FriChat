/**
 * Personal data exports (Settings > Security).
 *
 * A request is a data_exports row. A background job (runAccountJobs in utils/scheduler.js) writes
 * data.json to a temporary file a page at a time, so a long history doesn't sit in memory, then zips
 * it with the user's uploads into a private folder that has no URL. The zip is deleted when it expires.
 *
 * Every SELECT here names its columns: a new column (a secret, say) can't reach an export by
 * accident. Other people appear by name only, and only their names: never an email, a last-seen time
 * or a photo.
 *
 * Downloading takes a session (so it passes 2FA like everything else) that mints a 5-minute link. The
 * email only says the export is ready, so a read mailbox doesn't hand anyone the data.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const jwt = require('jsonwebtoken');
const yazl = require('yazl');
const { executeQuery, queryOne, updateAndCount, insertAndGetId } = require('../config/database');
const {
    EXPORT_PAGE_SIZE,
    EXPORT_MAX_ATTEMPTS,
    EXPORT_STALE_SECONDS,
    EXPORT_LINK_TTL_SECONDS,
    exportConfig
} = require('../config/accountSecurity');
const { plusSecondsSql, minusSecondsSql, secondsUntilSql, isoFromSecondsUntil } = require('./timeSql');
const { privateDir } = require('./uploadSecurity');
const { resolveUploadPath } = require('./uploads');
const { storedAvatarPath } = require('./avatars');
const { notifySecurityEvent } = require('./securityEmails');
const { toBool } = require('./messageQueries');
const auditLog = require('./auditLog');

const EXPORT_FORMAT_VERSION = 1;
const DOWNLOAD_NAME = 'frichat-data-export.zip';
const LINK_PURPOSE = 'data_export';
const STORED_NAME_PATTERN = /^[a-f0-9]{32}\.zip$/;
const MAX_BUILDS_PER_TICK = 3;

const exportDir = () => privateDir('DATA_EXPORT_PATH', 'exports');

function exportPath(fileName) {
    if (typeof fileName !== 'string' || !STORED_NAME_PATTERN.test(fileName)) return null;
    return path.join(exportDir(), fileName);
}

async function removeFile(fullPath) {
    try {
        await fs.promises.unlink(fullPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

// --- requests ---

/**
 * One export at a time, and one per cooldown period. This outlives a restart, unlike the route's limiter.
 * @returns {Promise<{ exportId } | { error }>}
 */
async function requestExport(userId) {
    const active = await queryOne("SELECT id FROM data_exports WHERE user_id = ? AND status IN ('pending', 'running')", [userId]);
    if (active) {
        return { error: { status: 409, code: 'EXPORT_IN_PROGRESS', message: 'Your export is already being prepared.' } };
    }

    const { cooldownHours } = exportConfig();
    if (cooldownHours > 0) {
        const recent = await queryOne(
            `SELECT id FROM data_exports WHERE user_id = ? AND status IN ('ready', 'expired') AND requested_at > ${minusSecondsSql(cooldownHours * 3600)}`,
            [userId]
        );
        if (recent) {
            return { error: { status: 429, code: 'EXPORT_COOLDOWN', message: `You can request one export every ${cooldownHours} hours.` } };
        }
    }

    return { exportId: Number(await insertAndGetId('INSERT INTO data_exports (user_id) VALUES (?)', [userId])) };
}

/**
 * The newest few, for Settings > Security
 */
async function listExports(userId) {
    const rows = await executeQuery(`
        SELECT id, status, file_size, requested_at, ${secondsUntilSql('expires_at')} AS seconds_left
        FROM data_exports
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 5
    `, [userId]);
    return rows.map((row) => {
        const secondsLeft = row.seconds_left === null ? null : Number(row.seconds_left);
        const expired = row.status === 'ready' && secondsLeft !== null && secondsLeft <= 0;
        return {
            id: Number(row.id),
            status: expired ? 'expired' : row.status,
            fileSize: row.file_size === null ? null : Number(row.file_size),
            requestedAt: row.requested_at,
            expiresAt: row.status === 'ready' ? isoFromSecondsUntil(row.seconds_left) : null
        };
    });
}

// --- download ---

/**
 * @returns {Promise<{ fullPath, fileSize } | null>} null unless this is the user's own, still-current export
 */
async function findDownload(exportId, userId) {
    const row = await queryOne(`
        SELECT file_name, file_size
        FROM data_exports
        WHERE id = ? AND user_id = ? AND status = 'ready' AND expires_at > CURRENT_TIMESTAMP
    `, [exportId, userId]);
    const fullPath = row ? exportPath(row.file_name) : null;
    return fullPath ? { fullPath, fileSize: Number(row.file_size) } : null;
}

/**
 * A link for one export, good for a few minutes. It has no session id, so it never works as an access token.
 */
function signDownloadToken(exportId, userId) {
    return jwt.sign({ purpose: LINK_PURPOSE, exportId, userId }, process.env.JWT_SECRET, { expiresIn: EXPORT_LINK_TTL_SECONDS });
}

/**
 * @returns {{ exportId, userId } | null}
 */
function verifyDownloadToken(token) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.purpose !== LINK_PURPOSE || !decoded.exportId || !decoded.userId) return null;
        return { exportId: decoded.exportId, userId: decoded.userId };
    } catch (error) {
        return null;
    }
}

// --- building the file ---

/**
 * Sections small enough to read in one go. The rows go into the JSON as they are, so a column named
 * here is a column the user receives.
 */
const SECTIONS = {
    scheduledMessages: 'SELECT id, chat_id, content, send_at, status, created_at FROM scheduled_messages WHERE user_id = ? ORDER BY id',
    reminders: 'SELECT id, message_id, chat_id, remind_at, status, created_at FROM message_reminders WHERE user_id = ? ORDER BY id',
    pollsCreated: 'SELECT id, chat_id, message_id, question, multiple_choice, anonymous, closes_at, closed_at, created_at FROM polls WHERE created_by = ? ORDER BY id',
    pollVotes: `
        SELECT v.poll_id, p.question, o.option_text, v.created_at
        FROM poll_votes v
        JOIN polls p ON p.id = v.poll_id
        JOIN poll_options o ON o.id = v.option_id
        WHERE v.user_id = ?
        ORDER BY v.id`,
    eventsCreated: 'SELECT id, chat_id, title, description, location, starts_at, ends_at, timezone, status, created_at FROM chat_events WHERE created_by = ? ORDER BY id',
    eventRsvps: `
        SELECT r.event_id, e.title, r.response, r.updated_at
        FROM event_rsvps r
        JOIN chat_events e ON e.id = r.event_id
        WHERE r.user_id = ?
        ORDER BY r.event_id`,
    listItemsCreated: 'SELECT id, list_id, chat_id, text, done, due_at, created_at FROM chat_list_items WHERE created_by = ? ORDER BY id',
    blockedUsers: `
        SELECT u.username, u.full_name, b.created_at
        FROM user_blocks b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.id`,
    devices: 'SELECT device_label, ip_address, created_at, last_active_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY id',
    warnings: 'SELECT message, created_at, acknowledged_at FROM user_warnings WHERE user_id = ? ORDER BY id'
};

function shapeMessage(row) {
    return {
        id: Number(row.id),
        chatId: Number(row.chat_id),
        type: row.message_type,
        content: row.content,
        fileId: row.file_id === null ? null : Number(row.file_id),
        replyToMessageId: row.reply_to_message_id === null ? null : Number(row.reply_to_message_id),
        forwarded: toBool(row.is_forwarded),
        deletedForEveryone: toBool(row.deleted_for_everyone),
        editedAt: row.edited_at,
        sentAt: row.created_at
    };
}

/**
 * The name a file gets inside the zip: the id keeps it unique, and nothing from a user-chosen name
 * survives that could climb out of the folder when someone extracts it
 */
function archiveName(fileId, originalName) {
    const safe = String(originalName || 'file')
        .replace(/[^\p{L}\p{N}._ -]/gu, '_')
        .replace(/^[.\s]+/, '')
        .slice(-100);
    return `uploads/${fileId}-${safe || 'file'}`;
}

/**
 * Writes one value after another, waiting whenever the file can't keep up
 */
function jsonWriter(filePath) {
    const stream = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
    let failure = null;
    stream.on('error', (error) => { failure = error; });

    const write = async (text) => {
        if (failure) throw failure;
        if (!stream.write(text)) {
            await new Promise((resolve, reject) => {
                stream.once('drain', resolve);
                stream.once('error', reject);
            });
        }
    };
    const close = () => new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        stream.once('error', reject);
        stream.end(resolve);
    });
    return { write, close };
}

/**
 * One top-level array, a page of rows at a time
 * @param {function(number): Promise<Array>} fetchPage - rows after the given id, in id order
 * @returns {Promise<number>} how many rows were written
 */
async function writePagedArray(out, key, fetchPage, shape) {
    await out.write(`,\n${JSON.stringify(key)}: [`);
    let lastId = 0;
    let total = 0;
    for (;;) {
        const rows = await fetchPage(lastId);
        for (const row of rows) {
            await out.write(`${total > 0 ? ',' : ''}\n${JSON.stringify(await shape(row))}`);
            total++;
        }
        if (rows.length < EXPORT_PAGE_SIZE) break;
        lastId = Number(rows[rows.length - 1].id);
    }
    await out.write('\n]');
    return total;
}

async function chatsWithMembers(userId) {
    const chats = await executeQuery(`
        SELECT c.id, c.chat_type, c.chat_name, c.description, c.created_at, gm.role, gm.joined_at
        FROM group_members gm
        JOIN chats c ON c.id = gm.chat_id
        WHERE gm.user_id = ?
        ORDER BY c.id
    `, [userId]);

    const result = [];
    for (const chat of chats) {
        const members = await executeQuery(`
            SELECT u.username, u.full_name
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.chat_id = ?
            ORDER BY gm.id
        `, [chat.id]);
        result.push({
            id: Number(chat.id),
            type: chat.chat_type,
            name: chat.chat_name,
            description: chat.description,
            yourRole: chat.role,
            joinedAt: chat.joined_at,
            createdAt: chat.created_at,
            members: members.map(member => ({ username: member.username, displayName: member.full_name }))
        });
    }
    return result;
}

async function ownProfile(userId) {
    const profile = await queryOne(`
        SELECT id, username, email, full_name, bio, avatar_url, custom_status_text, custom_status_emoji,
               birthday_day, birthday_month, birthday_year, last_seen, email_verified_at, totp_enabled_at, created_at
        FROM users
        WHERE id = ?
    `, [userId]);
    if (!profile) return null;
    return { ...profile, id: Number(profile.id), two_factor_enabled: !!profile.totp_enabled_at, totp_enabled_at: undefined };
}

async function ownSettings(userId) {
    return {
        privacy: await queryOne(`
            SELECT last_seen_audience, photo_audience, bio_audience, groups_audience, birthday_audience, read_receipts, typing_indicators
            FROM privacy_settings WHERE user_id = ?
        `, [userId]),
        notifications: await queryOne(`
            SELECT dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone
            FROM notification_settings WHERE user_id = ?
        `, [userId])
    };
}

async function securityActivity(userId) {
    const entries = [];
    let before;
    do {
        const page = await auditLog.forUser(userId, { before });
        entries.push(...page.entries);
        before = page.nextCursor;
    } while (before);
    return entries;
}

/**
 * Pages use ids as cursors, so messages that arrive during the build can't shift a page
 */
async function writeJson(userId, filePath) {
    const out = jsonWriter(filePath);
    const attachments = [];

    await out.write(`{\n"format": ${JSON.stringify('frichat-data-export')},\n"version": ${EXPORT_FORMAT_VERSION},\n"exportedAt": ${JSON.stringify(new Date().toISOString())}`);
    const profile = await ownProfile(userId);
    await out.write(`,\n"profile": ${JSON.stringify(profile)}`);
    await out.write(`,\n"settings": ${JSON.stringify(await ownSettings(userId))}`);

    const chats = await chatsWithMembers(userId);
    await out.write(`,\n"chats": ${JSON.stringify(chats)}`);

    const messages = await writePagedArray(out, 'messages', lastId => executeQuery(`
        SELECT id, chat_id, message_type, content, file_id, reply_to_message_id, is_forwarded, deleted_for_everyone, edited_at, created_at
        FROM messages
        WHERE sender_id = ? AND id > ? AND message_type <> 'system'
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        ORDER BY id
        LIMIT ${EXPORT_PAGE_SIZE}
    `, [userId, lastId]), shapeMessage);

    const reactions = await writePagedArray(out, 'reactions', lastId => executeQuery(`
        SELECT r.id, r.message_id, m.chat_id, r.emoji, r.created_at
        FROM message_reactions r
        JOIN messages m ON m.id = r.message_id
        WHERE r.user_id = ? AND r.id > ?
        ORDER BY r.id
        LIMIT ${EXPORT_PAGE_SIZE}
    `, [userId, lastId]), row => ({
        messageId: Number(row.message_id),
        chatId: Number(row.chat_id),
        emoji: row.emoji,
        reactedAt: row.created_at
    }));

    const files = await writePagedArray(out, 'files', lastId => executeQuery(`
        SELECT id, original_name, mime_type, file_type, file_size, upload_path, uploaded_at, duration_ms
        FROM files
        WHERE uploaded_by = ? AND id > ?
        ORDER BY id
        LIMIT ${EXPORT_PAGE_SIZE}
    `, [userId, lastId]), async (row) => {
        const source = resolveUploadPath(row.upload_path);
        const onDisk = !!source && await fs.promises.stat(source).then(stat => stat.isFile(), () => false);
        const name = archiveName(row.id, row.original_name);
        if (onDisk) attachments.push({ source, name });
        return {
            id: Number(row.id),
            name: row.original_name,
            mimeType: row.mime_type,
            type: row.file_type,
            size: Number(row.file_size),
            uploadedAt: row.uploaded_at,
            durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
            pathInArchive: onDisk ? name : null // null: the file is no longer on disk
        };
    });

    for (const [key, sql] of Object.entries(SECTIONS)) {
        await out.write(`,\n${JSON.stringify(key)}: ${JSON.stringify(await executeQuery(sql, [userId]))}`);
    }
    await out.write(`,\n"securityActivity": ${JSON.stringify(await securityActivity(userId))}`);

    const avatar = profile ? storedAvatarPath(profile.avatar_url) : null;
    if (avatar && await fs.promises.stat(avatar).then(stat => stat.isFile(), () => false)) {
        attachments.push({ source: avatar, name: 'uploads/profile-photo.webp' });
    }

    await out.write(`,\n"summary": ${JSON.stringify({ chats: chats.length, messages, reactions, files })}\n}\n`);
    await out.close();
    return attachments;
}

async function writeZip(jsonPath, attachments, zipPath) {
    const zip = new yazl.ZipFile();
    zip.addFile(jsonPath, 'data.json');
    for (const { source, name } of attachments) {
        // Photos, video and audio are already compressed
        zip.addFile(source, name, { compress: false });
    }
    zip.end();

    await new Promise((resolve, reject) => {
        zip.on('error', reject);
        pipeline(zip.outputStream, fs.createWriteStream(zipPath, { flags: 'wx', mode: 0o600 })).then(resolve, reject);
    });
}

/**
 * @returns {Promise<{ fileName, fileSize }>}
 */
async function buildArchive(userId) {
    const dir = exportDir();
    await fs.promises.mkdir(dir, { recursive: true });

    const base = crypto.randomBytes(16).toString('hex');
    const jsonPath = path.join(dir, `${base}.json.tmp`);
    const zipPath = path.join(dir, `${base}.zip.tmp`);
    const fileName = `${base}.zip`;

    try {
        const attachments = await writeJson(userId, jsonPath);
        await writeZip(jsonPath, attachments, zipPath);
        await fs.promises.rename(zipPath, path.join(dir, fileName));
        const { size } = await fs.promises.stat(path.join(dir, fileName));
        return { fileName, fileSize: size };
    } finally {
        await removeFile(jsonPath).catch(() => {});
        await removeFile(zipPath).catch(() => {});
    }
}

async function runExport(row) {
    const user = await queryOne('SELECT id, username, email, deleted_at FROM users WHERE id = ?', [row.user_id]);
    if (!user || user.deleted_at) {
        await executeQuery("UPDATE data_exports SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        return;
    }

    const { ttlHours } = exportConfig();
    const { fileName, fileSize } = await buildArchive(row.user_id);
    await executeQuery(
        `UPDATE data_exports SET status = 'ready', file_name = ?, file_size = ?, finished_at = CURRENT_TIMESTAMP, expires_at = ${plusSecondsSql()} WHERE id = ?`,
        [fileName, fileSize, ttlHours * 3600, row.id]
    );
    notifySecurityEvent(user, 'export_ready', { expiresInHours: ttlHours });
}

/**
 * Builds that died with the server go back in the queue
 */
async function requeueStaleExports() {
    await executeQuery(`
        UPDATE data_exports SET status = 'pending'
        WHERE status = 'running' AND started_at < ${minusSecondsSql(EXPORT_STALE_SECONDS)} AND attempts < ?
    `, [EXPORT_MAX_ATTEMPTS]);
    await executeQuery(`
        UPDATE data_exports SET status = 'failed', finished_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND started_at < ${minusSecondsSql(EXPORT_STALE_SECONDS)}
    `);
}

/**
 * Scheduler: build what is waiting. The claim is a conditional UPDATE, so two workers can't take the
 * same request. A failure stops the tick: it is usually the disk, and the next export would fail too.
 * @returns {Promise<{ built: number }>}
 */
async function processPendingExports() {
    await requeueStaleExports();

    let built = 0;
    while (built < MAX_BUILDS_PER_TICK) {
        const row = await queryOne("SELECT id, user_id, attempts FROM data_exports WHERE status = 'pending' ORDER BY id LIMIT 1");
        if (!row) break;

        const claimed = await updateAndCount(
            "UPDATE data_exports SET status = 'running', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
            [row.id]
        );
        if (claimed === 0) continue;

        try {
            await runExport(row);
            built++;
        } catch (error) {
            console.error(`Data export ${row.id} failed:`, error.message);
            const giveUp = Number(row.attempts) + 1 >= EXPORT_MAX_ATTEMPTS;
            await executeQuery(
                `UPDATE data_exports SET status = ?, finished_at = ${giveUp ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`,
                [giveUp ? 'failed' : 'pending', row.id]
            );
            break;
        }
    }
    return { built };
}

/**
 * Scheduler: expired zips leave the disk
 * @returns {Promise<{ expired: number }>}
 */
async function sweepExpiredExports() {
    const rows = await executeQuery("SELECT id, file_name FROM data_exports WHERE status = 'ready' AND expires_at <= CURRENT_TIMESTAMP");
    for (const row of rows) {
        const fullPath = exportPath(row.file_name);
        if (fullPath) await removeFile(fullPath);
        await executeQuery("UPDATE data_exports SET status = 'expired', file_name = NULL WHERE id = ?", [row.id]);
    }
    return { expired: rows.length };
}

/**
 * Account deletion: every export of this user, file and row
 */
async function deleteUserExports(userId) {
    const rows = await executeQuery('SELECT id, file_name FROM data_exports WHERE user_id = ?', [userId]);
    for (const row of rows) {
        const fullPath = exportPath(row.file_name);
        if (fullPath) await removeFile(fullPath);
    }
    await executeQuery('DELETE FROM data_exports WHERE user_id = ?', [userId]);
}

module.exports = {
    DOWNLOAD_NAME,
    requestExport,
    listExports,
    findDownload,
    signDownloadToken,
    verifyDownloadToken,
    archiveName,
    processPendingExports,
    sweepExpiredExports,
    deleteUserExports
};
