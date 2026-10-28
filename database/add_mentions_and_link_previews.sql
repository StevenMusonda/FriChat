-- Phase 4: @mentions, per-chat "mentions only" notifications and link previews (MySQL)
-- Run once after add_file_attachment_claim.sql.

-- Who a message mentions (group chats only; resolved against the chat's members when sent or edited)
CREATE TABLE IF NOT EXISTS message_mentions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_message_mention (message_id, user_id),
    INDEX idx_mentions_user_message (user_id, message_id)
);

-- Per member: push only for messages that mention them. Mentions also get through a mute when this is on.
ALTER TABLE group_members
    ADD COLUMN mentions_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Server-side Open Graph cache, one row per URL (url_hash = SHA-256 of the URL, for a short UNIQUE key).
-- status 'failed' rows remember URLs that gave no preview, so they aren't fetched on every message.
CREATE TABLE IF NOT EXISTS link_previews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    url_hash CHAR(64) NOT NULL,
    url TEXT NOT NULL,
    status VARCHAR(10) NOT NULL,
    title VARCHAR(300) NULL,
    description VARCHAR(500) NULL,
    image_url TEXT NULL,
    site_name VARCHAR(200) NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_link_preview_url (url_hash)
);

-- The preview shown under a message; dismissed = the sender removed it (it is never re-attached)
ALTER TABLE messages
    ADD COLUMN link_preview_id INT NULL,
    ADD COLUMN link_preview_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT fk_messages_link_preview FOREIGN KEY (link_preview_id) REFERENCES link_previews(id) ON DELETE SET NULL;
