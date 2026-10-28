-- Phase 6: email verification, sessions with rotating refresh tokens, user blocks and group bans (MySQL)
-- Run once after add_group_invites_and_settings.sql.

-- NULL = not verified yet. Accounts that exist before this migration are treated as verified,
-- so nobody already using FriChat loses invite links or new direct chats.
ALTER TABLE users
    ADD COLUMN email_verified_at DATETIME NULL;

UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE email_verified_at IS NULL;

-- Email verification links (only a SHA-256 hash of the token is stored; single-use)
CREATE TABLE IF NOT EXISTS email_verifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_email_verification_token (token_hash),
    INDEX idx_email_verifications_user_id (user_id)
);

-- One row per signed-in device. refresh_token_hash is the SHA-256 of the current refresh token;
-- a session is the "family" that reuse detection revokes.
CREATE TABLE IF NOT EXISTS sessions (
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

-- Refresh tokens that were already rotated out. Presenting one again means it was copied:
-- the whole session is revoked.
CREATE TABLE IF NOT EXISTS session_refresh_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    rotated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE KEY unique_rotated_refresh_token (token_hash),
    INDEX idx_rotated_tokens_session_id (session_id)
);

-- blocker_id blocked blocked_id
CREATE TABLE IF NOT EXISTS user_blocks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    blocker_id INT NOT NULL,
    blocked_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_block (blocker_id, blocked_id),
    INDEX idx_user_blocks_blocked_id (blocked_id)
);

-- Users an admin removed and banned from a group (no rejoining by link or by an admin until unbanned)
CREATE TABLE IF NOT EXISTS group_bans (
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

-- Pending requests per user across all groups (the 3-pending limit)
CREATE INDEX idx_join_requests_user_status ON chat_join_requests (user_id, status);
