-- Phase 4: @mentions, per-chat "mentions only" notifications and link previews (PostgreSQL)
-- Run after add_file_attachment_claim_postgresql.sql. Safe to run more than once.

-- Who a message mentions (group chats only; resolved against the chat's members when sent or edited)
CREATE TABLE IF NOT EXISTS message_mentions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mentions_user_message ON message_mentions(user_id, message_id);

-- Per member: push only for messages that mention them. Mentions also get through a mute when this is on.
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS mentions_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Server-side Open Graph cache, one row per URL (url_hash = SHA-256 of the URL, same as MySQL).
-- status 'failed' rows remember URLs that gave no preview, so they aren't fetched on every message.
CREATE TABLE IF NOT EXISTS link_previews (
    id SERIAL PRIMARY KEY,
    url_hash CHAR(64) NOT NULL UNIQUE,
    url TEXT NOT NULL,
    status VARCHAR(10) NOT NULL,
    title VARCHAR(300) NULL,
    description VARCHAR(500) NULL,
    image_url TEXT NULL,
    site_name VARCHAR(200) NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The preview shown under a message; dismissed = the sender removed it (it is never re-attached)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview_id INTEGER NULL REFERENCES link_previews(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview_dismissed BOOLEAN NOT NULL DEFAULT FALSE;
