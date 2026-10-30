/**
 * An event as an iCalendar file (RFC 5545) for "Add to calendar".
 *
 * Times are written in UTC ("...Z"), which every calendar app reads correctly and shows in the
 * user's own timezone. The creator's zone goes in X-WR-TIMEZONE as a hint only. SEQUENCE is the
 * event's revision, so a re-downloaded file updates the copy already in the calendar (same UID),
 * and a cancelled event comes out with STATUS:CANCELLED.
 */

const { decodeEntities } = require('./push');

function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * ISO instant -> 20261102T080000Z
 */
function icsTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * TEXT value: backslash, semicolon, comma and line breaks escaped (user text can't add properties)
 */
function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\r\n?/g, '\n')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

/**
 * Lines longer than 75 octets are folded (CRLF + space), never inside a UTF-8 character
 */
function foldLine(line) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;
    const parts = [];
    let current = '';
    let currentBytes = 0;
    let limit = 75;
    for (const char of line) {
        const size = Buffer.byteLength(char, 'utf8');
        if (currentBytes + size > limit) {
            parts.push(current);
            current = '';
            currentBytes = 0;
            limit = 74; // continuation lines start with a space
        }
        current += char;
        currentBytes += size;
    }
    if (current) parts.push(current);
    return parts.join('\r\n ');
}

/**
 * Safe file name for Content-Disposition: letters, digits, dashes
 */
function icsFileName(event) {
    const base = String(event.title || 'event')
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60);
    return `${base || 'event'}.ics`;
}

/**
 * @param {Object} event - shapeEvent() output
 * @param {Object} options - { host: domain for the UID, now: Date for DTSTAMP }
 */
function buildIcs(event, { host = 'frichat', now = new Date() } = {}) {
    const organizer = event.createdByName ? decodeEntities(String(event.createdByName)) : null;
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//FriChat//Events//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-TIMEZONE:${escapeText(event.timezone || 'UTC')}`,
        'BEGIN:VEVENT',
        `UID:frichat-event-${Number(event.id)}@${host.replace(/[^A-Za-z0-9.-]/g, '') || 'frichat'}`,
        `DTSTAMP:${icsTime(now.toISOString())}`,
        `DTSTART:${icsTime(event.startsAt)}`,
        `DTEND:${icsTime(event.endsAt)}`,
        `SEQUENCE:${Number(event.revision) || 0}`,
        `SUMMARY:${escapeText(event.title)}`
    ];
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    const description = [event.description, organizer ? `Planned by ${organizer} on FriChat` : null].filter(Boolean).join('\n\n');
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    lines.push(`STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, icsTime, escapeText, foldLine, icsFileName };
