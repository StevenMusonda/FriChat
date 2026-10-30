-- Phase 11: 1:1 voice and video calls (MySQL)
-- Run once after add_voice_notes_and_disappearing.sql.
--
-- One row per call attempt in a direct chat. The live call (ringing, signaling) is held in the
-- server's memory; this table is the history behind the Calls tab and the "Missed video call" notices.
CREATE TABLE IF NOT EXISTS calls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    caller_id INT NOT NULL,
    callee_id INT NOT NULL,
    call_type ENUM('voice', 'video') NOT NULL,
    -- ringing | active | completed | missed | declined | cancelled | busy | failed
    status VARCHAR(10) NOT NULL DEFAULT 'ringing',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,   -- when the caller rang
    answered_at TIMESTAMP NULL DEFAULT NULL,           -- when the callee accepted (NULL = never)
    ended_at TIMESTAMP NULL DEFAULT NULL,
    end_reason VARCHAR(20) NULL DEFAULT NULL,           -- hangup | timeout | connection_failed | ...
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (callee_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_calls_caller (caller_id, started_at),
    INDEX idx_calls_callee (callee_id, started_at),
    INDEX idx_calls_chat (chat_id)
);
