-- Phase 6: email verification, sessions with rotating refresh tokens, user blocks and group bans (PostgreSQL)
-- Run after add_group_invites_and_settings_postgresql.sql. Safe to run more than once.

-- NULL = not verified yet. Accounts that exist before this migration are treated as verified,
-- so nobody already using FriChat loses invite links or new direct chats.
-- (The UPDATE runs only when the column is new, so re-running doesn't verify later sign-ups.)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'email_verified_at'
    ) THEN
        ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMP NULL;
        UPDATE users SET email_verified_at = CURRENT_TIMESTAMP;
    END IF;
END $$;

-- Email verification links (only a SHA-256 hash of the token is stored; single-use)
CREATE TABLE IF NOT EXISTS email_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_user_id ON email_verifications(user_id);

-- One row per signed-in device. refresh_token_hash is the SHA-256 of the current refresh token;
-- a session is the "family" that reuse detection revokes.
CREATE TABLE IF NOT EXISTS sessions (
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

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Refresh tokens that were already rotated out. Presenting one again means it was copied:
-- the whole session is revoked.
CREATE TABLE IF NOT EXISTS session_refresh_tokens (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    rotated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rotated_tokens_session_id ON session_refresh_tokens(session_id);

-- blocker_id blocked blocked_id
CREATE TABLE IF NOT EXISTS user_blocks (
    id SERIAL PRIMARY KEY,
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_id ON user_blocks(blocked_id);

-- Users an admin removed and banned from a group (no rejoining by link or by an admin until unbanned)
CREATE TABLE IF NOT EXISTS group_bans (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chat_id, user_id)
);

-- Pending requests per user across all groups (the 3-pending limit)
CREATE INDEX IF NOT EXISTS idx_join_requests_user_status ON chat_join_requests(user_id, status);
