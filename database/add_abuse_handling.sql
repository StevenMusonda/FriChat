-- Phase 13: reports with evidence, audit log, admin role, suspensions, warnings, quarantine (MySQL)
-- Run once after add_events_lists_birthdays.sql, BEFORE starting the new server: every signed-in
-- request reads users.is_admin and users.suspended_at.
--
-- is_admin is set only by backend/scripts/set-admin.js or by hand in the database, never by the API.
-- report_evidence and audit_log have no foreign keys to messages or users on purpose: they are
-- copies that must outlive the original message or account.

ALTER TABLE users
    ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE AFTER email_verified_at,
    ADD COLUMN suspended_at TIMESTAMP NULL DEFAULT NULL AFTER is_admin,
    ADD COLUMN suspended_reason VARCHAR(255) NULL AFTER suspended_at;

-- /uploads looks up the original name for downloads
ALTER TABLE files ADD INDEX idx_files_stored_name (stored_name);

-- A report on a message or a user. message_id and chat_id are plain numbers: they stay after the rows go.
CREATE TABLE IF NOT EXISTS reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reporter_id INT NULL,
    reported_user_id INT NULL,
    target_type VARCHAR(10) NOT NULL, -- message | user
    message_id INT NULL,
    chat_id INT NULL,
    reason VARCHAR(20) NOT NULL, -- spam | harassment | inappropriate | other
    note VARCHAR(500) NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open', -- open | dismissed | actioned
    resolution VARCHAR(20) NULL, -- last action: dismissed | warned | suspended | message_deleted
    reviewed_by INT NULL,
    reviewed_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_reports_status (status, id),
    INDEX idx_reports_reporter_message (reporter_id, message_id),
    INDEX idx_reports_reported_user (reported_user_id)
);

-- Copies of the reported message and the messages around it, taken when the report is filed
CREATE TABLE IF NOT EXISTS report_evidence (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    position INT NOT NULL, -- oldest first
    is_reported BOOLEAN NOT NULL DEFAULT FALSE,
    message_id INT NOT NULL,
    sender_id INT NULL,
    sender_username VARCHAR(50) NULL,
    message_type VARCHAR(20) NOT NULL,
    content TEXT NULL,
    file_name VARCHAR(255) NULL,
    file_mime VARCHAR(100) NULL,
    file_size BIGINT NULL,
    evidence_path VARCHAR(500) NULL, -- copy of the attachment, outside the public uploads folder
    sent_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
    INDEX idx_report_evidence_report (report_id, position)
);

-- Append-only: the application only ever INSERTs and SELECTs here
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event VARCHAR(40) NOT NULL,
    actor_id INT NULL, -- NULL = nobody signed in, or the system
    target_type VARCHAR(20) NULL, -- user | chat | message | report | session | invite | file
    target_id BIGINT NULL,
    ip_address VARCHAR(45) NULL,
    metadata TEXT NULL, -- JSON; never passwords, tokens or message text
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_event (event, id),
    INDEX idx_audit_actor (actor_id, id),
    INDEX idx_audit_target (target_type, target_id, id),
    INDEX idx_audit_created (created_at)
);

-- Warnings from an admin, shown to the user until they acknowledge them
CREATE TABLE IF NOT EXISTS user_warnings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    admin_id INT NULL,
    report_id INT NULL,
    message VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL,
    INDEX idx_user_warnings_user (user_id, acknowledged_at)
);

-- Uploads ClamAV flagged, kept outside the public uploads folder
CREATE TABLE IF NOT EXISTS quarantined_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    original_name VARCHAR(255) NOT NULL,
    quarantine_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NULL,
    file_size BIGINT NOT NULL,
    signature VARCHAR(255) NULL,
    uploaded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);
