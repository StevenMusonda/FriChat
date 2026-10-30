-- Phase 12: events with RSVPs and reminders, shared lists, birthdays (PostgreSQL)
-- Run after add_calls_postgresql.sql. Safe to run more than once.
-- Run it with psql -f (autocommit): ALTER TYPE ... ADD VALUE can't run inside a transaction block before PostgreSQL 12.
--
-- The application writes the time columns as CURRENT_TIMESTAMP + n seconds, so they compare
-- cleanly with CURRENT_TIMESTAMP whatever timezone Node or the database runs in.

-- An event is announced by a chat message of type 'event' (its text is the title)
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'event';

CREATE TABLE IF NOT EXISTS chat_events (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL, -- the card; NULL once that message is gone
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    description TEXT NULL,
    location VARCHAR(200) NULL,
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', -- IANA zone the creator planned it in (shown next to the time)
    status VARCHAR(10) NOT NULL DEFAULT 'active', -- active | cancelled
    cancelled_at TIMESTAMP NULL,
    revision INTEGER NOT NULL DEFAULT 0,  -- bumped on every edit (the .ics SEQUENCE)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_events_chat ON chat_events(chat_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_chat_events_message ON chat_events(message_id);

-- One answer per member: going | maybe | declined (no row = no answer yet)
CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id INTEGER NOT NULL REFERENCES chat_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    response VARCHAR(8) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id)
);

-- Reminders the creator picked (at start, 1 hour before, 1 day before), fired by the scheduler
CREATE TABLE IF NOT EXISTS event_reminders (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES chat_events(id) ON DELETE CASCADE,
    offset_seconds INTEGER NOT NULL,      -- 0, 3600 or 86400 before the start
    remind_at TIMESTAMP NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | fired | skipped (time had passed) | cancelled
    fired_at TIMESTAMP NULL,
    UNIQUE (event_id, offset_seconds)
);

CREATE INDEX IF NOT EXISTS idx_event_reminders_due ON event_reminders(status, remind_at);

-- Named checklists in a chat (shopping list, to-do)
CREATE TABLE IF NOT EXISTS chat_lists (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_lists_chat ON chat_lists(chat_id);

CREATE TABLE IF NOT EXISTS chat_list_items (
    id SERIAL PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES chat_lists(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, -- same as the list's
    text VARCHAR(300) NOT NULL,
    created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    done_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL, -- who ticked it
    done_at TIMESTAMP NULL,
    due_at TIMESTAMP NULL,
    due_set_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL, -- gets the due-date reminder
    due_reminder_status VARCHAR(10) NOT NULL DEFAULT 'none', -- none | pending | fired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_list_items_list ON chat_list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_list_items_due ON chat_list_items(due_reminder_status, due_at);

-- Birthday: day and month, year optional (never shown to anyone else)
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_day SMALLINT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_month SMALLINT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_year SMALLINT NULL;

-- Who sees the birthday (and its banner in shared groups); existing rows get 'contacts'
ALTER TABLE privacy_settings ADD COLUMN IF NOT EXISTS birthday_audience VARCHAR(10) NOT NULL DEFAULT 'contacts';
