-- Phase 8: polls, scheduled messages and message reminders (MySQL)
-- Run once after add_message_search.sql.
--
-- Time columns are TIMESTAMP NULL DEFAULT NULL on purpose: with explicit_defaults_for_timestamp=OFF
-- (MySQL 5.7's default) a bare TIMESTAMP NOT NULL column silently gets ON UPDATE CURRENT_TIMESTAMP.
-- The application always sets them, as CURRENT_TIMESTAMP + INTERVAL n SECOND, so they compare
-- cleanly with CURRENT_TIMESTAMP whatever timezone Node or the database runs in.

-- A poll is a chat message of type 'poll' (its text is the question)
ALTER TABLE messages MODIFY message_type ENUM('text', 'image', 'video', 'file', 'poll') NOT NULL;

CREATE TABLE IF NOT EXISTS polls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    chat_id INT NOT NULL,
    created_by INT NOT NULL,
    question VARCHAR(300) NOT NULL,
    multiple_choice BOOLEAN NOT NULL DEFAULT FALSE,
    anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    closes_at TIMESTAMP NULL DEFAULT NULL, -- optional automatic close
    closed_at TIMESTAMP NULL DEFAULT NULL, -- set when closed (by the creator or at closes_at)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_poll_message (message_id),
    INDEX idx_polls_open_closing (closed_at, closes_at)
);

CREATE TABLE IF NOT EXISTS poll_options (
    id INT AUTO_INCREMENT PRIMARY KEY,
    poll_id INT NOT NULL,
    position INT NOT NULL,
    option_text VARCHAR(100) NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    UNIQUE KEY unique_poll_option_position (poll_id, position)
);

-- choice_slot is 0 for every vote in a single-choice poll and the option id in a multiple-choice poll,
-- so (poll_id, user_id, choice_slot) makes the database itself refuse a second single-choice vote
CREATE TABLE IF NOT EXISTS poll_votes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    poll_id INT NOT NULL,
    option_id INT NOT NULL,
    user_id INT NOT NULL,
    choice_slot INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_poll_vote_option (option_id, user_id), -- one vote per option per user
    UNIQUE KEY unique_poll_vote_slot (poll_id, user_id, choice_slot), -- single-choice rule
    INDEX idx_poll_votes_poll (poll_id)
);

-- Messages waiting to be sent by the scheduler (survive restarts: the scheduler reads this table)
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    chat_id INT NOT NULL,
    content TEXT NOT NULL,
    reply_to_message_id INT NULL,
    send_at TIMESTAMP NULL DEFAULT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | cancelled
    failure_reason VARCHAR(255) NULL,
    sent_message_id INT NULL,
    attempts INT NOT NULL DEFAULT 0,
    claimed_at TIMESTAMP NULL DEFAULT NULL, -- when the scheduler took it (status 'sending')
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (sent_message_id) REFERENCES messages(id) ON DELETE SET NULL,
    INDEX idx_scheduled_due (status, send_at),
    INDEX idx_scheduled_user (user_id, status)
);

-- "Remind me" on a message: private to the user who set it
CREATE TABLE IF NOT EXISTS message_reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    message_id INT NOT NULL,
    chat_id INT NOT NULL,
    remind_at TIMESTAMP NULL DEFAULT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | fired | cancelled (dismissing a reminder deletes the row)
    fired_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    INDEX idx_reminders_due (status, remind_at),
    INDEX idx_reminders_user (user_id, status)
);
