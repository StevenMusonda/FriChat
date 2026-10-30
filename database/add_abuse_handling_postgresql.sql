-- Phase 13: reports with evidence, audit log, admin role, suspensions, warnings, quarantine (PostgreSQL)
-- Run after add_events_lists_birthdays_postgresql.sql, BEFORE starting the new server: every
-- signed-in request reads users.is_admin and users.suspended_at. Safe to run more than once.
--
-- is_admin is set only by backend/scripts/set-admin.js or by hand in the database, never by the API.
-- report_evidence and audit_log have no foreign keys to messages or users on purpose: they are
-- copies that must outlive the original message or account.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(255) NULL;

-- /uploads looks up the original name for downloads
CREATE INDEX IF NOT EXISTS idx_files_stored_name ON files(stored_name);

-- A report on a message or a user. message_id and chat_id are plain numbers: they stay after the rows go.
CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    reported_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    target_type VARCHAR(10) NOT NULL, -- message | user
    message_id INTEGER NULL,
    chat_id INTEGER NULL,
    reason VARCHAR(20) NOT NULL, -- spam | harassment | inappropriate | other
    note VARCHAR(500) NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open', -- open | dismissed | actioned
    resolution VARCHAR(20) NULL, -- last action: dismissed | warned | suspended | message_deleted
    reviewed_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_message ON reports(reporter_id, message_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON reports(reported_user_id);

-- Copies of the reported message and the messages around it, taken when the report is filed
CREATE TABLE IF NOT EXISTS report_evidence (
    id SERIAL PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, -- oldest first
    is_reported BOOLEAN NOT NULL DEFAULT FALSE,
    message_id INTEGER NOT NULL,
    sender_id INTEGER NULL,
    sender_username VARCHAR(50) NULL,
    message_type VARCHAR(20) NOT NULL,
    content TEXT NULL,
    file_name VARCHAR(255) NULL,
    file_mime VARCHAR(100) NULL,
    file_size BIGINT NULL,
    evidence_path VARCHAR(500) NULL, -- copy of the attachment, outside the public uploads folder
    sent_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_report_evidence_report ON report_evidence(report_id, position);

-- Append-only: the application only ever INSERTs and SELECTs here
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    event VARCHAR(40) NOT NULL,
    actor_id INTEGER NULL, -- NULL = nobody signed in, or the system
    target_type VARCHAR(20) NULL, -- user | chat | message | report | session | invite | file
    target_id BIGINT NULL,
    ip_address VARCHAR(45) NULL,
    metadata TEXT NULL, -- JSON; never passwords, tokens or message text
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event, id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Warnings from an admin, shown to the user until they acknowledge them
CREATE TABLE IF NOT EXISTS user_warnings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    report_id INTEGER NULL REFERENCES reports(id) ON DELETE SET NULL,
    message VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_user_warnings_user ON user_warnings(user_id, acknowledged_at);

-- Uploads ClamAV flagged, kept outside the public uploads folder
CREATE TABLE IF NOT EXISTS quarantined_files (
    id SERIAL PRIMARY KEY,
    original_name VARCHAR(255) NOT NULL,
    quarantine_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NULL,
    file_size BIGINT NOT NULL,
    signature VARCHAR(255) NULL,
    uploaded_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
