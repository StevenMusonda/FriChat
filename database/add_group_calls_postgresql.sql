-- Phase 16: small group voice and video calls (PostgreSQL)
-- Run after add_integrations_and_ai_postgresql.sql. Safe to run more than once.
--
-- A group call is a row in calls with callee_id NULL; who joined is kept in call_participants (one
-- row per person, whatever the number of rejoins). The live room is held in the server's memory.
ALTER TABLE calls ALTER COLUMN callee_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS call_participants (
    id SERIAL PRIMARY KEY,
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,   -- first time this person joined
    left_at TIMESTAMP NULL,                          -- last time they left (NULL = still in the call)
    UNIQUE (call_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id);
