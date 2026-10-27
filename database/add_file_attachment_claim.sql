-- Security fix: uploads are attached to messages by file id only (MySQL)
-- Run once after add_message_actions.sql.

-- When the file was attached to its first message. NULL = uploaded but not sent yet;
-- only the uploader can attach it, and only once (forwarding reuses the row afterwards).
ALTER TABLE files
    ADD COLUMN attached_at TIMESTAMP NULL DEFAULT NULL;

-- Every existing row counts as attached, so no older file (including any written from
-- client-supplied paths before this fix) can be claimed by a new send.
UPDATE files SET attached_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP) WHERE attached_at IS NULL;
