/**
 * Message Controller
 * Handles message retrieval, sending, and reactions
 */

const { executeQuery, queryOne, insertAndGetId } = require('../config/database');
const { cleanMessageText } = require('../utils/messageText');
const path = require('path');
const { recordNewMessage } = require('../utils/chatState');
const { notifyNewMessage } = require('../utils/push');
const { saveMentions, replaceMentions, attachMentions } = require('../utils/mentions');
const { attachLinkPreview } = require('../utils/linkPreview');
const reactionRules = require('../utils/reactions');
const { messageTypeForMime, resolveUploadPath, claimUploadedFile, releaseUploadedFile } = require('../utils/uploads');
const {
    MESSAGE_COLUMNS,
    MESSAGE_JOINS,
    toBool,
    shapeMessage,
    getMessageById,
    checkReplyTarget,
    editWindowCondition
} = require('../utils/messageQueries');

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/**
 * Get a page of messages for a chat, newest first from the server's point of view
 * Query: limit (default 30, max 100), before (message id cursor - returns messages older than it)
 * Response data is oldest-first; pagination.nextCursor is passed back as `before` for the next older page
 */
async function getMessages(req, res) {
    try {
        const { chatId } = req.params;
        const userId = req.user.id;
        const limit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
        const before = parseInt(req.query.before) || null;

        // Check if user is a member of this chat
        const membership = await queryOne(
            'SELECT id, last_read_message_id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        const params = [userId, userId, chatId];
        let cursorClause = '';
        if (before) {
            cursorClause = 'AND m.id < ?';
            params.push(before);
        }

        // Ids only ever increase, so they make a stable cursor (timestamps can tie).
        // Messages deleted "for me" are filtered here so they don't eat into the page.
        // limit is a validated integer, inlined because mysql2 rejects a bound LIMIT on some servers.
        const rows = await executeQuery(`
            SELECT
                ${MESSAGE_COLUMNS},
                m.deleted_at,
                m.deleted_for_everyone,
                CASE
                    WHEN m.deleted_for_everyone = TRUE THEN TRUE
                    WHEN dm.id IS NOT NULL THEN TRUE
                    ELSE FALSE
                END as is_deleted,
                CASE WHEN sm.id IS NULL THEN FALSE ELSE TRUE END as is_starred
            FROM messages m
            ${MESSAGE_JOINS}
            LEFT JOIN deleted_messages dm ON m.id = dm.message_id AND dm.user_id = ?
            LEFT JOIN starred_messages sm ON m.id = sm.message_id AND sm.user_id = ?
            WHERE m.chat_id = ?
            ${cursorClause}
            AND (dm.id IS NULL OR m.deleted_for_everyone = TRUE)
            ORDER BY m.id DESC
            LIMIT ${limit + 1}
        `, params);

        // The extra row only tells us whether an older page exists
        const hasMore = rows.length > limit;
        const messages = rows.slice(0, limit).map(shapeMessage);

        // Nothing of a deleted message goes out, including what it quoted
        for (const message of messages) {
            if (toBool(message.deleted_for_everyone)) {
                message.content = null;
                message.reply_to = null;
                message.link_preview = null;
            }
        }

        // Who each message mentions (one query, only for pages with '@' in them)
        await attachMentions(messages);

        // Reactions for the whole page in one query
        if (messages.length > 0) {
            const ids = messages.map(m => m.id);
            const reactions = await executeQuery(`
                SELECT
                    mr.message_id,
                    mr.user_id,
                    ru.username,
                    mr.emoji
                FROM message_reactions mr
                JOIN users ru ON mr.user_id = ru.id
                WHERE mr.message_id IN (${ids.map(() => '?').join(', ')})
            `, ids);

            // Keyed here rather than with a SQL alias - PostgreSQL would lowercase "userId"
            const byMessage = {};
            for (const reaction of reactions) {
                (byMessage[reaction.message_id] = byMessage[reaction.message_id] || []).push({
                    userId: reaction.user_id,
                    username: reaction.username,
                    emoji: reaction.emoji
                });
            }

            for (const message of messages) {
                message.reactions = byMessage[message.id] ? JSON.stringify(byMessage[message.id]) : null;
            }
        }

        messages.reverse(); // Oldest first

        res.json({
            success: true,
            data: messages,
            pagination: {
                hasMore: hasMore,
                // Oldest message on this page; send as `before` to get the next older page
                nextCursor: hasMore ? messages[0].id : null
            },
            lastReadMessageId: membership.last_read_message_id || null
        });
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve messages',
            error: error.message
        });
    }
}

