-- One reaction per user per message (MySQL), matching PostgreSQL's UNIQUE (message_id, user_id)
-- Replaces the old UNIQUE KEY unique_user_message_emoji (message_id, user_id, emoji), which let a
-- user stack several emojis on one message.
-- Run after add_mentions_and_link_previews.sql. Safe to run more than once (each step checks
-- information_schema first; MySQL has no ADD INDEX IF NOT EXISTS).

-- Keep only the newest reaction (highest id) per user and message
DELETE r_old FROM message_reactions r_old
JOIN message_reactions r_new
    ON r_new.message_id = r_old.message_id
   AND r_new.user_id = r_old.user_id
   AND r_new.id > r_old.id;

-- Add the new key before dropping the old one, so the message_id foreign key always has an index
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_reactions' AND INDEX_NAME = 'unique_user_message') = 0,
    'ALTER TABLE message_reactions ADD UNIQUE KEY unique_user_message (message_id, user_id)',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_reactions' AND INDEX_NAME = 'unique_user_message_emoji') > 0,
    'ALTER TABLE message_reactions DROP INDEX unique_user_message_emoji',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
