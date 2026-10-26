-- Phase 3: reply/quote, edit, forward and starred messages (MySQL)
-- Run once after add_push_notifications.sql.

ALTER TABLE messages
    -- The message this one quotes. SET NULL so removing a chat's messages never fails on a reply.
    ADD COLUMN reply_to_message_id INT NULL,
    -- NULL = never edited
    ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL,
    -- Copied from another message; the label is all that's shown, the source isn't exposed
    ADD COLUMN is_forwarded BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT fk_messages_reply_to FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL;

-- Per-user stars
CREATE TABLE IF NOT EXISTS starred_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    message_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_star (user_id, message_id),
    INDEX idx_starred_message_id (message_id)
);
