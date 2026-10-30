/**
 * Reports on messages and users.
 *
 * Filing a report copies the evidence into report_evidence straight away: the reported message and
 * the messages around it, read with the reporter's own view of the chat (nothing they had already
 * deleted, nothing expired or deleted for everyone). Those rows have no link to messages, so a
 * delete for everyone, a disappearing timer or a deleted chat leaves them as they were. The reported
 * message's attachment is copied too, to a folder with no URL (uploadSecurity.privateDir).
 *
 * Who reported whom is only ever shown in the admin console.
 */

const fs = require('fs');
const path = require('path');
const { executeQuery, queryOne, insertAndGetId, updateAndCount } = require('../config/database');
const {
    EVIDENCE_CONTEXT_MESSAGES,
    ADMIN_PAGE_SIZE,
    reportEvidenceMaxBytes
} = require('../config/moderation');
const { getMembership } = require('./groups');
const { resolveUploadPath, isInsideDir } = require('./uploads');
const { privateDir, randomName } = require('./uploadSecurity');
const { toBool } = require('./messageQueries');

const EVIDENCE_COLUMNS = 'position, is_reported, message_id, sender_id, sender_username, message_type, content, file_name, file_mime, file_size, evidence_path, sent_at';

// What a member can read of a chat (same rules as getMessages), minus deleted placeholders
const VISIBLE_TO_REPORTER = `dm.id IS NULL
    AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
    AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)`;

const evidenceDir = () => privateDir('REPORT_EVIDENCE_PATH', 'report-evidence');

/**
 * Messages of a chat as the reporter sees them. cursorSql is a fixed comparison or ''.
 */
async function readMessages(reporterId, chatId, cursorSql, cursorValue, order, limit) {
    const params = [reporterId, chatId];
    if (cursorSql) params.push(cursorValue);
    return executeQuery(`
        SELECT m.id, m.sender_id, m.message_type, m.content, m.created_at, u.username,
               f.original_name, f.mime_type, f.file_size, f.upload_path
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN files f ON f.id = m.file_id
        LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
        WHERE m.chat_id = ? ${cursorSql ? `AND ${cursorSql}` : ''} AND ${VISIBLE_TO_REPORTER}
        ORDER BY m.id ${order === 'ASC' ? 'ASC' : 'DESC'}
        LIMIT ${parseInt(limit)}
    `, params);
}

/**
 * The reported message and up to EVIDENCE_CONTEXT_MESSAGES around it, oldest first. Half from each
 * side; near either end of the chat the other side makes up the difference.
 * @returns {Promise<Array>} rows, the reported one marked is_reported
 */
async function collectAroundMessage(reporterId, chatId, messageId) {
    const total = EVIDENCE_CONTEXT_MESSAGES;
    const older = await readMessages(reporterId, chatId, 'm.id < ?', messageId, 'DESC', total);
    const newer = await readMessages(reporterId, chatId, 'm.id > ?', messageId, 'ASC', total);
    const reported = await readMessages(reporterId, chatId, 'm.id = ?', messageId, 'ASC', 1);

    let takeNewer = Math.min(Math.floor(total / 2), newer.length);
    const takeOlder = Math.min(total - takeNewer, older.length);
    takeNewer = Math.min(total - takeOlder, newer.length);

    return [
        ...older.slice(0, takeOlder).reverse(),
        ...reported.map(row => ({ ...row, is_reported: true })),
        ...newer.slice(0, takeNewer)
    ];
}

/**
 * Copy an attachment out of the public uploads folder
 * @returns {Promise<string|null>} path of the copy; null when it's gone or over the size cap
 */
async function copyAttachment(row) {
    const source = row.upload_path ? resolveUploadPath(row.upload_path) : null;
    if (!source || Number(row.file_size) > reportEvidenceMaxBytes()) return null;
    try {
        const dir = evidenceDir();
        await fs.promises.mkdir(dir, { recursive: true });
        const target = path.join(dir, randomName(path.extname(source).toLowerCase()));
        await fs.promises.copyFile(source, target);
        return target;
    } catch (error) {
        console.error('Report evidence file copy failed:', error.message);
        return null;
    }
}

