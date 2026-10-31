-- Phase 14: two-factor authentication, known devices, data exports, account deletion (PostgreSQL)
-- Run after add_abuse_handling_postgresql.sql, BEFORE starting the new server: every signed-in
-- request reads users.totp_enabled_at, users.deleted_at and sessions.mfa_verified_at.
-- Safe to run more than once.
--
-- The TOTP secret is stored encrypted (TOTP_ENCRYPTION_KEY). Recovery codes and device cookies are
-- stored as SHA-256 hashes only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_enc VARCHAR(255) NULL; -- set up, not confirmed yet
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMP NULL; -- NULL = 2FA off
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NULL; -- last time step used: a code works once
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_due_at TIMESTAMP NULL; -- end of the grace period
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL; -- the row is an anonymous tombstone

CREATE INDEX IF NOT EXISTS idx_users_deletion_due ON users(deletion_due_at);

-- NULL = this session never passed a second factor. A user with 2FA on cannot use such a session.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at TIMESTAMP NULL;

-- Single-use recovery codes
CREATE TABLE IF NOT EXISTS recovery_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash CHAR(64) NOT NULL,
    used_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, code_hash)
);

-- Browsers this user has signed in from (a random cookie, hashed with the user id)
CREATE TABLE IF NOT EXISTS known_devices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash CHAR(64) NOT NULL,
    label VARCHAR(100) NULL,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, device_hash)
);

CREATE INDEX IF NOT EXISTS idx_known_devices_last_seen ON known_devices(last_seen_at);

-- Personal data exports. The zip lives in a private folder with no URL.
CREATE TABLE IF NOT EXISTS data_exports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | running | ready | failed | expired
    file_name VARCHAR(100) NULL,
    file_size BIGINT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    finished_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_data_exports_user ON data_exports(user_id, id);
CREATE INDEX IF NOT EXISTS idx_data_exports_status ON data_exports(status, id);