/**
 * Send a text message, or attach a file uploaded earlier (body.fileId from POST /upload without chatId)
 */
async function sendMessage(req, res) {
    try {
        const { chatId, content } = req.body;
        let { messageType = 'text' } = req.body;
        const replyToMessageId = req.body.replyToMessageId || null;
        const userId = req.user.id;
        const hasFile = req.body.fileId !== undefined && req.body.fileId !== null;

        if (!hasFile && messageType !== 'text') {
            return res.status(400).json({
                success: false,
                message: 'A file is required for this message type'
            });
        }

        // Stored raw (clients escape on render), same rule as every other send path
        const cleaned = cleanMessageText(content, { required: !hasFile });
        if (!cleaned.ok) {
            return res.status(400).json({
                success: false,
                message: cleaned.error
            });
        }

        // Check if user is a member of this chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        if (replyToMessageId) {
            const replyError = await checkReplyTarget(chatId, replyToMessageId);
            if (replyError) {
                return res.status(400).json({
                    success: false,
                    message: replyError
                });
            }
        }

        // Claimed last, so a send that fails a check above leaves the upload usable
        let fileId = null;
        if (hasFile) {
            const claim = await claimUploadedFile(req.body.fileId, userId);
            if (claim.error) {
                return res.status(400).json({
                    success: false,
                    message: claim.error
                });
            }
            fileId = claim.file.id;
            messageType = claim.file.messageType; // from the server's upload record, not the client
        }

        // Insert message
        let messageId;
        try {
            messageId = await insertAndGetId(
                'INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, reply_to_message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [chatId, userId, messageType, cleaned.text, fileId, replyToMessageId, 'sent']
            );
        } catch (error) {
            if (fileId) await releaseUploadedFile(fileId);
            throw error;
        }

        // @mentions of group members (before reading the message back, so it carries them)
        await saveMentions(chatId, messageId, userId, cleaned.text);

        // Update chat updated_at
        await executeQuery(
            'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [chatId]
        );

        // Un-archive for members who haven't muted it; sender has now read up to here
        await recordNewMessage(req.io, chatId, userId, messageId || null);

        // Get the created message
        const message = await getMessageById(messageId);

        // Emit message via WebSocket to all chat members
        if (req.io && message) {
            req.io.to(`chat_${chatId}`).emit('new_message', message);
        }

        // Push to members who aren't watching (not awaited - never delays or fails the send)
        notifyNewMessage(req.io, message);

        // Preview card for the first link, broadcast as message_link_preview when ready (not awaited)
        attachLinkPreview(req.io, message);

        res.status(201).json({
            success: true,
            message: 'Message sent successfully',
            data: message
        });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message
        });
    }
}

/**
 * Upload and send a file/image/video message.
 * Without chatId the file is only stored: the response carries its fileId, which a later
 * send (REST or socket) attaches to a message. Every file field comes from multer, never the client.
 */
