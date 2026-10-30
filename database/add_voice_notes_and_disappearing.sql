-- Phase 10: voice notes and disappearing messages (MySQL)
-- Run once after add_profile_privacy_requests.sql.
--
-- expires_at is TIMESTAMP NULL DEFAULT NULL on purpose (see add_polls_and_scheduling.sql); the
-- application writes it as CURRENT_TIMESTAMP + INTERVAL chats.disappearing_seconds SECOND.

-- 'voice': a recorded voice note (audio file + duration and waveform on its files row)
-- 'system': a notice in the thread, e.g. "Alice turned on disappearing messages" (content is a code)
ALTER TABLE messages MODIFY message_type ENUM('text', 'image', 'video', 'file', 'poll', 'voice', 'system') NOT NULL;

-- When the scheduler deletes the message (and its file); NULL = never
ALTER TABLE messages ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL AFTER link_preview_dismissed;
CREATE INDEX idx_messages_expires_at ON messages(expires_at);

-- Disappearing-messages timer for new messages: NULL/0 = off, else 86400 | 604800 | 7776000
ALTER TABLE chats ADD COLUMN disappearing_seconds INT NULL DEFAULT NULL AFTER announcement_only;

-- Voice notes: measured by the recording browser
ALTER TABLE files
    ADD COLUMN duration_ms INT NULL DEFAULT NULL AFTER attached_at,
    ADD COLUMN waveform VARCHAR(400) NULL DEFAULT NULL AFTER duration_ms; -- comma-separated levels 0-100

-- Who has played a voice note (the sender sees "played")
CREATE TABLE IF NOT EXISTS voice_note_plays (
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
