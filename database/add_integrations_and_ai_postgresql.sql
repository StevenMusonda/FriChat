-- Phase 15: incoming webhooks and optional AI features (PostgreSQL)
-- Run after add_account_security_postgresql.sql, BEFORE starting the new server: every message read
-- selects messages.bot_name and privacy settings read ai_features. Safe to run more than once.
--
-- Webhook tokens are stored as SHA-256 hashes only. Message text is never stored for AI usage: the
-- only copies are the translations a member asked for, which go when the message is edited or deleted.

-- Who posted a webhook message: bot_name is what the chat shows, webhook_id a plain number that
-- outlives the webhook
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_id INTEGER NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bot_name VARCHAR(50) NULL;

ALTER TABLE group_members ADD COLUMN IF NOT EXISTS ai_disabled BOOLEAN NOT NULL DEFAULT FALSE; -- AI off in this chat for this member
-- Opening a chat marks it read: this keeps where it was while "Summarize unread" is on offer
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS catchup_from_message_id INTEGER NULL;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS catchup_at TIMESTAMP NULL;

ALTER TABLE privacy_settings ADD COLUMN IF NOT EXISTS ai_features BOOLEAN NOT NULL DEFAULT TRUE; -- off: nothing of yours goes to the AI provider
ALTER TABLE privacy_settings ADD COLUMN IF NOT EXISTS ai_consent_at TIMESTAMP NULL; -- NULL = hasn't agreed yet
ALTER TABLE privacy_settings ADD COLUMN IF NOT EXISTS translation_language VARCHAR(10) NULL; -- NULL = English

-- Incoming webhooks: a secret URL that posts into a group
CREATE TABLE IF NOT EXISTS chat_webhooks (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    revoked_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_webhooks_chat ON chat_webhooks(chat_id);

-- One cached translation per message and language
CREATE TABLE IF NOT EXISTS message_translations (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    translated_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id, language)
);

-- AI caps: scope is 'user:<id>' with period YYYY-MM-DD, or 'global' with period YYYY-MM (UTC)
CREATE TABLE IF NOT EXISTS ai_usage_counters (
    id SERIAL PRIMARY KEY,
    scope VARCHAR(30) NOT NULL,
    period VARCHAR(10) NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    tokens BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (scope, period)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_counters_updated ON ai_usage_counters(updated_at);

-- Token usage per request. Never message text.
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature VARCHAR(20) NOT NULL, -- summary | translation
    model VARCHAR(60) NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    outcome VARCHAR(20) NOT NULL, -- ok | refused | error
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created ON ai_usage_log(created_at);
