/**
 * Audit log: an append-only record of security-relevant events.
 *
 * This module is the only code that touches audit_log, and it only INSERTs and SELECTs: there is
 * deliberately no update or delete path (test/phase13.test.js fails if one appears). Rows have no
 * foreign keys, so they outlive the accounts they mention. metadata never holds passwords, tokens
 * or message text.
 *
 * record() never throws: a failed audit write is logged, and must not fail the sign-in or action
 * that caused it.
 */

const { executeQuery, insertAndGetId } = require('../config/database');
const { AUDIT_EVENTS, ADMIN_PAGE_SIZE } = require('../config/moderation');
const { normalizeIp } = require('./sessions');

const MAX_METADATA_LENGTH = 2000;

/**
 * @param {string} event - one of AUDIT_EVENTS
 * @param {Object} entry - { actorId?, targetType?, targetId?, ip?, metadata? }
 */
async function record(event, { actorId = null, targetType = null, targetId = null, ip = null, metadata = null } = {}) {
    try {
        if (!AUDIT_EVENTS.includes(event)) {
            console.error(`Unknown audit event "${event}"`);
            return;
        }
        const json = metadata ? JSON.stringify(metadata).slice(0, MAX_METADATA_LENGTH) : null;
        await insertAndGetId(
            'INSERT INTO audit_log (event, actor_id, target_type, target_id, ip_address, metadata) VALUES (?, ?, ?, ?, ?, ?)',
            [event, actorId, targetType, targetId, ip ? String(ip).slice(0, 45) : null, json]
        );
    } catch (error) {
        console.error(`Audit log write failed for "${event}":`, error.message);
    }
}

/**
 * record() for an HTTP request: the signed-in user is the actor, and the IP comes from req
 */
function recordRequest(req, event, entry = {}) {
    return record(event, {
        actorId: req.user ? req.user.id : null,
        ip: normalizeIp(req.ip),
        ...entry
    });
}

function shapeEntry(row) {
    let metadata = null;
    if (row.metadata) {
        try {
            metadata = JSON.parse(row.metadata);
        } catch (error) {
            metadata = null; // cut off at MAX_METADATA_LENGTH
        }
    }
    return {
        id: Number(row.id),
        event: row.event,
        actorId: row.actor_id === null ? null : Number(row.actor_id),
        actorUsername: row.actor_username || null,
        targetType: row.target_type,
        targetId: row.target_id === null ? null : Number(row.target_id),
        ipAddress: row.ip_address,
        metadata,
        createdAt: row.created_at
    };
}

/**
 * Newest first. Filters: event, actorId, targetType, targetId, ip, q (actor's username, or a word in
 * the metadata), from/to (YYYY-MM-DD, inclusive). before is the id cursor for the next page.
 */
async function search({ event, actorId, targetType, targetId, ip, q, from, to, before } = {}) {
    const where = [];
    const params = [];
    const add = (sql, ...values) => {
        where.push(sql);
        params.push(...values);
    };

    if (event) add('a.event = ?', event);
    if (actorId) add('a.actor_id = ?', actorId);
    if (targetType) add('a.target_type = ?', targetType);
    if (targetId) add('a.target_id = ?', targetId);
    if (ip) add('a.ip_address = ?', ip);
    if (q) {
        const like = `%${String(q).toLowerCase().replace(/[|%_]/g, '|$&')}%`;
        add("(LOWER(u.username) LIKE ? ESCAPE '|' OR LOWER(a.metadata) LIKE ? ESCAPE '|')", like, like);
    }
    if (from) add('a.created_at >= CAST(? AS DATE)', from);
    if (to) {
        const dayAfter = new Date(`${to}T00:00:00Z`);
        dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
        add('a.created_at < CAST(? AS DATE)', dayAfter.toISOString().slice(0, 10));
    }
    if (before) add('a.id < ?', before);

    // The page size is a constant, inlined because mysql2 rejects a bound LIMIT on some servers
    const rows = await executeQuery(`
        SELECT a.id, a.event, a.actor_id, u.username AS actor_username, a.target_type, a.target_id,
               a.ip_address, a.metadata, a.created_at
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.id DESC
        LIMIT ${ADMIN_PAGE_SIZE + 1}
    `, params);

    const page = rows.slice(0, ADMIN_PAGE_SIZE).map(shapeEntry);
    return {
        entries: page,
        nextCursor: rows.length > ADMIN_PAGE_SIZE ? page[page.length - 1].id : null
    };
}

module.exports = { record, recordRequest, search };