async function uploadFile(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const { chatId } = req.body;
        const replyToMessageId = req.body.replyToMessageId || null;
        const userId = req.user.id;

        if (!chatId) {
            const fileId = await insertAndGetId(
                'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    req.file.originalname,
                    req.file.filename,
                    path.extname(req.file.originalname),
                    req.file.size,
                    req.file.mimetype,
                    req.file.path,
                    userId
                ]
            );

            return res.status(201).json({
                success: true,
                message: 'File uploaded',
                data: {
                    fileId,
                    messageType: messageTypeForMime(req.file.mimetype),
                    originalName: req.file.originalname,
                    fileSize: req.file.size
                }
            });
        }

        // Check if user is a member of this chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        if (replyToMessageId) {
            const replyError = await checkReplyTarget(chatId, replyToMessageId);
            if (replyError) {
                return res.status(400).json({
                    success: false,
                    message: replyError
                });
            }
        }

        // Determine message type based on file mimetype
        const messageType = messageTypeForMime(req.file.mimetype);

        // Save file metadata to database
        let fileId;
        if (process.env.DB_TYPE === 'postgresql') {
            const fileResult = await executeQuery(
                'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id',
                [
                    req.file.originalname,
                    req.file.filename,
                    path.extname(req.file.originalname),
                    req.file.size,
                    req.file.mimetype,
                    req.file.path,
                    userId
                ]
            );
            fileId = fileResult[0]?.id;
        } else {
            const fileResult = await executeQuery(
                'INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [
                    req.file.originalname,
                    req.file.filename,
                    path.extname(req.file.originalname),
                    req.file.size,
                    req.file.mimetype,
                    req.file.path,
                    userId
                ]
            );
            fileId = fileResult.insertId;
        }

        // Create message with file reference
        let messageId;
        if (process.env.DB_TYPE === 'postgresql') {
            const messageResult = await executeQuery(
                'INSERT INTO messages (chat_id, sender_id, message_type, file_id, reply_to_message_id, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
                [chatId, userId, messageType, fileId, replyToMessageId, 'sent']
            );
            messageId = messageResult[0]?.id;
        } else {
            const messageResult = await executeQuery(
                'INSERT INTO messages (chat_id, sender_id, message_type, file_id, reply_to_message_id, status) VALUES (?, ?, ?, ?, ?, ?)',
                [chatId, userId, messageType, fileId, replyToMessageId, 'sent']
            );
            messageId = messageResult.insertId;
        }

        // Update chat updated_at
        await executeQuery(
            'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [chatId]
        );

        // Un-archive for members who haven't muted it; sender has now read up to here
        await recordNewMessage(req.io, chatId, userId, messageId || null);

        // Get the created message
        const message = await getMessageById(messageId);

        // Emit message via WebSocket to all chat members
        if (req.io && message) {
            req.io.to(`chat_${chatId}`).emit('new_message', message);
        }

        // Push to members who aren't watching (not awaited - never delays or fails the send)
        notifyNewMessage(req.io, message);

        res.status(201).json({
            success: true,
            message: 'File uploaded successfully',
            data: message
        });
    } catch (error) {
        console.error('Upload file error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload file',
            error: error.message
        });
    }
}

/**
 * Update message status (delivered/read)
 */
async function updateMessageStatus(req, res) {
    try {
        const { messageId } = req.params;
        const { status } = req.body;
        const userId = req.user.id;

        // Verify message exists and user has access
        const message = await queryOne(`
            SELECT m.id, m.chat_id
            FROM messages m
            JOIN group_members gm ON m.chat_id = gm.chat_id
            WHERE m.id = ? AND gm.user_id = ?
        `, [messageId, userId]);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or access denied'
            });
        }

        // Update status
        await executeQuery(
            'UPDATE messages SET status = ? WHERE id = ?',
            [status, messageId]
        );

        res.json({
            success: true,
            message: 'Message status updated'
        });
    } catch (error) {
        console.error('Update message status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update message status',
            error: error.message
        });
    }
}

/**
 * React to a message: adds, replaces the user's other emoji, or removes the same emoji (toggle)
 */
async function addReaction(req, res) {
    try {
        const result = await reactionRules.toggleReaction(req.params.messageId, req.user.id, req.body.emoji);
        if (result.error) {
            return res.status(result.notFound ? 404 : 400).json({
                success: false,
                message: result.error
            });
        }

        reactionRules.broadcastReaction(req.io, result, req.user.username);

        res.json({
            success: true,
            message: `Reaction ${result.action}`,
            data: { action: result.action, emoji: result.emoji, previousEmoji: result.previousEmoji }
        });
    } catch (error) {
        console.error('Add reaction error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add reaction',
            error: error.message
        });
    }
}

