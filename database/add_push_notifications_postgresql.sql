-- Phase 2: Web Push subscriptions and do-not-disturb settings (PostgreSQL)
-- Run after add_read_state_postgresql.sql. Safe to run more than once.

-- One row per browser/device that allowed notifications
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    -- Same column as MySQL, where the endpoint is too long to index directly
    endpoint_hash CHAR(64) NOT NULL UNIQUE,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_user_id ON push_subscriptions(user_id);

-- Per-user do-not-disturb (no row = notifications on, no quiet hours)
CREATE TABLE IF NOT EXISTS notification_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dnd_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    -- 'HH:MM' in the user's timezone; start > end means the window crosses midnight
    quiet_start CHAR(5) NULL,
    quiet_end CHAR(5) NULL,
    -- IANA name, e.g. 'Europe/Berlin'
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