async function saveEvidence(reportId, rows) {
    if (rows.length === 0) return;
    const params = [];
    for (const [position, row] of rows.entries()) {
        params.push(
            reportId, position, !!row.is_reported, row.id, row.sender_id ?? null, row.username ?? null,
            row.message_type, row.content ?? null, row.original_name ?? null, row.mime_type ?? null,
            row.file_size ?? null, row.evidence_path ?? null, row.created_at ?? null
        );
    }
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    await executeQuery(`INSERT INTO report_evidence (report_id, ${EVIDENCE_COLUMNS}) VALUES ${placeholders}`, params);
}

/**
 * What the reporter may report, or why not. A message they can't see looks like a missing one.
 * @returns {Promise<{ target } | { error }>}
 */
async function resolveTarget(reporterId, input) {
    if (input.targetType === 'message') {
        const message = await queryOne(`
            SELECT m.id, m.chat_id, m.sender_id, m.message_type
            FROM messages m
            JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
            LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
            WHERE m.id = ? AND ${VISIBLE_TO_REPORTER}
        `, [reporterId, reporterId, input.messageId]);

        if (!message) return { error: { status: 404, message: 'Message not found' } };
        if (message.message_type === 'system') return { error: { status: 400, message: 'Chat notices can\'t be reported' } };
        if (Number(message.sender_id) === Number(reporterId)) {
            return { error: { status: 400, message: 'You can\'t report your own message' } };
        }
        return { target: { messageId: Number(message.id), chatId: Number(message.chat_id), userId: Number(message.sender_id) } };
    }

    const userId = Number(input.userId);
    if (userId === Number(reporterId)) return { error: { status: 400, message: 'You can\'t report yourself' } };

    // People you share a chat with: anyone else has nothing to report, and ids stay unprobeable
    const shared = await queryOne(`
        SELECT mine.chat_id
        FROM group_members mine
        JOIN group_members other ON other.chat_id = mine.chat_id
        WHERE mine.user_id = ? AND other.user_id = ?
        LIMIT 1
    `, [reporterId, userId]);
    if (!shared) return { error: { status: 404, message: 'User not found' } };

    if (input.chatId) {
        const [mine, theirs] = await Promise.all([getMembership(input.chatId, reporterId), getMembership(input.chatId, userId)]);
        if (!mine || !theirs) return { error: { status: 404, message: 'Chat not found' } };
    }
    return { target: { messageId: null, chatId: input.chatId ? Number(input.chatId) : null, userId } };
}

/**
 * File a report. A second report of the same thing while the first is open returns the first.
 * @param {Object} input - { targetType, messageId?, userId?, chatId?, reason, note? }
 * @returns {Promise<{ reportId, reportedUserId, duplicate } | { error }>}
 */
async function fileReport(reporterId, input) {
    const { target, error } = await resolveTarget(reporterId, input);
    if (error) return { error };

    const existing = target.messageId
        ? await queryOne("SELECT id FROM reports WHERE reporter_id = ? AND message_id = ? AND status = 'open'", [reporterId, target.messageId])
        : await queryOne("SELECT id FROM reports WHERE reporter_id = ? AND reported_user_id = ? AND target_type = 'user' AND status = 'open'", [reporterId, target.userId]);
    if (existing) return { reportId: Number(existing.id), reportedUserId: target.userId, duplicate: true };

    // Read before anything is written: a report never exists without its evidence
    let rows = [];
    if (target.messageId) rows = await collectAroundMessage(reporterId, target.chatId, target.messageId);
    else if (target.chatId) rows = (await readMessages(reporterId, target.chatId, '', null, 'DESC', EVIDENCE_CONTEXT_MESSAGES)).reverse();

    const reported = rows.find(row => row.is_reported);
    if (reported) reported.evidence_path = await copyAttachment(reported);

    let reportId;
    try {
        reportId = await insertAndGetId(
            'INSERT INTO reports (reporter_id, reported_user_id, target_type, message_id, chat_id, reason, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [reporterId, target.userId, input.targetType, target.messageId, target.chatId, input.reason, input.note || null]
        );
        await saveEvidence(reportId, rows);
    } catch (saveError) {
        if (reportId) await executeQuery('DELETE FROM reports WHERE id = ?', [reportId]).catch(() => {});
        if (reported && reported.evidence_path) await fs.promises.unlink(reported.evidence_path).catch(() => {});
        throw saveError;
    }

    return { reportId: Number(reportId), reportedUserId: target.userId, duplicate: false };
}

