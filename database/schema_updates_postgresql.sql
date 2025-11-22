-- Schema updates for new features (PostgreSQL)
-- Run this to add delete and pin functionality

-- Skip the ALTER TABLE commands if you already ran them
-- Just run the CREATE TABLE statements below

-- Table to track which users have deleted messages for themselves
CREATE TABLE IF NOT EXISTS deleted_messages (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_deleted_messages_message_id ON deleted_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_deleted_messages_user_id ON deleted_messages(user_id);

-- Pinned messages table
CREATE TABLE IF NOT EXISTS pinned_messages (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    pinned_by INTEGER NOT NULL,
    pinned_until TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (message_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_chat_id ON pinned_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_pinned_messages_pinned_until ON pinned_messages(pinned_until);

-- Table to track deleted chats (soft delete from user's view)
CREATE TABLE IF NOT EXISTS deleted_chats (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_deleted_chats_chat_id ON deleted_chats(chat_id);
CREATE INDEX IF NOT EXISTS idx_deleted_chats_user_id ON deleted_chats(user_id);
