-- FriChat Database Schema
-- Compatible with MySQL 5.7+ and PostgreSQL 10+

-- Drop tables if they exist (for clean setup)
DROP TABLE IF EXISTS starred_messages;
DROP TABLE IF EXISTS notification_settings;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS message_reactions;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS chats;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS users;

-- Users table
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    avatar_url VARCHAR(255),
    status ENUM('online', 'offline', 'away') DEFAULT 'offline',
    last_seen TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_username (username),
    INDEX idx_email (email)
);

-- Password reset tokens (only a SHA-256 hash of the token is stored)
CREATE TABLE password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_password_resets_user_id (user_id)
);

-- Web Push subscriptions, one row per browser/device that allowed notifications
-- (endpoint is hashed so it can carry a UNIQUE index under InnoDB's key size limit)
CREATE TABLE push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint TEXT NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_push_endpoint (endpoint_hash),
    INDEX idx_push_user_id (user_id)
);

-- Per-user do-not-disturb (no row = notifications on, no quiet hours)
CREATE TABLE notification_settings (
    user_id INT PRIMARY KEY,
    dnd_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_start CHAR(5) NULL, -- 'HH:MM' in the user's timezone; start > end crosses midnight
    quiet_end CHAR(5) NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', -- IANA name, e.g. 'Europe/Berlin'
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Chats table (for both direct and group chats)
CREATE TABLE chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_type ENUM('direct', 'group') NOT NULL,
    chat_name VARCHAR(100), -- For group chats
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_chat_type (chat_type)
);

-- Group members table (stores participants in chats)
CREATE TABLE group_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('admin', 'member') DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_chat_user (chat_id, user_id),
    INDEX idx_chat_id (chat_id),
    INDEX idx_user_id (user_id)
);

-- Files table (stores metadata for uploaded files)
CREATE TABLE files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    original_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    upload_path VARCHAR(500) NOT NULL,
    uploaded_by INT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    attached_at TIMESTAMP NULL DEFAULT NULL, -- NULL = uploaded, not attached to a message yet
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_uploaded_by (uploaded_by)
);

-- Messages table
CREATE TABLE messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    sender_id INT NOT NULL,
    message_type ENUM('text', 'image', 'video', 'file') NOT NULL,
    content TEXT, -- For text messages
    file_id INT, -- Reference to files table for media/file messages
    status ENUM('sent', 'delivered', 'read') DEFAULT 'sent',
    reply_to_message_id INT NULL, -- The message this one quotes
    edited_at TIMESTAMP NULL DEFAULT NULL, -- NULL = never edited
    is_forwarded BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP NULL DEFAULT NULL, -- Delete for everyone
    deleted_by INT NULL,
    deleted_for_everyone BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
    CONSTRAINT fk_messages_reply_to FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL,
    CONSTRAINT fk_messages_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_chat_id (chat_id),
    INDEX idx_sender_id (sender_id),
    INDEX idx_created_at (created_at),
    INDEX idx_messages_deleted_at (deleted_at)
);

-- Message reactions table
CREATE TABLE message_reactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    emoji VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_message_emoji (message_id, user_id, emoji),
    INDEX idx_message_id (message_id)
);

-- Per-user starred messages
CREATE TABLE starred_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    message_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_star (user_id, message_id),
    INDEX idx_starred_message_id (message_id)
);

-- Create a view for easy message retrieval with user info
CREATE VIEW message_details AS
SELECT 
    m.id,
    m.chat_id,
    m.sender_id,
    u.username,
    u.full_name,
    u.avatar_url,
    m.message_type,
    m.content,
    m.file_id,
    f.original_name AS file_name,
    f.file_type,
    f.file_size,
    f.upload_path,
    m.status,
    m.created_at,
    m.updated_at
FROM messages m
JOIN users u ON m.sender_id = u.id
LEFT JOIN files f ON m.file_id = f.id;
