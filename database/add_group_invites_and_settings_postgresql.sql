-- Phase 5: invite links, join approval, group profile, announcement-only mode and member tags (PostgreSQL)
-- Run after reactions_one_per_user_postgresql.sql. Safe to run more than once.

-- Group profile and settings (only used for chat_type = 'group')
ALTER TABLE chats ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(255) NULL; -- path under uploads/
ALTER TABLE chats ADD COLUMN IF NOT EXISTS approve_new_members BOOLEAN NOT NULL DEFAULT FALSE; -- invite-link joins wait for an admin
ALTER TABLE chats ADD COLUMN IF NOT EXISTS announcement_only BOOLEAN NOT NULL DEFAULT FALSE; -- only admins can send messages

-- Short label an admin gives a member, shown next to their name
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS member_tag VARCHAR(30) NULL;

-- Invite links. Only a SHA-256 hash of the 128-bit token is stored; token_hint is its first 4 characters,
-- so admins can tell links apart without the database holding enough to rebuild one.
CREATE TABLE IF NOT EXISTS chat_invites (
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

CREATE INDEX IF NOT EXISTS idx_invites_chat_id ON chat_invites(chat_id);

-- Requests to join a group that has "Approve new members" on (one row per user and group)
CREATE TABLE IF NOT EXISTS chat_join_requests (
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

CREATE INDEX IF NOT EXISTS idx_join_requests_chat_status ON chat_join_requests(chat_id, status);
