-- FriChat Database Schema for PostgreSQL
-- Compatible with PostgreSQL 10+

-- Drop tables if they exist (for clean setup)
DROP TABLE IF EXISTS group_bans CASCADE;
DROP TABLE IF EXISTS user_blocks CASCADE;
DROP TABLE IF EXISTS session_refresh_tokens CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS email_verifications CASCADE;
DROP TABLE IF EXISTS chat_join_requests CASCADE;
DROP TABLE IF EXISTS chat_invites CASCADE;
DROP TABLE IF EXISTS deleted_chats CASCADE;
DROP TABLE IF EXISTS pinned_messages CASCADE;
DROP TABLE IF EXISTS deleted_messages CASCADE;
DROP TABLE IF EXISTS message_mentions CASCADE;
DROP TABLE IF EXISTS starred_messages CASCADE;
DROP TABLE IF EXISTS notification_settings CASCADE;
DROP TABLE IF EXISTS push_subscriptions CASCADE;
DROP TABLE IF EXISTS password_resets CASCADE;
DROP TABLE IF EXISTS message_reactions CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS group_members CASCADE;
DROP TABLE IF EXISTS chats CASCADE;
DROP TABLE IF EXISTS link_previews CASCADE;
DROP TABLE IF EXISTS files CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Drop types if they exist
DROP TYPE IF EXISTS user_status CASCADE;
DROP TYPE IF EXISTS chat_type CASCADE;
DROP TYPE IF EXISTS member_role CASCADE;
DROP TYPE IF EXISTS message_type CASCADE;
DROP TYPE IF EXISTS message_status CASCADE;

-- Create custom types
CREATE TYPE user_status AS ENUM ('online', 'offline', 'away');
CREATE TYPE chat_type AS ENUM ('direct', 'group');
CREATE TYPE member_role AS ENUM ('admin', 'member');
CREATE TYPE message_type AS ENUM ('text', 'image', 'video', 'file');
CREATE TYPE message_status AS ENUM ('sent', 'delivered', 'read');

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    avatar_url VARCHAR(255),
    status user_status DEFAULT 'offline',
    last_seen TIMESTAMP,
    email_verified_at TIMESTAMP NULL, -- NULL = email not verified yet
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_username ON users(username);
CREATE INDEX idx_email ON users(email);

-- Password reset tokens (only a SHA-256 hash of the token is stored)
CREATE TABLE password_resets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_password_resets_user_id ON password_resets(user_id);

-- Web Push subscriptions, one row per browser/device that allowed notifications
CREATE TABLE push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    endpoint_hash CHAR(64) NOT NULL UNIQUE,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_push_user_id ON push_subscriptions(user_id);

-- Per-user do-not-disturb (no row = notifications on, no quiet hours)
CREATE TABLE notification_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dnd_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_start CHAR(5) NULL, -- 'HH:MM' in the user's timezone; start > end crosses midnight
    quiet_end CHAR(5) NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', -- IANA name, e.g. 'Europe/Berlin'
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chats table (for both direct and group chats)
CREATE TABLE chats (
    id SERIAL PRIMARY KEY,
    chat_type chat_type NOT NULL,
    chat_name VARCHAR(100), -- For group chats
    description VARCHAR(500) NULL, -- group profile
    avatar_url VARCHAR(255) NULL, -- path under uploads/
    approve_new_members BOOLEAN NOT NULL DEFAULT FALSE, -- invite-link joins wait for an admin
    announcement_only BOOLEAN NOT NULL DEFAULT FALSE, -- only admins can send messages
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_type ON chats(chat_type);

-- Group members table (stores participants in chats)
CREATE TABLE group_members (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role member_role DEFAULT 'member',
    mentions_only BOOLEAN NOT NULL DEFAULT FALSE, -- push only for @mentions; mentions also get through a mute
    last_read_message_id INTEGER NULL, -- read position for unread counts
    muted_until TIMESTAMP NULL, -- NULL = not muted; '9999-12-31' = muted until unmuted ("always")
    archived_at TIMESTAMP NULL, -- NULL = in the main list
    member_tag VARCHAR(30) NULL, -- short label set by admins, shown next to the name
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chat_id, user_id)
);

CREATE INDEX idx_gm_chat_id ON group_members(chat_id);
CREATE INDEX idx_gm_user_id ON group_members(user_id);

-- Files table (stores metadata for uploaded files)
CREATE TABLE files (
    id SERIAL PRIMARY KEY,
    original_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    upload_path VARCHAR(500) NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    attached_at TIMESTAMP NULL -- NULL = uploaded, not attached to a message yet
);

CREATE INDEX idx_uploaded_by ON files(uploaded_by);

