-- Phase 8: polls, scheduled messages and message reminders (PostgreSQL)
-- Run after add_message_search_postgresql.sql. Safe to run more than once.
-- Run it with psql -f (autocommit): ALTER TYPE ... ADD VALUE can't run inside a transaction block before PostgreSQL 12.
--
-- The application always writes the time columns as CURRENT_TIMESTAMP + n seconds, so they compare
-- cleanly with CURRENT_TIMESTAMP whatever timezone Node or the database runs in.

-- A poll is a chat message of type 'poll' (its text is the question)
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'poll';

CREATE TABLE IF NOT EXISTS polls (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question VARCHAR(300) NOT NULL,
    multiple_choice BOOLEAN NOT NULL DEFAULT FALSE,
    anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    closes_at TIMESTAMP NULL, -- optional automatic close
    closed_at TIMESTAMP NULL, -- set when closed (by the creator or at closes_at)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_polls_open_closing ON polls(closed_at, closes_at);

CREATE TABLE IF NOT EXISTS poll_options (
    id SERIAL PRIMARY KEY,
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    option_text VARCHAR(100) NOT NULL,
    UNIQUE (poll_id, position)
);

-- choice_slot is 0 for every vote in a single-choice poll and the option id in a multiple-choice poll,
-- so (poll_id, user_id, choice_slot) makes the database itself refuse a second single-choice vote
CREATE TABLE IF NOT EXISTS poll_votes (
    id SERIAL PRIMARY KEY,
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    choice_slot INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (option_id, user_id), -- one vote per option per user
    UNIQUE (poll_id, user_id, choice_slot) -- single-choice rule
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);

-- Messages waiting to be sent by the scheduler (survive restarts: the scheduler reads this table)
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    reply_to_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL,
    send_at TIMESTAMP NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | cancelled
    failure_reason VARCHAR(255) NULL,
    sent_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMP NULL, -- when the scheduler took it (status 'sending')
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_messages(user_id, status);

-- "Remind me" on a message: private to the user who set it
CREATE TABLE IF NOT EXISTS message_reminders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    remind_at TIMESTAMP NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | fired | cancelled (dismissing a reminder deletes the row)
    fired_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON message_reminders(status, remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON message_reminders(user_id, status);
