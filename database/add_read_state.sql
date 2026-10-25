-- Phase 1: per-user read position, mute and archive (MySQL)
-- Run once after schema.sql and schema_updates.sql.

ALTER TABLE group_members
    ADD COLUMN last_read_message_id INT NULL,
    -- NULL = not muted; '9999-12-31' = muted until unmuted ("always"). DATETIME because TIMESTAMP stops at 2038.
    ADD COLUMN muted_until DATETIME NULL,
    -- NULL = in the main list
    ADD COLUMN archived_at DATETIME NULL;

-- Treat everything that already exists as read, so upgrading doesn't flood every chat with unread badges
UPDATE group_members gm
SET last_read_message_id = (SELECT MAX(m.id) FROM messages m WHERE m.chat_id = gm.chat_id)
WHERE gm.last_read_message_id IS NULL;

-- Cursor pagination (WHERE chat_id = ? AND id < ? ORDER BY id DESC) and unread counts (id > last_read)
CREATE INDEX idx_msg_chat_id_id ON messages(chat_id, id);
