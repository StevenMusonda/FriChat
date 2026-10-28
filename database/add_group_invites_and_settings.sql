-- Phase 5: invite links, join approval, group profile, announcement-only mode and member tags (MySQL)
-- Run once after reactions_one_per_user.sql.

-- Group profile and settings (only used for chat_type = 'group')
ALTER TABLE chats
    ADD COLUMN description VARCHAR(500) NULL,
    ADD COLUMN avatar_url VARCHAR(255) NULL, -- path under uploads/, e.g. 'uploads/group-avatars/<random>.webp'
    ADD COLUMN approve_new_members BOOLEAN NOT NULL DEFAULT FALSE, -- invite-link joins wait for an admin
    ADD COLUMN announcement_only BOOLEAN NOT NULL DEFAULT FALSE; -- only admins can send messages

-- Short label an admin gives a member, shown next to their name
ALTER TABLE group_members
    ADD COLUMN member_tag VARCHAR(30) NULL;

-- Invite links. Only a SHA-256 hash of the 128-bit token is stored; token_hint is its first 4 characters,
-- so admins can tell links apart without the database holding enough to rebuild one.
CREATE TABLE IF NOT EXISTS chat_invites (
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
CREATE TABLE IF NOT EXISTS chat_join_requests (
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
    INDEX idx_join_requests_chat_status (chat_id, status)
);
