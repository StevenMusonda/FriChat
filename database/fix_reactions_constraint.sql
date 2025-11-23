-- Fix message_reactions unique constraint
-- Run this in pgAdmin on your Render PostgreSQL database

-- Drop the old constraint
ALTER TABLE message_reactions DROP CONSTRAINT IF EXISTS message_reactions_message_id_user_id_emoji_key;

-- Add the new constraint (one reaction per user per message)
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_message_id_user_id_key UNIQUE (message_id, user_id);