/**
 * Remove the user's reaction from a message
 */
async function removeReaction(req, res) {
    try {
        const result = await reactionRules.removeReaction(req.params.messageId, req.user.id, req.body && req.body.emoji);
        if (result.error) {
            return res.status(result.notFound ? 404 : 400).json({
                success: false,
                message: result.error
            });
        }

        reactionRules.broadcastReaction(req.io, result);

        res.json({
            success: true,
            message: result.action ? 'Reaction removed successfully' : 'No reaction to remove'
        });
    } catch (error) {
        console.error('Remove reaction error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove reaction',
            error: error.message
        });
    }
}

/**
 * Delete message (for everyone if within 1 minute, otherwise for self only)
 */
async function deleteMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        // Get message details
        const message = await queryOne(
            'SELECT * FROM messages WHERE id = ?',
            [messageId]
        );

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        // Check if user is the sender
        if (message.sender_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You can only delete your own messages'
            });
        }

        // Still a member: a deletion for everyone is broadcast into the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [message.chat_id, userId]
        );

        if (!membership) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        // Calculate time difference
        const messageTime = new Date(message.created_at);
        const currentTime = new Date();
        const timeDiff = (currentTime - messageTime) / 1000; // in seconds

        // If within 60 seconds, delete for everyone
        if (timeDiff <= 60) {
            await executeQuery(
                'UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, deleted_for_everyone = TRUE WHERE id = ?',
                [userId, messageId]
            );

            // Open clients swap in the placeholder and blank quotes of it
            if (req.io) {
                req.io.to(`chat_${message.chat_id}`).emit('message_deleted', {
                    messageId: message.id,
                    chatId: message.chat_id,
                    deletedForEveryone: true
                });
            }

            return res.json({
                success: true,
                message: 'Message deleted for everyone',
                deletedForEveryone: true
            });
        }

        // Otherwise, delete for self only
        if (process.env.DB_TYPE === 'postgresql') {
            await executeQuery(
                'INSERT INTO deleted_messages (message_id, user_id) VALUES (?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET deleted_at = CURRENT_TIMESTAMP',
                [messageId, userId]
            );
        } else {
            await executeQuery(
                'INSERT INTO deleted_messages (message_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at = CURRENT_TIMESTAMP',
                [messageId, userId]
            );
        }

        res.json({
            success: true,
            message: 'Message deleted for you',
            deletedForEveryone: false
        });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete message',
            error: error.message
        });
    }
}

/**
 * Pin a message
 */
async function pinMessage(req, res) {
    try {
        const { messageId } = req.params;
        const { duration } = req.body; // '24h', '7d', '30d'
        const userId = req.user.id;

        console.log('Pin message request:', { messageId, duration, userId });

        // Get message details
        const message = await queryOne(
            'SELECT chat_id FROM messages WHERE id = ?',
            [messageId]
        );

        if (!message) {
            console.log('Message not found:', messageId);
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        console.log('Message found, chat_id:', message.chat_id);

        // Check if user is a member of the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [message.chat_id, userId]
        );

        if (!membership) {
            console.log('User not member of chat');
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Calculate pinned_until based on duration
        let hours = 24; // default 24 hours
        if (duration === '7d') hours = 24 * 7;
        else if (duration === '30d') hours = 24 * 30;

        const pinnedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
        console.log('Pinned until:', pinnedUntil);

        // Check if message is already pinned
        const existingPin = await queryOne(
            'SELECT id FROM pinned_messages WHERE message_id = ?',
            [messageId]
        );

        if (existingPin) {
            console.log('Updating existing pin');
            // Update existing pin
            await executeQuery(
                'UPDATE pinned_messages SET pinned_by = ?, pinned_until = ?, created_at = CURRENT_TIMESTAMP WHERE message_id = ?',
                [userId, pinnedUntil, messageId]
            );
        } else {
            console.log('Creating new pin');
            // Create new pin
            await executeQuery(
                'INSERT INTO pinned_messages (message_id, chat_id, pinned_by, pinned_until) VALUES (?, ?, ?, ?)',
                [messageId, message.chat_id, userId, pinnedUntil]
            );
        }

        // Get pinned message details
        const pinnedMessage = await queryOne(`
            SELECT 
                pm.*,
                m.content,
                m.message_type,
                u.username as pinned_by_username
            FROM pinned_messages pm
            JOIN messages m ON pm.message_id = m.id
            JOIN users u ON pm.pinned_by = u.id
            WHERE pm.message_id = ?
        `, [messageId]);

        res.json({
            success: true,
            message: 'Message pinned successfully',
            data: pinnedMessage
        });
    } catch (error) {
        console.error('Pin message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to pin message',
            error: error.message
        });
    }
}

