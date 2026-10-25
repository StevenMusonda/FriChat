-- Phase 1: per-user read position, mute and archive (PostgreSQL)
-- Run after schema_postgresql.sql, schema_updates_postgresql.sql and add_message_columns_postgresql.sql.
-- Safe to run more than once.

ALTER TABLE group_members ADD COLUMN IF NOT EXISTS last_read_message_id INTEGER NULL;
-- NULL = not muted; '9999-12-31' = muted until unmuted ("always")
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP NULL;
-- NULL = in the main list
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NULL;

-- Treat everything that already exists as read, so upgrading doesn't flood every chat with unread badges
UPDATE group_members gm
SET last_read_message_id = (SELECT MAX(m.id) FROM messages m WHERE m.chat_id = gm.chat_id)
WHERE gm.last_read_message_id IS NULL;

-- Cursor pagination (WHERE chat_id = ? AND id < ? ORDER BY id DESC) and unread counts (id > last_read)
CREATE INDEX IF NOT EXISTS idx_msg_chat_id_id ON messages(chat_id, id);
