/**
 * Birthdays (phase 12): an optional day and month (year optional) on the profile, and who may see
 * it: privacy_settings.birthday_audience ('everyone' | 'contacts' | 'nobody', default 'contacts').
 * The year is only ever shown to its owner. Someone who blocked the viewer is "nobody" for them.
 *
 * In group chats the clients ask for the members whose birthday is "today" in the viewer's own
 * timezone (they send their local date); 29 February birthdays count on 28 February in other years.
 * Kept apart from utils/privacy.js so the phase 9 settings queries stay as they are.
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const { AUDIENCES } = require('../config/profile');
const { getMembership } = require('./groups');
const { getBlockerIds } = require('./blocks');
const { isContact } = require('./privacy');
const { BIRTHDAY_DATE_SLACK_DAYS, BIRTHDAY_MIN_YEAR } = require('../config/planning');

const DEFAULT_AUDIENCE = 'contacts';
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(month, year = null) {
    if (month === 2) return year === null || isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A real calendar day; without a year 29 February is allowed
 * @returns {null | string} what's wrong, or null
 */
function checkBirthday(day, month, year = null, now = new Date()) {
    if (!Number.isInteger(month) || month < 1 || month > 12) return 'Pick a month';
    if (year !== null && (!Number.isInteger(year) || year < BIRTHDAY_MIN_YEAR || year > now.getUTCFullYear())) {
        return `The year must be between ${BIRTHDAY_MIN_YEAR} and ${now.getUTCFullYear()}`;
    }
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth(month, year)) return 'That day is not in that month';
    return null;
}

function audienceOf(row) {
    return row && AUDIENCES.includes(row.birthday_audience) ? row.birthday_audience : DEFAULT_AUDIENCE;
}

async function getBirthdayRow(userId) {
    return queryOne(`
        SELECT u.id, u.birthday_day, u.birthday_month, u.birthday_year, ps.birthday_audience
        FROM users u
        LEFT JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE u.id = ?
    `, [userId]);
}

async function getBirthdayAudience(userId) {
    const row = await queryOne('SELECT birthday_audience FROM privacy_settings WHERE user_id = ?', [userId]);
    return audienceOf(row);
}

/**
 * The owner's own birthday: { day, month, year } or null
 */
async function getOwnBirthday(userId) {
    const row = await getBirthdayRow(userId);
    if (!row || !row.birthday_day || !row.birthday_month) return null;
    return {
        day: Number(row.birthday_day),
        month: Number(row.birthday_month),
        year: row.birthday_year ? Number(row.birthday_year) : null
    };
}

/**
 * What a viewer may see of someone's birthday: { day, month } (plus year for the owner), or null
 */
async function visibleBirthday(viewerId, userId) {
    if (Number(viewerId) === Number(userId)) return getOwnBirthday(userId);
    const row = await getBirthdayRow(userId);
    if (!row || !row.birthday_day || !row.birthday_month) return null;

    const audience = audienceOf(row);
    if (audience === 'nobody') return null;
    if ((await getBlockerIds(viewerId)).has(Number(userId))) return null;
    if (audience === 'contacts' && !(await isContact(viewerId, userId))) return null;
    return { day: Number(row.birthday_day), month: Number(row.birthday_month) };
}

async function saveBirthday(userId, { day, month, year = null }) {
    await executeQuery(
        'UPDATE users SET birthday_day = ?, birthday_month = ?, birthday_year = ? WHERE id = ?',
        [day, month, year, userId]
    );
}

async function clearBirthday(userId) {
    await executeQuery(
        'UPDATE users SET birthday_day = NULL, birthday_month = NULL, birthday_year = NULL WHERE id = ?',
        [userId]
    );
}

async function saveBirthdayAudience(userId, audience) {
    const insert = 'INSERT INTO privacy_settings (user_id, birthday_audience) VALUES (?, ?)';
    await executeQuery(dbType === 'postgresql'
        ? `${insert} ON CONFLICT (user_id) DO UPDATE SET birthday_audience = EXCLUDED.birthday_audience, updated_at = CURRENT_TIMESTAMP`
        : `${insert} ON DUPLICATE KEY UPDATE birthday_audience = VALUES(birthday_audience)`,
    [userId, audience]);
}

/**
 * "2026-10-30" -> { year, month, day } if it is a real date within a day or so of today (UTC)
 */
function parseViewerDate(value, now = new Date()) {
    const match = DATE_PATTERN.exec(String(value || ''));
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return null;
    const asUtc = Date.UTC(year, month - 1, day);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (Math.abs(asUtc - today) > BIRTHDAY_DATE_SLACK_DAYS * 24 * 60 * 60 * 1000) return null;
    return { year, month, day };
}

/**
 * Members of a group whose birthday is on the viewer's date, as far as the viewer may see them
 * @returns {{ birthdays: Array<{ userId, username, name, isSelf }> } | { error }}
 */
async function birthdaysInChat(viewerId, chatId, dateValue, now = new Date()) {
    const membership = await getMembership(chatId, viewerId);
    if (!membership) return { error: { status: 403, message: 'Access denied to this chat' } };
    const date = parseViewerDate(dateValue, now);
    if (!date) return { error: { status: 400, message: 'date must be your local date (YYYY-MM-DD)' } };
    // Banners are for groups; a direct chat shows the birthday on the profile card
    if (membership.chat_type !== 'group') return { birthdays: [] };

    // 29 February birthdays are celebrated on 28 February in other years
    const days = date.month === 2 && date.day === 28 && !isLeapYear(date.year) ? [28, 29] : [date.day, date.day];
    const rows = await executeQuery(`
        SELECT u.id, u.username, u.full_name, ps.birthday_audience
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        LEFT JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE gm.chat_id = ? AND u.birthday_month = ? AND u.birthday_day IN (?, ?)
        ORDER BY u.id
    `, [chatId, date.month, days[0], days[1]]);
    if (rows.length === 0) return { birthdays: [] };

    // Everyone in a group with the viewer is a contact, so only 'nobody' and blocks hide it here
    const blockers = await getBlockerIds(viewerId);
    const birthdays = rows
        .filter(row => Number(row.id) === Number(viewerId)
            || (audienceOf(row) !== 'nobody' && !blockers.has(Number(row.id))))
        .map(row => ({
            userId: Number(row.id),
            username: row.username,
            name: row.full_name || row.username,
            isSelf: Number(row.id) === Number(viewerId)
        }));
    return { birthdays };
}

module.exports = {
    DEFAULT_AUDIENCE,
    isLeapYear,
    checkBirthday,
    getBirthdayAudience,
    getOwnBirthday,
    visibleBirthday,
    saveBirthday,
    clearBirthday,
    saveBirthdayAudience,
    parseViewerDate,
    birthdaysInChat
};
