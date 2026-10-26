-- Phase 3: reply/quote, edit, forward and starred messages (PostgreSQL)
-- Run after add_push_notifications_postgresql.sql. Safe to run more than once.

-- The message this one quotes. SET NULL so removing a chat's messages never fails on a reply.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL;
-- NULL = never edited
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP NULL;
-- Copied from another message; the label is all that's shown, the source isn't exposed
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-user stars
CREATE TABLE IF NOT EXISTS starred_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_starred_message_id ON starred_messages(message_id);
