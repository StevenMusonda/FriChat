-- Security fix: uploads are attached to messages by file id only (PostgreSQL)
-- Run after add_message_actions_postgresql.sql. Safe to run more than once.

-- When the file was attached to its first message. NULL = uploaded but not sent yet;
-- only the uploader can attach it, and only once (forwarding reuses the row afterwards).
ALTER TABLE files ADD COLUMN IF NOT EXISTS attached_at TIMESTAMP NULL;

-- Every existing row counts as attached, so no older file (including any written from
-- client-supplied paths before this fix) can be claimed by a new send.
-- Only touches rows from before this migration: re-running it right after it ran is a no-op
-- because there are no unattached rows yet.
UPDATE files SET attached_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP) WHERE attached_at IS NULL;
