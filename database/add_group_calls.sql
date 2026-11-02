-- Phase 16: small group voice and video calls (MySQL)
-- Run once after add_integrations_and_ai.sql.
--
-- A group call is a row in calls with callee_id NULL; who joined is kept in call_participants (one
-- row per person, whatever the number of rejoins). The live room is held in the server's memory.
ALTER TABLE calls MODIFY callee_id INT NULL;

CREATE TABLE IF NOT EXISTS call_participants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    call_id INT NOT NULL,
    user_id INT NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,   -- first time this person joined
    left_at TIMESTAMP NULL DEFAULT NULL,             -- last time they left (NULL = still in the call)
    FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_call_participant (call_id, user_id),
    INDEX idx_call_participants_user (user_id)
);