/**
 * Unpin a message
 */
async function unpinMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        // Get pin details
        const pin = await queryOne(
            'SELECT chat_id FROM pinned_messages WHERE message_id = ?',
            [messageId]
        );

        if (!pin) {
            return res.status(404).json({
                success: false,
                message: 'Message is not pinned'
            });
        }

        // Check if user is a member of the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [pin.chat_id, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Delete pin
        await executeQuery(
            'DELETE FROM pinned_messages WHERE message_id = ?',
            [messageId]
        );

        res.json({
            success: true,
            message: 'Message unpinned successfully'
        });
    } catch (error) {
        console.error('Unpin message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unpin message',
            error: error.message
        });
    }
}

/**
 * Get pinned messages for a chat
 */
async function getPinnedMessages(req, res) {
    try {
        const { chatId } = req.params;
        const userId = req.user.id;

        // Check if user is a member of the chat
        const membership = await queryOne(
            'SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?',
            [chatId, userId]
        );

        if (!membership) {
            return res.status(403).json({
                success: false,
                message: 'Access denied to this chat'
            });
        }

        // Get pinned messages that haven't expired
        const pinnedMessages = await executeQuery(`
            SELECT 
                pm.*,
                m.content,
                m.message_type,
                m.sender_id,
                sender.username as sender_username,
                sender.full_name as sender_full_name,
                pinner.username as pinned_by_username
            FROM pinned_messages pm
            JOIN messages m ON pm.message_id = m.id
            JOIN users sender ON m.sender_id = sender.id
            JOIN users pinner ON pm.pinned_by = pinner.id
            WHERE pm.chat_id = ? AND pm.pinned_until > CURRENT_TIMESTAMP
            AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
            ORDER BY pm.created_at DESC
        `, [chatId]);

        res.json({
            success: true,
            data: pinnedMessages
        });
    } catch (error) {
        console.error('Get pinned messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve pinned messages',
            error: error.message
        });
    }
}

/**
 * Edit a text message (sender only, within EDIT_WINDOW_MINUTES, not deleted or forwarded)
 * Body: content. Broadcasts message_edited to the chat.
 */
