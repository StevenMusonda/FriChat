-- Phase 9: profiles (bio, custom status), privacy settings and message requests (MySQL)
-- Run once after add_polls_and_scheduling.sql.
--
-- custom_status_expires_at is TIMESTAMP NULL DEFAULT NULL on purpose (see add_polls_and_scheduling.sql);
-- the application writes it as CURRENT_TIMESTAMP + INTERVAL n SECOND.

ALTER TABLE users
    ADD COLUMN bio VARCHAR(160) NULL AFTER avatar_url,
    ADD COLUMN custom_status_text VARCHAR(80) NULL AFTER bio,
    ADD COLUMN custom_status_emoji VARCHAR(16) NULL AFTER custom_status_text,
    ADD COLUMN custom_status_expires_at TIMESTAMP NULL DEFAULT NULL AFTER custom_status_emoji; -- NULL = until cleared

-- Who sees what (no row = everyone sees everything, receipts and typing on).
-- Audiences: 'everyone' | 'contacts' (people you share an accepted chat with) | 'nobody'
CREATE TABLE IF NOT EXISTS privacy_settings (
    user_id INT PRIMARY KEY,
    last_seen_audience VARCHAR(10) NOT NULL DEFAULT 'everyone', -- online status and last seen
    photo_audience VARCHAR(10) NOT NULL DEFAULT 'everyone',
    bio_audience VARCHAR(10) NOT NULL DEFAULT 'everyone', -- bio and custom status
    groups_audience VARCHAR(10) NOT NULL DEFAULT 'everyone', -- who can add you to groups
    read_receipts BOOLEAN NOT NULL DEFAULT TRUE, -- off: others don't see your reads, you don't see theirs
    typing_indicators BOOLEAN NOT NULL DEFAULT TRUE, -- off: others don't see you typing
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A direct chat started by someone who shared no chat with the recipient (one row per chat)
CREATE TABLE IF NOT EXISTS message_requests (
    chat_id INT PRIMARY KEY,
    requester_id INT NOT NULL,
    recipient_id INT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | accepted | deleted | blocked
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_message_requests_recipient (recipient_id, status)
);
