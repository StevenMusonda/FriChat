/**
 * Per-user do-not-disturb: a manual toggle plus an optional daily quiet-hours window
 * (stored in notification_settings; no row means notifications are on)
 */

const { executeQuery, queryOne, dbType } = require('../config/database');

const DEFAULT_SETTINGS = {
    dndEnabled: false,
    quietHoursEnabled: false,
    quietStart: null,
    quietEnd: null,
    timezone: 'UTC'
};

/**
 * True if Intl knows this IANA timezone name
 */
function isValidTimezone(timezone) {
    if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Minutes since local midnight for 'HH:MM'
 */
function toMinutes(hhmm) {
    const [hours, minutes] = hhmm.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Minutes since midnight in the given timezone at `date`
 */
function localMinutes(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const hour = parseInt(parts.find(p => p.type === 'hour').value);
    const minute = parseInt(parts.find(p => p.type === 'minute').value);
    return hour * 60 + minute;
}

/**
 * Is `date` inside the daily [start, end) window? start > end wraps past midnight (22:00-07:00).
 */
function isInQuietHours(settings, date = new Date()) {
    if (!settings || !settings.quietHoursEnabled || !settings.quietStart || !settings.quietEnd) return false;

    const timezone = isValidTimezone(settings.timezone) ? settings.timezone : 'UTC';
    const now = localMinutes(date, timezone);
    const start = toMinutes(settings.quietStart);
    const end = toMinutes(settings.quietEnd);

    if (start === end) return false;
    return start < end
        ? now >= start && now < end
        : now >= start || now < end;
}

/**
 * Should pushes (and sounds) be suppressed for this user right now?
 */
function isDndActive(settings, date = new Date()) {
    if (!settings) return false;
    return !!settings.dndEnabled || isInQuietHours(settings, date);
}

/**
 * Database row -> API shape (MySQL returns 0/1 for BOOLEAN, PostgreSQL true/false)
 */
function fromRow(row) {
    if (!row) return { ...DEFAULT_SETTINGS };
    const truthy = (value) => value === true || value === 1 || value === '1' || value === 't';
    return {
        dndEnabled: truthy(row.dnd_enabled),
        quietHoursEnabled: truthy(row.quiet_hours_enabled),
        quietStart: row.quiet_start ? String(row.quiet_start).trim() : null,
        quietEnd: row.quiet_end ? String(row.quiet_end).trim() : null,
        timezone: row.timezone || 'UTC'
    };
}

async function getNotificationSettings(userId) {
    const row = await queryOne(
        'SELECT dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone FROM notification_settings WHERE user_id = ?',
        [userId]
    );
    return fromRow(row);
}

/**
 * Merge `changes` (already validated) into the stored settings and save
 */
async function saveNotificationSettings(userId, changes) {
    const next = { ...(await getNotificationSettings(userId)), ...changes };
    const params = [userId, !!next.dndEnabled, !!next.quietHoursEnabled, next.quietStart, next.quietEnd, next.timezone];

    if (dbType === 'postgresql') {
        await executeQuery(`
            INSERT INTO notification_settings (user_id, dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                dnd_enabled = EXCLUDED.dnd_enabled,
                quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
                quiet_start = EXCLUDED.quiet_start,
                quiet_end = EXCLUDED.quiet_end,
                timezone = EXCLUDED.timezone,
                updated_at = CURRENT_TIMESTAMP
        `, params);
    } else {
        await executeQuery(`
            INSERT INTO notification_settings (user_id, dnd_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                dnd_enabled = VALUES(dnd_enabled),
                quiet_hours_enabled = VALUES(quiet_hours_enabled),
                quiet_start = VALUES(quiet_start),
                quiet_end = VALUES(quiet_end),
                timezone = VALUES(timezone)
        `, params);
    }

    return next;
}

module.exports = {
    DEFAULT_SETTINGS,
    isValidTimezone,
    isInQuietHours,
    isDndActive,
    fromRow,
    getNotificationSettings,
    saveNotificationSettings
};
