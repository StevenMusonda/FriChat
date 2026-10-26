-- Delete-for-everyone columns on messages (PostgreSQL)
-- Same result as add_message_columns_postgresql.sql; if you already ran that one, this is a no-op.
-- Safe to run more than once.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE constraint_name = 'fk_messages_deleted_by') THEN
        ALTER TABLE messages
        ADD CONSTRAINT fk_messages_deleted_by
        FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;
