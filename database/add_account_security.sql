-- Phase 14: two-factor authentication, known devices, data exports, account deletion (MySQL)
-- Run once after add_abuse_handling.sql, BEFORE starting the new server: every signed-in request
-- reads users.totp_enabled_at, users.deleted_at and sessions.mfa_verified_at.
--
-- The TOTP secret is stored encrypted (TOTP_ENCRYPTION_KEY). Recovery codes and device cookies are
-- stored as SHA-256 hashes only.

ALTER TABLE users
    ADD COLUMN totp_secret_enc VARCHAR(255) NULL AFTER suspended_reason,
    ADD COLUMN totp_pending_enc VARCHAR(255) NULL AFTER totp_secret_enc, -- set up, not confirmed yet
    ADD COLUMN totp_pending_at TIMESTAMP NULL DEFAULT NULL AFTER totp_pending_enc,
    ADD COLUMN totp_enabled_at TIMESTAMP NULL DEFAULT NULL AFTER totp_pending_at, -- NULL = 2FA off
    ADD COLUMN totp_last_step BIGINT NULL AFTER totp_enabled_at, -- last time step used: a code works once
    ADD COLUMN totp_failed_attempts INT NOT NULL DEFAULT 0 AFTER totp_last_step,
    ADD COLUMN totp_locked_until TIMESTAMP NULL DEFAULT NULL AFTER totp_failed_attempts,
    ADD COLUMN deletion_requested_at TIMESTAMP NULL DEFAULT NULL AFTER totp_locked_until,
    ADD COLUMN deletion_due_at TIMESTAMP NULL DEFAULT NULL AFTER deletion_requested_at, -- end of the grace period
    ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER deletion_due_at, -- the row is an anonymous tombstone
    ADD INDEX idx_users_deletion_due (deletion_due_at);

-- NULL = this session never passed a second factor. A user with 2FA on cannot use such a session.
ALTER TABLE sessions ADD COLUMN mfa_verified_at TIMESTAMP NULL DEFAULT NULL;

-- Single-use recovery codes
CREATE TABLE IF NOT EXISTS recovery_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    code_hash CHAR(64) NOT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_recovery_code (user_id, code_hash)
);

-- Browsers this user has signed in from (a random cookie, hashed with the user id)
CREATE TABLE IF NOT EXISTS known_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    device_hash CHAR(64) NOT NULL,
    label VARCHAR(100) NULL,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_known_device (user_id, device_hash),
    INDEX idx_known_devices_last_seen (last_seen_at)
);

-- Personal data exports. The zip lives in a private folder with no URL.
CREATE TABLE IF NOT EXISTS data_exports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | running | ready | failed | expired
    file_name VARCHAR(100) NULL,
    file_size BIGINT NULL,
    attempts INT NOT NULL DEFAULT 0,
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL DEFAULT NULL,
    finished_at TIMESTAMP NULL DEFAULT NULL,
    expires_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_data_exports_user (user_id, id),
    INDEX idx_data_exports_status (status, id)
);
