-- Phase 7: message search and the shared media panel (PostgreSQL 12+)
-- Run after add_security_layer_postgresql.sql. Safe to run more than once.
-- Adding the stored column rewrites the messages table, so on a big database run it when few people are online.

-- Word search over message text. 'simple' = no stemming or stopwords, so any language works
-- and searches match word prefixes (to_tsquery 'term:*').
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING GIN (search_vector);

-- Shared media panel: one chat's images/videos, files or links, newest first
CREATE INDEX IF NOT EXISTS idx_msg_chat_type_id ON messages(chat_id, message_type, id);
