-- Phase 2: Web Push subscriptions and do-not-disturb settings (MySQL)
-- Run after add_read_state.sql. Safe to run more than once.

-- One row per browser/device that allowed notifications
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    -- Push service URLs can be long; hashed so it can carry a UNIQUE index under InnoDB's key size limit
    endpoint TEXT NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_push_endpoint (endpoint_hash),
    INDEX idx_push_user_id (user_id)
);

-- Per-user do-not-disturb (no row = notifications on, no quiet hours)
CREATE TABLE IF NOT EXISTS notification_settings (
    user_id INT PRIMARY KEY,
    dnd_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    -- 'HH:MM' in the user's timezone; start > end means the window crosses midnight
    quiet_start CHAR(5) NULL,
    quiet_end CHAR(5) NULL,
    -- IANA name, e.g. 'Europe/Berlin'
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