async function editMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        const cleaned = cleanMessageText(req.body.content, { required: true });
        if (!cleaned.ok) {
            return res.status(400).json({
                success: false,
                message: cleaned.error
            });
        }
        const content = cleaned.text;

        // Membership is part of the lookup: someone who left the chat can't edit in it
        const message = await queryOne(`
            SELECT
                m.id,
                m.chat_id,
                m.sender_id,
                m.message_type,
                m.is_forwarded,
                m.deleted_for_everyone,
                m.content AS old_content,
                m.link_preview_id,
                m.link_preview_dismissed,
                CASE WHEN dm.id IS NULL THEN 0 ELSE 1 END AS deleted_for_me,
                CASE WHEN ${editWindowCondition()} THEN 1 ELSE 0 END AS within_window
            FROM messages m
            JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
            LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
            WHERE m.id = ?
        `, [userId, userId, messageId]);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or access denied'
            });
        }

        if (message.sender_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You can only edit your own messages'
            });
        }

        if (toBool(message.deleted_for_everyone) || toBool(message.deleted_for_me)) {
            return res.status(400).json({
                success: false,
                message: 'Deleted messages cannot be edited'
            });
        }

        if (message.message_type !== 'text' || toBool(message.is_forwarded)) {
            return res.status(400).json({
                success: false,
                message: 'Only text messages you wrote can be edited'
            });
        }

        // 400: reachable by simply waiting too long with the edit bar open
        if (!toBool(message.within_window)) {
            return res.status(400).json({
                success: false,
                message: 'This message can no longer be edited'
            });
        }

        // Stored raw (cleanMessageText); clients escape on render
        await executeQuery(
            `UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ? AND sender_id = ?`,
            [content, messageId, userId]
        );

        const updated = await queryOne('SELECT content, edited_at FROM messages WHERE id = ?', [messageId]);

        // Mentions follow the new text (no push for an edit); only looked up when either version has an '@'
        let mentions = [];
        if (String(message.old_content || '').includes('@') || content.includes('@')) {
            mentions = await replaceMentions(message.chat_id, message.id, userId, content);
        }

        const payload = {
            messageId: message.id,
            chatId: message.chat_id,
            content: updated ? updated.content : content,
            editedAt: updated ? updated.edited_at : new Date(),
            mentions: mentions.map(m => ({ user_id: Number(m.user_id), username: m.username }))
        };

        if (req.io) {
            req.io.to(`chat_${message.chat_id}`).emit('message_edited', payload);
        }

        // The preview follows the first link of the new text, unless the sender dismissed it (not awaited)
        if (!toBool(message.link_preview_dismissed)) {
            attachLinkPreview(req.io, {
                id: message.id,
                chat_id: message.chat_id,
                sender_id: userId,
                message_type: 'text',
                content: payload.content
            }, { hadPreview: !!message.link_preview_id });
        }

        res.json({
            success: true,
            message: 'Message edited',
            data: payload
        });
    } catch (error) {
        console.error('Edit message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to edit message',
            error: error.message
        });
    }
}

/**
 * Forward messages to chats the user belongs to.
 * Body: messageIds (1-5), chatIds (1-10). Copies keep the original file reference (no re-upload)
 * and are marked is_forwarded. Each copy is broadcast as new_message in its chat.
 */
