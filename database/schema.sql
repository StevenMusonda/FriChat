-- FriChat Database Schema
-- Compatible with MySQL 5.7+ and PostgreSQL 10+

-- Drop tables if they exist (for clean setup)
DROP TABLE IF EXISTS message_reminders;
DROP TABLE IF EXISTS scheduled_messages;
DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS poll_options;
DROP TABLE IF EXISTS polls;
DROP TABLE IF EXISTS group_bans;
DROP TABLE IF EXISTS user_blocks;
DROP TABLE IF EXISTS session_refresh_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS email_verifications;
DROP TABLE IF EXISTS chat_join_requests;
DROP TABLE IF EXISTS chat_invites;
DROP TABLE IF EXISTS deleted_chats;
DROP TABLE IF EXISTS pinned_messages;
DROP TABLE IF EXISTS deleted_messages;
DROP TABLE IF EXISTS message_mentions;
DROP TABLE IF EXISTS starred_messages;
DROP TABLE IF EXISTS notification_settings;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS message_reactions;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS chats;
DROP TABLE IF EXISTS link_previews;
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
    email_verified_at DATETIME NULL, -- NULL = email not verified yet
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
    description VARCHAR(500) NULL, -- group profile
    avatar_url VARCHAR(255) NULL, -- path under uploads/, e.g. 'uploads/group-avatars/<random>.webp'
    approve_new_members BOOLEAN NOT NULL DEFAULT FALSE, -- invite-link joins wait for an admin
    announcement_only BOOLEAN NOT NULL DEFAULT FALSE, -- only admins can send messages
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
    mentions_only BOOLEAN NOT NULL DEFAULT FALSE, -- push only for @mentions; mentions also get through a mute
    last_read_message_id INT NULL, -- read position for unread counts
    muted_until DATETIME NULL, -- NULL = not muted; '9999-12-31' = "always". DATETIME because TIMESTAMP stops at 2038.
    archived_at DATETIME NULL, -- NULL = in the main list
    member_tag VARCHAR(30) NULL, -- short label set by admins, shown next to the name
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

-- Server-side Open Graph cache, one row per URL (url_hash = SHA-256 of the URL)
CREATE TABLE link_previews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    url_hash CHAR(64) NOT NULL,
    url TEXT NOT NULL,
    status VARCHAR(10) NOT NULL, -- 'ok' | 'failed' (failed URLs aren't refetched until the cache expires)
    title VARCHAR(300) NULL,
    description VARCHAR(500) NULL,
    image_url TEXT NULL,
    site_name VARCHAR(200) NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_link_preview_url (url_hash)
);

-- Messages table
CREATE TABLE messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    sender_id INT NOT NULL,
    message_type ENUM('text', 'image', 'video', 'file', 'poll') NOT NULL, -- 'poll': content is the question, details in polls
    content TEXT, -- For text messages
    file_id INT, -- Reference to files table for media/file messages
    status ENUM('sent', 'delivered', 'read') DEFAULT 'sent',
    reply_to_message_id INT NULL, -- The message this one quotes
    edited_at TIMESTAMP NULL DEFAULT NULL, -- NULL = never edited
    is_forwarded BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP NULL DEFAULT NULL, -- Delete for everyone
    deleted_by INT NULL,
    deleted_for_everyone BOOLEAN DEFAULT FALSE,
    link_preview_id INT NULL, -- preview card under the message
    link_preview_dismissed BOOLEAN NOT NULL DEFAULT FALSE, -- the sender removed the preview
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
    CONSTRAINT fk_messages_reply_to FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL,
    CONSTRAINT fk_messages_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_messages_link_preview FOREIGN KEY (link_preview_id) REFERENCES link_previews(id) ON DELETE SET NULL,
    INDEX idx_chat_id (chat_id),
    INDEX idx_sender_id (sender_id),
    INDEX idx_created_at (created_at),
    INDEX idx_messages_deleted_at (deleted_at),
    INDEX idx_msg_chat_id_id (chat_id, id), -- cursor pagination and unread counts
    INDEX idx_msg_chat_type_id (chat_id, message_type, id), -- shared media panel
    FULLTEXT INDEX ft_messages_content (content) -- message search (MATCH ... AGAINST)
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
    UNIQUE KEY unique_user_message (message_id, user_id), -- one reaction per user per message
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