function shapeReport(row) {
    return {
        id: Number(row.id),
        targetType: row.target_type,
        reason: row.reason,
        note: row.note || null,
        status: row.status,
        resolution: row.resolution || null,
        messageId: row.message_id === null ? null : Number(row.message_id),
        chatId: row.chat_id === null ? null : Number(row.chat_id),
        reporter: row.reporter_id === null ? null : { id: Number(row.reporter_id), username: row.reporter_username },
        reportedUser: row.reported_user_id === null ? null : {
            id: Number(row.reported_user_id),
            username: row.reported_username,
            suspended: !!row.reported_suspended_at
        },
        reviewedBy: row.reviewer_username || null,
        reviewedAt: row.reviewed_at || null,
        createdAt: row.created_at
    };
}

const REPORT_SELECT = `
    SELECT r.id, r.target_type, r.reason, r.note, r.status, r.resolution, r.message_id, r.chat_id,
           r.reporter_id, reporter.username AS reporter_username,
           r.reported_user_id, reported.username AS reported_username, reported.suspended_at AS reported_suspended_at,
           reviewer.username AS reviewer_username, r.reviewed_at, r.created_at
    FROM reports r
    LEFT JOIN users reporter ON reporter.id = r.reporter_id
    LEFT JOIN users reported ON reported.id = r.reported_user_id
    LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by`;

/**
 * Newest first, optionally one status. before is the id cursor for the next page.
 */
async function listReports({ status, before } = {}) {
    const where = [];
    const params = [];
    if (status) {
        where.push('r.status = ?');
        params.push(status);
    }
    if (before) {
        where.push('r.id < ?');
        params.push(before);
    }
    const rows = await executeQuery(`${REPORT_SELECT}
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.id DESC
        LIMIT ${ADMIN_PAGE_SIZE + 1}
    `, params);

    const page = rows.slice(0, ADMIN_PAGE_SIZE).map(shapeReport);
    return { reports: page, nextCursor: rows.length > ADMIN_PAGE_SIZE ? page[page.length - 1].id : null };
}

/**
 * One report with its evidence
 */
async function getReport(reportId) {
    const row = await queryOne(`${REPORT_SELECT} WHERE r.id = ?`, [reportId]);
    if (!row) return null;

    const evidence = await executeQuery(
        `SELECT id, ${EVIDENCE_COLUMNS} FROM report_evidence WHERE report_id = ? ORDER BY position ASC`,
        [reportId]
    );
    return {
        ...shapeReport(row),
        evidence: evidence.map(item => ({
            id: Number(item.id),
            isReported: toBool(item.is_reported),
            messageId: Number(item.message_id),
            senderId: item.sender_id === null ? null : Number(item.sender_id),
            senderUsername: item.sender_username || null,
            messageType: item.message_type,
            content: item.content,
            fileName: item.file_name || null,
            fileMime: item.file_mime || null,
            fileSize: item.file_size === null ? null : Number(item.file_size),
            hasFile: !!item.evidence_path,
            sentAt: item.sent_at
        }))
    };
}

/**
 * Where a stored evidence file is, only if it really sits in the evidence folder
 * @returns {Promise<{ fullPath, fileName } | null>}
 */
async function findEvidenceFile(reportId, evidenceId) {
    const row = await queryOne(
        'SELECT evidence_path, file_name FROM report_evidence WHERE id = ? AND report_id = ?',
        [evidenceId, reportId]
    );
    if (!row || !row.evidence_path) return null;
    const fullPath = path.resolve(row.evidence_path);
    return isInsideDir(evidenceDir(), fullPath) ? { fullPath, fileName: row.file_name } : null;
}

/**
 * Record the outcome. status 'dismissed' or 'actioned'; resolution says what was done last.
 * @returns {Promise<boolean>} false if there's no such report
 */
async function resolveReport(reportId, adminId, status, resolution) {
    const changed = await updateAndCount(
        'UPDATE reports SET status = ?, resolution = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, resolution, adminId, reportId]
    );
    return changed > 0;
}

module.exports = {
    fileReport,
    listReports,
    getReport,
    findEvidenceFile,
    resolveReport
};