async function forwardMessages(req, res) {
    try {
        const userId = req.user.id;
        const messageIds = [...new Set(req.body.messageIds)];
        const chatIds = [...new Set(req.body.chatIds)];

        // Only messages the user can currently see: member of their chat, not deleted for them
        const sources = await executeQuery(`
            SELECT m.id, m.message_type, m.content, m.file_id, m.deleted_for_everyone,
                   f.id AS file_row_id, f.mime_type AS file_mime_type, f.upload_path AS file_upload_path
            FROM messages m
            JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
            LEFT JOIN files f ON f.id = m.file_id
            LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
            WHERE m.id IN (${messageIds.map(() => '?').join(', ')})
            AND dm.id IS NULL
        `, [userId, userId, ...messageIds]);

        if (sources.length !== messageIds.length) {
            return res.status(404).json({
                success: false,
                message: 'One or more messages were not found'
            });
        }

        if (sources.some(m => toBool(m.deleted_for_everyone))) {
            return res.status(400).json({
                success: false,
                message: 'Deleted messages cannot be forwarded'
            });
        }

        // A file message whose file row is gone (or points outside the uploads folder) has nothing to forward
        if (sources.some(m => (m.message_type !== 'text' || m.file_id) && (!m.file_row_id || !resolveUploadPath(m.file_upload_path)))) {
            return res.status(400).json({
                success: false,
                message: 'One or more attachments are no longer available'
            });
        }

        // The copy's type follows the server's file record, not whatever the original send claimed
        for (const source of sources) {
            if (source.file_id) {
                source.message_type = messageTypeForMime(source.file_mime_type);
            }
        }

        const memberships = await executeQuery(
            `SELECT chat_id FROM group_members WHERE user_id = ? AND chat_id IN (${chatIds.map(() => '?').join(', ')})`,
            [userId, ...chatIds]
        );

        // 404: to a non-member the chat doesn't exist
        if (memberships.length !== chatIds.length) {
            return res.status(404).json({
                success: false,
                message: 'One or more chats were not found. You can only forward to chats you are a member of.'
            });
        }

        // Copies go through the same text rule as new messages
        for (const source of sources) {
            const cleaned = cleanMessageText(source.content, { required: false });
            if (!cleaned.ok) {
                return res.status(400).json({
                    success: false,
                    message: 'One or more messages cannot be forwarded'
                });
            }
            source.content = cleaned.text;
        }

        // Keep the original order
        sources.sort((a, b) => a.id - b.id);

        const forwarded = [];
        for (const chatId of chatIds) {
            let lastId = null;
            for (const source of sources) {
                lastId = await insertAndGetId(
                    'INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, is_forwarded, status) VALUES (?, ?, ?, ?, ?, TRUE, ?)',
                    [chatId, userId, source.message_type, source.content, source.file_id, 'sent']
                );

                const message = await getMessageById(lastId);
                if (message) {
                    forwarded.push(message);
                    if (req.io) {
                        req.io.to(`chat_${chatId}`).emit('new_message', message);
                    }
                    notifyNewMessage(req.io, message);
                    // Copies get their own preview (usually straight from the cache); mentions are not copied
                    attachLinkPreview(req.io, message);
                }
            }

            await executeQuery('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [chatId]);

            // Un-archive for members who haven't muted it; sender has now read up to here
            await recordNewMessage(req.io, chatId, userId, lastId);
        }

        res.status(201).json({
            success: true,
            message: `Forwarded to ${chatIds.length} chat${chatIds.length > 1 ? 's' : ''}`,
            data: forwarded
        });
    } catch (error) {
        console.error('Forward messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to forward messages',
            error: error.message
        });
    }
}

/**
 * Tell the user's other tabs that a star changed
 */
function emitStarUpdate(io, userId, messageId, chatId, starred) {
    if (io) {
        io.to(`user_${userId}`).emit('message_star_updated', {
            messageId: parseInt(messageId),
            chatId: chatId,
            starred: starred
        });
    }
}

/**
 * Star a message for the current user (idempotent)
 */
async function starMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        const message = await queryOne(`
            SELECT m.id, m.chat_id, m.deleted_for_everyone
            FROM messages m
            JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
            WHERE m.id = ?
        `, [userId, messageId]);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or access denied'
            });
        }

        if (toBool(message.deleted_for_everyone)) {
            return res.status(400).json({
                success: false,
                message: 'Deleted messages cannot be starred'
            });
        }

        if (process.env.DB_TYPE === 'postgresql') {
            await executeQuery(
                'INSERT INTO starred_messages (user_id, message_id) VALUES (?, ?) ON CONFLICT (user_id, message_id) DO NOTHING',
                [userId, messageId]
            );
        } else {
            await executeQuery(
                'INSERT INTO starred_messages (user_id, message_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
                [userId, messageId]
            );
        }

        emitStarUpdate(req.io, userId, messageId, message.chat_id, true);

        res.json({
            success: true,
            message: 'Message starred',
            data: { messageId: message.id, chatId: message.chat_id, starred: true }
        });
    } catch (error) {
        console.error('Star message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to star message',
            error: error.message
        });
    }
}

/**
 * Remove the current user's star (only ever touches their own row)
 */
async function unstarMessage(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        const star = await queryOne(`
            SELECT m.chat_id
            FROM starred_messages sm
            JOIN messages m ON m.id = sm.message_id
            WHERE sm.user_id = ? AND sm.message_id = ?
        `, [userId, messageId]);

        if (!star) {
            return res.status(404).json({
                success: false,
                message: 'Message is not starred'
            });
        }

        await executeQuery(
            'DELETE FROM starred_messages WHERE user_id = ? AND message_id = ?',
            [userId, messageId]
        );

        emitStarUpdate(req.io, userId, messageId, star.chat_id, false);

        res.json({
            success: true,
            message: 'Star removed',
            data: { messageId: parseInt(messageId), chatId: star.chat_id, starred: false }
        });
    } catch (error) {
        console.error('Unstar message error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove star',
            error: error.message
        });
    }
}

