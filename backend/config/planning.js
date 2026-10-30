/**
 * Phase 12 limits: events, shared lists and birthdays.
 * The frontend mirrors some of them (CONFIG.EVENT_* / CONFIG.LIST_*); the server enforces all of them.
 */

module.exports = {
    EVENT_TITLE_MAX_LENGTH: 150,
    EVENT_DESCRIPTION_MAX_LENGTH: 2000,
    EVENT_LOCATION_MAX_LENGTH: 200,
    // How far ahead an event may start, and how long it may last
    EVENT_MAX_DAYS_AHEAD: 730,
    EVENT_MAX_LENGTH_DAYS: 31,
    // Reminder choices (seconds before the start); the creator picks any of them
    EVENT_REMINDER_OFFSETS: { start: 0, '1h': 60 * 60, '1d': 24 * 60 * 60 },
    RSVP_RESPONSES: ['going', 'maybe', 'declined'],
    // Upcoming events per chat, so one member can't fill the scheduler's queue
    MAX_UPCOMING_EVENTS_PER_CHAT: 100,
    EVENT_PAGE_SIZE: 100,

    LIST_NAME_MAX_LENGTH: 100,
    LIST_ITEM_MAX_LENGTH: 300,
    MAX_LISTS_PER_CHAT: 50,
    MAX_ITEMS_PER_LIST: 200,

    // Rows handled per scheduler tick (the rest wait for the next tick)
    PLAN_BATCH_SIZE: 50,

    // A birthday banner is asked for with the viewer's local date; it must be within a day of the
    // server's UTC date (timezones run from UTC-12 to UTC+14)
    BIRTHDAY_DATE_SLACK_DAYS: 1,
    BIRTHDAY_MIN_YEAR: 1900
};
