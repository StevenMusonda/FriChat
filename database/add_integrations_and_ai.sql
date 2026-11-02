-- Phase 15: incoming webhooks and optional AI features (MySQL)
-- Run once after add_account_security.sql, BEFORE starting the new server: every message read
-- selects messages.bot_name and privacy settings read ai_features.
--
-- Webhook tokens are stored as SHA-256 hashes only. Message text is never stored for AI usage: the
-- only copies are the translations a member asked for, which go when the message is edited or deleted.

-- Who posted a webhook message: bot_name is what the chat shows, webhook_id a plain number that
-- outlives the webhook
ALTER TABLE messages
    ADD COLUMN webhook_id INT NULL,
    ADD COLUMN bot_name VARCHAR(50) NULL;

ALTER TABLE group_members
    ADD COLUMN ai_disabled BOOLEAN NOT NULL DEFAULT FALSE, -- AI off in this chat for this member
    -- Opening a chat marks it read: this keeps where it was while "Summarize unread" is on offer
    ADD COLUMN catchup_from_message_id INT NULL,
    ADD COLUMN catchup_at TIMESTAMP NULL DEFAULT NULL;

ALTER TABLE privacy_settings
    ADD COLUMN ai_features BOOLEAN NOT NULL DEFAULT TRUE, -- off: nothing of yours goes to the AI provider
    ADD COLUMN ai_consent_at TIMESTAMP NULL DEFAULT NULL, -- NULL = hasn't agreed yet
    ADD COLUMN translation_language VARCHAR(10) NULL; -- NULL = English

-- Incoming webhooks: a secret URL that posts into a group
CREATE TABLE IF NOT EXISTS chat_webhooks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    name VARCHAR(50) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL DEFAULT NULL,
    revoked_at TIMESTAMP NULL DEFAULT NULL,
    revoked_by INT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY uq_chat_webhook_token (token_hash),
    INDEX idx_chat_webhooks_chat (chat_id)
);

-- One cached translation per message and language
CREATE TABLE IF NOT EXISTS message_translations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    language VARCHAR(10) NOT NULL,
    translated_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    UNIQUE KEY uq_message_translation (message_id, language)
);

-- AI caps: scope is 'user:<id>' with period YYYY-MM-DD, or 'global' with period YYYY-MM (UTC)
CREATE TABLE IF NOT EXISTS ai_usage_counters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    scope VARCHAR(30) NOT NULL,
    period VARCHAR(10) NOT NULL,
    requests INT NOT NULL DEFAULT 0,
    tokens BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ai_usage_scope (scope, period),
    INDEX idx_ai_usage_counters_updated (updated_at)
);

-- Token usage per request. Never message text.
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    feature VARCHAR(20) NOT NULL, -- summary | translation
    model VARCHAR(60) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    outcome VARCHAR(20) NOT NULL, -- ok | refused | error
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_ai_usage_log_created (created_at)
);