-- Server-side Open Graph cache, one row per URL (url_hash = SHA-256 of the URL)
CREATE TABLE link_previews (
    id SERIAL PRIMARY KEY,
    url_hash CHAR(64) NOT NULL UNIQUE,
    url TEXT NOT NULL,
    status VARCHAR(10) NOT NULL, -- 'ok' | 'failed' (failed URLs aren't refetched until the cache expires)
    title VARCHAR(300) NULL,
    description VARCHAR(500) NULL,
    image_url TEXT NULL,
    site_name VARCHAR(200) NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_type message_type NOT NULL,
    content TEXT, -- For text messages
    file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    status message_status DEFAULT 'sent',
    reply_to_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL, -- The message this one quotes
    edited_at TIMESTAMP NULL, -- NULL = never edited
    is_forwarded BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP NULL, -- Delete for everyone
    deleted_by INTEGER NULL,
    deleted_for_everyone BOOLEAN DEFAULT FALSE,
    link_preview_id INTEGER NULL REFERENCES link_previews(id) ON DELETE SET NULL, -- preview card under the message
    link_preview_dismissed BOOLEAN NOT NULL DEFAULT FALSE, -- the sender removed the preview
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- message search: word prefixes, no stemming (to_tsquery('simple', 'term:*'))
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(content, ''))) STORED,
    CONSTRAINT fk_messages_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_msg_chat_id ON messages(chat_id);
CREATE INDEX idx_msg_sender_id ON messages(sender_id);
CREATE INDEX idx_msg_created_at ON messages(created_at);
CREATE INDEX idx_messages_deleted_at ON messages(deleted_at);
-- Cursor pagination (WHERE chat_id = ? AND id < ? ORDER BY id DESC) and unread counts (id > last_read)
CREATE INDEX idx_msg_chat_id_id ON messages(chat_id, id);
-- Message search and the shared media panel
CREATE INDEX idx_messages_search ON messages USING GIN (search_vector);
CREATE INDEX idx_msg_chat_type_id ON messages(chat_id, message_type, id);

-- Message reactions table
CREATE TABLE message_reactions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
);

CREATE INDEX idx_reaction_message_id ON message_reactions(message_id);

-- Per-user starred messages
CREATE TABLE starred_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, message_id)
);

CREATE INDEX idx_starred_message_id ON starred_messages(message_id);

-- Who a message mentions (group chats only)
CREATE TABLE message_mentions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id, user_id)
);

CREATE INDEX idx_mentions_user_message ON message_mentions(user_id, message_id);

-- Messages a user deleted for themselves only
CREATE TABLE deleted_messages (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id, user_id)
);

CREATE INDEX idx_deleted_messages_message_id ON deleted_messages(message_id);
CREATE INDEX idx_deleted_messages_user_id ON deleted_messages(user_id);

-- Pinned messages (one pin per message, expires at pinned_until)
CREATE TABLE pinned_messages (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    pinned_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pinned_until TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id)
);

CREATE INDEX idx_pinned_messages_chat_id ON pinned_messages(chat_id);
CREATE INDEX idx_pinned_messages_pinned_until ON pinned_messages(pinned_until);

-- Chats a user removed from their own list (soft delete)
CREATE TABLE deleted_chats (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chat_id, user_id)
);

CREATE INDEX idx_deleted_chats_chat_id ON deleted_chats(chat_id);
CREATE INDEX idx_deleted_chats_user_id ON deleted_chats(user_id);

-- Invite links (only a SHA-256 hash of the 128-bit token is stored; token_hint = its first 4 characters)
CREATE TABLE chat_invites (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    token_hint VARCHAR(8) NOT NULL,
    created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMP NULL, -- NULL = never
    max_uses INTEGER NULL, -- NULL = unlimited
    use_count INTEGER NOT NULL DEFAULT 0,
    revoked_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invites_chat_id ON chat_invites(chat_id);

-- Requests to join a group that has "Approve new members" on (one row per user and group)
CREATE TABLE chat_join_requests (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_id INTEGER NULL REFERENCES chat_invites(id) ON DELETE SET NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'declined'
    decided_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chat_id, user_id)
);

CREATE INDEX idx_join_requests_chat_status ON chat_join_requests(chat_id, status);
CREATE INDEX idx_join_requests_user_status ON chat_join_requests(user_id, status);

-- Email verification links (only a SHA-256 hash of the token is stored; single-use)
CREATE TABLE email_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_verifications_user_id ON email_verifications(user_id);

-- One row per signed-in device; refresh_token_hash is the SHA-256 of the current refresh token
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash CHAR(64) NOT NULL UNIQUE,
    user_agent VARCHAR(255) NULL,
    device_label VARCHAR(100) NULL, -- e.g. 'Chrome on Windows', parsed from the user agent
    ip_address VARCHAR(45) NULL, -- last seen IP (IPv4 or IPv6), no geolocation
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL, -- refresh token lifetime, slides forward on every rotation
    revoked_at TIMESTAMP NULL,
    revoked_reason VARCHAR(20) NULL -- 'logout' | 'user' | 'password' | 'reuse'
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- Refresh tokens already rotated out; presenting one again revokes the whole session
CREATE TABLE session_refresh_tokens (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    rotated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_rotated_tokens_session_id ON session_refresh_tokens(session_id);

-- blocker_id blocked blocked_id
CREATE TABLE user_blocks (
    id SERIAL PRIMARY KEY,
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX idx_user_blocks_blocked_id ON user_blocks(blocked_id);

-- Users an admin removed and banned from a group
CREATE TABLE group_bans (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chat_id, user_id)
);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chats_updated_at BEFORE UPDATE ON chats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_messages_updated_at BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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
