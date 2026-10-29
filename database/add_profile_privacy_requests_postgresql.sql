-- Phase 9: profiles (bio, custom status), privacy settings and message requests (PostgreSQL)
-- Run after add_polls_and_scheduling_postgresql.sql. Safe to run more than once.
--
-- The application writes custom_status_expires_at as CURRENT_TIMESTAMP + n seconds.

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(160) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status_text VARCHAR(80) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status_emoji VARCHAR(16) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status_expires_at TIMESTAMP NULL; -- NULL = until cleared

-- Who sees what (no row = everyone sees everything, receipts and typing on).
-- Audiences: 'everyone' | 'contacts' (people you share an accepted chat with) | 'nobody'
CREATE TABLE IF NOT EXISTS privacy_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seen_audience VARCHAR(10) NOT NULL DEFAULT 'everyone', -- online status and last seen
    photo_audience VARCHAR(10) NOT NULL DEFAULT 'everyone',
    bio_audience VARCHAR(10) NOT NULL DEFAULT 'everyone', -- bio and custom status
    groups_audience VARCHAR(10) NOT NULL DEFAULT 'everyone', -- who can add you to groups
    read_receipts BOOLEAN NOT NULL DEFAULT TRUE, -- off: others don't see your reads, you don't see theirs
    typing_indicators BOOLEAN NOT NULL DEFAULT TRUE, -- off: others don't see you typing
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A direct chat started by someone who shared no chat with the recipient (one row per chat)
CREATE TABLE IF NOT EXISTS message_requests (
    chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | accepted | deleted | blocked
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_message_requests_recipient ON message_requests(recipient_id, status);
