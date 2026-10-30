-- Phase 11: 1:1 voice and video calls (PostgreSQL)
-- Run after add_voice_notes_and_disappearing_postgresql.sql. Safe to run more than once.
--
-- One row per call attempt in a direct chat. The live call (ringing, signaling) is held in the
-- server's memory; this table is the history behind the Calls tab and the "Missed video call" notices.
CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_type VARCHAR(5) NOT NULL CHECK (call_type IN ('voice', 'video')),
    -- ringing | active | completed | missed | declined | cancelled | busy | failed
    status VARCHAR(10) NOT NULL DEFAULT 'ringing',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,   -- when the caller rang
    answered_at TIMESTAMP NULL,                        -- when the callee accepted (NULL = never)
    ended_at TIMESTAMP NULL,
    end_reason VARCHAR(20) NULL                        -- hangup | timeout | connection_failed | ...
);

CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_chat ON calls(chat_id);