/**
 * The current user's starred messages, most recently starred first.
 * Only chats they are still a member of; deleted messages are left out.
 * Query: limit (default 30, max 100), before (star id cursor)
 */
async function getStarredMessages(req, res) {
    try {
        const userId = req.user.id;
        const limit = req.query.limit || DEFAULT_PAGE_SIZE;
        const before = req.query.before || null;

        const params = [userId, userId];
        let cursorClause = '';
        if (before) {
            cursorClause = 'AND sm.id < ?';
            params.push(before);
        }

        // limit is a validated integer (validateStarredQuery), inlined like getMessages
        const rows = await executeQuery(`
            SELECT
                ${MESSAGE_COLUMNS},
                sm.id as star_id,
                sm.created_at as starred_at,
                c.chat_type,
                c.chat_name,
                (
                    SELECT COALESCE(ou.full_name, ou.username)
                    FROM group_members ogm
                    JOIN users ou ON ou.id = ogm.user_id
                    WHERE ogm.chat_id = c.id AND ogm.user_id <> sm.user_id
                    ORDER BY ogm.id
                    LIMIT 1
                ) as direct_partner_name
            FROM starred_messages sm
            JOIN messages m ON m.id = sm.message_id
            JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = sm.user_id
            JOIN chats c ON c.id = m.chat_id
            ${MESSAGE_JOINS}
            LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
            WHERE sm.user_id = ?
            ${cursorClause}
            AND dm.id IS NULL
            AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
            ORDER BY sm.id DESC
            LIMIT ${parseInt(limit) + 1}
        `, params);

        const hasMore = rows.length > limit;
        const starred = rows.slice(0, limit).map(row => {
            const message = shapeMessage(row);
            message.is_starred = true;
            message.chat_display_name = message.chat_type === 'group'
                ? (message.chat_name || 'Group')
                : (message.direct_partner_name || message.chat_name || 'Chat');
            delete message.direct_partner_name;
            return message;
        });

        res.json({
            success: true,
            data: starred,
            pagination: {
                hasMore: hasMore,
                nextCursor: hasMore ? starred[starred.length - 1].star_id : null
            }
        });
    } catch (error) {
        console.error('Get starred messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve starred messages',
            error: error.message
        });
    }
}

/**
 * Remove the link preview from a message (sender only). It is never re-attached, also not after an edit.
 * Broadcasts message_link_preview with preview: null.
 */
async function dismissLinkPreview(req, res) {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        // Membership is part of the lookup: to a non-member the message doesn't exist
        const message = await queryOne(`
            SELECT m.id, m.chat_id, m.sender_id
            FROM messages m
            JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
            WHERE m.id = ?
        `, [userId, messageId]);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or access denied'
            });
        }

        if (message.sender_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Only the sender can remove a link preview'
            });
        }

        await executeQuery(
            'UPDATE messages SET link_preview_id = NULL, link_preview_dismissed = TRUE WHERE id = ? AND sender_id = ?',
            [messageId, userId]
        );

        const payload = { messageId: message.id, chatId: message.chat_id, preview: null };
        if (req.io) {
            req.io.to(`chat_${message.chat_id}`).emit('message_link_preview', payload);
        }

        res.json({
            success: true,
            message: 'Link preview removed',
            data: payload
        });
    } catch (error) {
        console.error('Dismiss link preview error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove link preview',
            error: error.message
        });
    }
}

module.exports = {
    dismissLinkPreview,
    getMessages,
    sendMessage,
    uploadFile,
    updateMessageStatus,
    addReaction,
    removeReaction,
    deleteMessage,
    pinMessage,
    unpinMessage,
    getPinnedMessages,
    editMessage,
    forwardMessages,
    starMessage,
    unstarMessage,
    getStarredMessages
};
