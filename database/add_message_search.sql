-- Phase 7: message search and the shared media panel (MySQL)
-- Run once after add_security_layer.sql. Building the FULLTEXT index rebuilds the messages table,
-- so on a big database run it when few people are online.

-- Word search over message text (InnoDB; MATCH ... AGAINST in BOOLEAN MODE with prefix terms).
-- Words shorter than innodb_ft_min_token_size (3 by default) and InnoDB stopwords are matched
-- with LIKE by the server instead, so they still work.
ALTER TABLE messages ADD FULLTEXT INDEX ft_messages_content (content);

-- Shared media panel: one chat's images/videos, files or links, newest first
ALTER TABLE messages ADD INDEX idx_msg_chat_type_id (chat_id, message_type, id);
