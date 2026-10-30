-- Phase 10: voice notes and disappearing messages (PostgreSQL)
-- Run after add_profile_privacy_requests_postgresql.sql. Safe to run more than once.
-- Run it with psql -f (autocommit): ALTER TYPE ... ADD VALUE can't run inside a transaction block before PostgreSQL 12.
--
-- The application writes expires_at as CURRENT_TIMESTAMP + chats.disappearing_seconds seconds.

-- 'voice': a recorded voice note (audio file + duration and waveform on its files row)
-- 'system': a notice in the thread, e.g. "Alice turned on disappearing messages" (content is a code)
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'voice';
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'system';

-- When the scheduler deletes the message (and its file); NULL = never
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL;
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);

-- Disappearing-messages timer for new messages: NULL/0 = off, else 86400 | 604800 | 7776000
ALTER TABLE chats ADD COLUMN IF NOT EXISTS disappearing_seconds INTEGER NULL;

-- Voice notes: measured by the recording browser
ALTER TABLE files ADD COLUMN IF NOT EXISTS duration_ms INTEGER NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS waveform VARCHAR(400) NULL; -- comma-separated levels 0-100

-- Who has played a voice note (the sender sees "played")
CREATE TABLE IF NOT EXISTS voice_note_plays (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);