-- Who a message mentions (group chats only)
CREATE TABLE message_mentions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_message_mention (message_id, user_id),
    INDEX idx_mentions_user_message (user_id, message_id)
);

-- Messages a user deleted for themselves only
CREATE TABLE deleted_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_message (message_id, user_id),
    INDEX idx_message_id (message_id),
    INDEX idx_user_id (user_id)
);

-- Pinned messages (one pin per message, expires at pinned_until)
CREATE TABLE pinned_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    chat_id INT NOT NULL,
    pinned_by INT NOT NULL,
    pinned_until TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_message_pin (message_id),
    INDEX idx_chat_id (chat_id),
    INDEX idx_pinned_until (pinned_until)
);

-- Chats a user removed from their own list (soft delete)
CREATE TABLE deleted_chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    user_id INT NOT NULL,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_chat (chat_id, user_id),
    INDEX idx_chat_id (chat_id),
    INDEX idx_user_id (user_id)
);

-- Invite links (only a SHA-256 hash of the 128-bit token is stored; token_hint = its first 4 characters)
CREATE TABLE chat_invites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    token_hint VARCHAR(8) NOT NULL,
    created_by INT NULL,
    expires_at DATETIME NULL, -- NULL = never
    max_uses INT NULL, -- NULL = unlimited
    use_count INT NOT NULL DEFAULT 0,
    revoked_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_invite_token (token_hash),
    INDEX idx_invites_chat_id (chat_id)
);

-- Requests to join a group that has "Approve new members" on (one row per user and group)
CREATE TABLE chat_join_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    user_id INT NOT NULL,
    invite_id INT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'declined'
    decided_by INT NULL,
    decided_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invite_id) REFERENCES chat_invites(id) ON DELETE SET NULL,
    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_join_request (chat_id, user_id),
    INDEX idx_join_requests_chat_status (chat_id, status),
    INDEX idx_join_requests_user_status (user_id, status)
);

-- Email verification links (only a SHA-256 hash of the token is stored; single-use)
CREATE TABLE email_verifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_email_verification_token (token_hash),
    INDEX idx_email_verifications_user_id (user_id)
);

-- One row per signed-in device; refresh_token_hash is the SHA-256 of the current refresh token
CREATE TABLE sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    refresh_token_hash CHAR(64) NOT NULL,
    user_agent VARCHAR(255) NULL,
    device_label VARCHAR(100) NULL, -- e.g. 'Chrome on Windows', parsed from the user agent
    ip_address VARCHAR(45) NULL, -- last seen IP (IPv4 or IPv6), no geolocation
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL, -- refresh token lifetime, slides forward on every rotation
    revoked_at DATETIME NULL,
    revoked_reason VARCHAR(20) NULL, -- 'logout' | 'user' | 'password' | 'reuse'
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_session_refresh_token (refresh_token_hash),
    INDEX idx_sessions_user_id (user_id)
);

-- Refresh tokens already rotated out; presenting one again revokes the whole session
CREATE TABLE session_refresh_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    rotated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE KEY unique_rotated_refresh_token (token_hash),
    INDEX idx_rotated_tokens_session_id (session_id)
);

-- blocker_id blocked blocked_id
CREATE TABLE user_blocks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    blocker_id INT NOT NULL,
    blocked_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_block (blocker_id, blocked_id),
    INDEX idx_user_blocks_blocked_id (blocked_id)
);

-- Users an admin removed and banned from a group
CREATE TABLE group_bans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    user_id INT NOT NULL,
    banned_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_group_ban (chat_id, user_id)
);

-- Polls (phase 8). Time columns are TIMESTAMP NULL DEFAULT NULL on purpose, see add_polls_and_scheduling.sql
CREATE TABLE polls (
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

CREATE TABLE poll_options (
    id INT AUTO_INCREMENT PRIMARY KEY,
    poll_id INT NOT NULL,
    position INT NOT NULL,
    option_text VARCHAR(100) NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    UNIQUE KEY unique_poll_option_position (poll_id, position)
);

-- choice_slot is 0 for every vote in a single-choice poll and the option id in a multiple-choice poll,
-- so (poll_id, user_id, choice_slot) makes the database itself refuse a second single-choice vote
CREATE TABLE poll_votes (
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
CREATE TABLE scheduled_messages (
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
CREATE TABLE message_reminders (
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
