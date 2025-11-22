-- Sample data for testing FriChat application

-- Insert sample users
INSERT INTO users (username, email, password_hash, full_name, status) VALUES
('alice_wonder', 'alice@example.com', '$2b$10$rQ3Kz8qX9LvZ1nYm8JGqO.5K9h7vZ3Xw2Y1sT4uV6pQ7rS8tU9vW0', 'Alice Wonderland', 'online'),
('bob_builder', 'bob@example.com', '$2b$10$rQ3Kz8qX9LvZ1nYm8JGqO.5K9h7vZ3Xw2Y1sT4uV6pQ7rS8tU9vW0', 'Bob Builder', 'online'),
('charlie_choco', 'charlie@example.com', '$2b$10$rQ3Kz8qX9LvZ1nYm8JGqO.5K9h7vZ3Xw2Y1sT4uV6pQ7rS8tU9vW0', 'Charlie Chocolate', 'offline'),
('diana_prince', 'diana@example.com', '$2b$10$rQ3Kz8qX9LvZ1nYm8JGqO.5K9h7vZ3Xw2Y1sT4uV6pQ7rS8tU9vW0', 'Diana Prince', 'online'),
('eve_online', 'eve@example.com', '$2b$10$rQ3Kz8qX9LvZ1nYm8JGqO.5K9h7vZ3Xw2Y1sT4uV6pQ7rS8tU9vW0', 'Eve Online', 'away');

-- Note: All passwords are 'password123' hashed with bcrypt
-- In production, never use weak passwords like this!

-- Create direct chats
INSERT INTO chats (chat_type, created_by) VALUES
('direct', 1), -- Alice & Bob
('direct', 1), -- Alice & Charlie
('direct', 2); -- Bob & Diana

-- Create group chats
INSERT INTO chats (chat_type, chat_name, created_by) VALUES
('group', 'Development Team', 1),
('group', 'Friends Hangout', 2);

-- Add members to direct chats
INSERT INTO group_members (chat_id, user_id, role) VALUES
-- Direct chat 1: Alice & Bob
(1, 1, 'member'),
(1, 2, 'member'),
-- Direct chat 2: Alice & Charlie
(2, 1, 'member'),
(2, 3, 'member'),
-- Direct chat 3: Bob & Diana
(3, 2, 'member'),
(3, 4, 'member');

-- Add members to group chats
INSERT INTO group_members (chat_id, user_id, role) VALUES
-- Group chat 4: Development Team (Alice is admin)
(4, 1, 'admin'),
(4, 2, 'member'),
(4, 3, 'member'),
(4, 4, 'member'),
-- Group chat 5: Friends Hangout (Bob is admin)
(5, 2, 'admin'),
(5, 1, 'member'),
(5, 4, 'member'),
(5, 5, 'member');

-- Insert sample messages
INSERT INTO messages (chat_id, sender_id, message_type, content, status) VALUES
-- Messages in direct chat 1 (Alice & Bob)
(1, 1, 'text', 'Hey Bob! How are you doing?', 'read'),
(1, 2, 'text', 'Hi Alice! I''m doing great, thanks! How about you?', 'read'),
(1, 1, 'text', 'Pretty good! Working on FriChat project.', 'delivered'),
-- Messages in direct chat 2 (Alice & Charlie)
(2, 1, 'text', 'Charlie, did you see the new feature?', 'sent'),
(2, 3, 'text', 'Not yet, what is it about?', 'read'),
-- Messages in group chat 4 (Development Team)
(4, 1, 'text', 'Welcome everyone to the Development Team chat!', 'read'),
(4, 2, 'text', 'Thanks Alice! Excited to be here.', 'read'),
(4, 3, 'text', 'Let''s build something amazing!', 'read'),
(4, 4, 'text', 'Count me in! 🚀', 'delivered'),
-- Messages in group chat 5 (Friends Hangout)
(5, 2, 'text', 'Hey friends! Who''s up for a movie night?', 'read'),
(5, 1, 'text', 'I''m in! What are we watching?', 'read'),
(5, 5, 'text', 'Sounds fun! When and where?', 'delivered');

-- Insert sample reactions
INSERT INTO message_reactions (message_id, user_id, emoji) VALUES
(1, 2, '👍'),
(2, 1, '😊'),
(6, 2, '👋'),
(6, 3, '🎉'),
(6, 4, '💯'),
(10, 1, '🍿'),
(10, 4, '🎬'),
(11, 2, '👍');

-- Verify data insertion
SELECT 'Users created:' AS info, COUNT(*) AS count FROM users
UNION ALL
SELECT 'Chats created:', COUNT(*) FROM chats
UNION ALL
SELECT 'Group members added:', COUNT(*) FROM group_members
UNION ALL
SELECT 'Messages sent:', COUNT(*) FROM messages
UNION ALL
SELECT 'Reactions added:', COUNT(*) FROM message_reactions;
