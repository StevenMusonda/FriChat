-- One reaction per user per message (PostgreSQL)
-- Fresh installs already have UNIQUE (message_id, user_id). This brings older databases that still
-- have UNIQUE (message_id, user_id, emoji) in line (it also covers fix_reactions_constraint.sql,
-- but first removes the duplicates that would make that file fail).
-- Run after add_mentions_and_link_previews_postgresql.sql. Safe to run more than once.

-- Keep only the newest reaction (highest id) per user and message
DELETE FROM message_reactions r_old
USING message_reactions r_new
WHERE r_new.message_id = r_old.message_id
  AND r_new.user_id = r_old.user_id
  AND r_new.id > r_old.id;

ALTER TABLE message_reactions DROP CONSTRAINT IF EXISTS message_reactions_message_id_user_id_emoji_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'message_reactions'::regclass
          AND conname = 'message_reactions_message_id_user_id_key'
    ) THEN
        ALTER TABLE message_reactions
            ADD CONSTRAINT message_reactions_message_id_user_id_key UNIQUE (message_id, user_id);
    END IF;
END $$;
