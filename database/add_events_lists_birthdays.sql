-- Phase 12: events with RSVPs and reminders, shared lists, birthdays (MySQL)
-- Run once after add_calls.sql.
--
-- Time columns are TIMESTAMP NULL DEFAULT NULL on purpose (see add_polls_and_scheduling.sql): the
-- application writes them as CURRENT_TIMESTAMP + n seconds, so they compare cleanly with
-- CURRENT_TIMESTAMP whatever timezone Node or the database runs in.

-- An event is announced by a chat message of type 'event' (its text is the title)
ALTER TABLE messages MODIFY message_type ENUM('text', 'image', 'video', 'file', 'poll', 'voice', 'system', 'event') NOT NULL;

CREATE TABLE IF NOT EXISTS chat_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    message_id INT NULL,                 -- the card in the chat; NULL once that message is gone
    created_by INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT NULL,
    location VARCHAR(200) NULL,
    starts_at TIMESTAMP NULL DEFAULT NULL,
    ends_at TIMESTAMP NULL DEFAULT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', -- IANA zone the creator planned it in (shown next to the time)
    status VARCHAR(10) NOT NULL DEFAULT 'active', -- active | cancelled
    cancelled_at TIMESTAMP NULL DEFAULT NULL,
    revision INT NOT NULL DEFAULT 0,     -- bumped on every edit (the .ics SEQUENCE)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_chat_events_chat (chat_id, starts_at),
    INDEX idx_chat_events_message (message_id)
);

-- One answer per member: going | maybe | declined (no row = no answer yet)
CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id INT NOT NULL,
    user_id INT NOT NULL,
    response VARCHAR(8) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id),
    FOREIGN KEY (event_id) REFERENCES chat_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Reminders the creator picked (at start, 1 hour before, 1 day before), fired by the scheduler
CREATE TABLE IF NOT EXISTS event_reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id INT NOT NULL,
    offset_seconds INT NOT NULL,         -- 0, 3600 or 86400 before the start
    remind_at TIMESTAMP NULL DEFAULT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | fired | skipped (time had passed) | cancelled
    fired_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (event_id) REFERENCES chat_events(id) ON DELETE CASCADE,
    UNIQUE KEY unique_event_reminder (event_id, offset_seconds),
    INDEX idx_event_reminders_due (status, remind_at)
);

-- Named checklists in a chat (shopping list, to-do)
CREATE TABLE IF NOT EXISTS chat_lists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    created_by INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_chat_lists_chat (chat_id)
);

CREATE TABLE IF NOT EXISTS chat_list_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    list_id INT NOT NULL,
    chat_id INT NOT NULL,                -- same as the list's, so membership checks need one join
    text VARCHAR(300) NOT NULL,
    created_by INT NULL,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    done_by INT NULL,                    -- who ticked it
    done_at TIMESTAMP NULL DEFAULT NULL,
    due_at TIMESTAMP NULL DEFAULT NULL,
    due_set_by INT NULL,                 -- gets the due-date reminder
    due_reminder_status VARCHAR(10) NOT NULL DEFAULT 'none', -- none | pending | fired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (list_id) REFERENCES chat_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (done_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (due_set_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_list_items_list (list_id),
    INDEX idx_list_items_due (due_reminder_status, due_at)
);

-- Birthday: day and month, year optional (never shown to anyone else)
ALTER TABLE users
    ADD COLUMN birthday_day TINYINT NULL DEFAULT NULL AFTER custom_status_expires_at,
    ADD COLUMN birthday_month TINYINT NULL DEFAULT NULL AFTER birthday_day,
    ADD COLUMN birthday_year SMALLINT NULL DEFAULT NULL AFTER birthday_month;

-- Who sees the birthday (and its banner in shared groups); existing rows get 'contacts'
ALTER TABLE privacy_settings
    ADD COLUMN birthday_audience VARCHAR(10) NOT NULL DEFAULT 'contacts' AFTER groups_audience;
