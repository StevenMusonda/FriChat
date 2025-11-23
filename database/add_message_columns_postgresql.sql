-- Add missing columns to messages table for PostgreSQL
-- Run this after schema_postgresql.sql

-- Add deleted_at column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='messages' AND column_name='deleted_at') THEN
        ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMP NULL;
    END IF;
END $$;

-- Add deleted_by column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='messages' AND column_name='deleted_by') THEN
        ALTER TABLE messages ADD COLUMN deleted_by INTEGER NULL;
    END IF;
END $$;

-- Add deleted_for_everyone column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='messages' AND column_name='deleted_for_everyone') THEN
        ALTER TABLE messages ADD COLUMN deleted_for_everyone BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Add index on deleted_at
CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);

-- Add foreign key for deleted_by (if column was just created)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name='fk_messages_deleted_by') THEN
        ALTER TABLE messages 
        ADD CONSTRAINT fk_messages_deleted_by 
        FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;
