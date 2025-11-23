/**
 * Messages Module
 * Handles message display, sending, and file uploads
 */

let currentMessages = [];

/**
 * Load messages for a chat
 */
async function loadMessages(chatId, limit = 50, offset = 0) {
    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.MESSAGES(chatId)}?limit=${limit}&offset=${offset}`);
        
        if (response.success) {
            currentMessages = response.data || [];
            renderMessages(currentMessages);
            scrollToBottom();
            
            // Mark unread messages as read
            await markMessagesAsRead(chatId);
        }
    } catch (error) {
        console.error('Load messages error:', error);
    }
}

/**
 * Mark messages as read
 */
async function markMessagesAsRead(chatId) {
    try {
        const currentUser = getCurrentUser();
        
        // Find messages that are not sent by current user and are not already read
        const unreadMessages = currentMessages.filter(msg => 
            msg.sender_id !== currentUser.userId && 
            msg.status !== 'read'
        );
        
        // Mark each unread message as read
        for (const message of unreadMessages) {
            await apiRequest(`/messages/${message.id}/status`, {
                method: 'PUT',
                body: { status: 'read' }
            });
            
            // Notify via socket
            updateMessageStatusViaSocket(message.id, 'read');
            
            // Update local message status
            message.status = 'read';
        }
        
        // Re-render to show updated status
        if (unreadMessages.length > 0) {
            renderMessages(currentMessages);
            
            // Update chat list to remove unread badge
            updateChatUnreadCount(chatId, 0);
        }
    } catch (error) {
        console.error('Mark messages as read error:', error);
    }
}

/**
 * Update unread count badge in chat list
 */
function updateChatUnreadCount(chatId, count) {
    const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
    if (!chatItem) return;
    
    // Remove existing badge
    const existingBadge = chatItem.querySelector('.unread-badge');
    if (existingBadge) {
        existingBadge.remove();
    }
    
    // Add new badge if count > 0
    if (count > 0) {
        const badge = document.createElement('div');
        badge.className = 'unread-badge';
        badge.textContent = count;
        chatItem.appendChild(badge);
    }
}

/**
 * Render messages in chat window
 */
function renderMessages(messages) {
    const container = document.getElementById('messagesContainer');
    const currentUser = getCurrentUser();
    
    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>No messages yet. Start the conversation!</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = messages.map(message => {
        const isSent = message.sender_id === currentUser.userId;
        const senderInitial = (message.full_name || message.username).charAt(0).toUpperCase();
        
        // Parse reactions if they exist
        let reactions = [];
        if (message.reactions && typeof message.reactions === 'string') {
            try {
                reactions = JSON.parse(message.reactions) || [];
            } catch (e) {
                reactions = [];
            }
        } else if (Array.isArray(message.reactions)) {
            reactions = message.reactions;
        }
        
        // Group reactions by emoji
        const groupedReactions = {};
        reactions.forEach(reaction => {
            if (!groupedReactions[reaction.emoji]) {
                groupedReactions[reaction.emoji] = [];
            }
            groupedReactions[reaction.emoji].push(reaction);
        });
        
        // Check if message is deleted
        const isDeleted = message.is_deleted || message.deleted_at;
        
        if (isDeleted && message.deleted_for_everyone) {
            return `
                <div class="message ${isSent ? 'sent' : 'received'}" data-message-id="${message.id}">
                    <div class="message-avatar">${senderInitial}</div>
                    <div class="message-content">
                        ${!isSent ? `<div class="message-sender">${escapeHtml(message.full_name || message.username)}</div>` : ''}
                        <div class="message-bubble">
                            <div class="message-deleted">🚫 This message was deleted</div>
                        </div>
                        <div class="message-footer">
                            <span class="message-time">${formatTime(message.created_at)}</span>
                        </div>
                    </div>
                </div>
            `;
        }
        
        // Don't show message if deleted for current user only
        if (isDeleted) return '';
        
        return `
            <div class="message ${isSent ? 'sent' : 'received'}" data-message-id="${message.id}">
                <div class="message-actions">
                    <button class="message-action-btn" onclick="showMessageActions(${message.id}, event)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1"></circle>
                            <circle cx="19" cy="12" r="1"></circle>
                            <circle cx="5" cy="12" r="1"></circle>
                        </svg>
                    </button>
                </div>
                <div class="message-avatar">${senderInitial}</div>
                <div class="message-content">
                    ${!isSent ? `<div class="message-sender">${escapeHtml(message.full_name || message.username)}</div>` : ''}
                    <div class="message-bubble">
                        ${renderMessageContent(message)}
                        ${renderMessageReactions(groupedReactions, message.id)}
                    </div>
                    <div class="message-footer">
                        <span class="message-time">${formatTime(message.created_at)}</span>
                        ${isSent ? `<span class="message-status">${getStatusIcon(message.status)}</span>` : ''}
                        <button class="icon-btn message-react-btn" onclick="event.stopPropagation(); showEmojiPicker(${message.id})">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                                <line x1="9" y1="9" x2="9.01" y2="9"></line>
                                <line x1="15" y1="9" x2="15.01" y2="9"></line>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Get full file URL
 */
function getFileUrl(uploadPath) {
    if (!uploadPath) return '';
    
    console.log('Original upload_path:', uploadPath);
    
    // Get base URL without /api
    const baseUrl = CONFIG.SOCKET_URL || CONFIG.API_BASE_URL.replace('/api', '');
    
    // Clean the path - handle backslashes from Windows paths
    let cleanPath = uploadPath.replace(/\\/g, '/');
    
    // Remove leading slash if present
    if (cleanPath.startsWith('/')) {
        cleanPath = cleanPath.substring(1);
    }
    
    // Fix missing slashes between path segments
    // This handles cases like "uploadsimagesfile.png" -> "uploads/images/file.png"
    cleanPath = cleanPath
        .replace(/uploads([^/])/i, 'uploads/$1')
        .replace(/images([^/])/i, 'images/$1')
        .replace(/videos([^/])/i, 'videos/$1')
        .replace(/files([^/])/i, 'files/$1');
    
    const finalUrl = `${baseUrl}/${cleanPath}`;
    console.log('File URL constructed:', finalUrl);
    return finalUrl;
}

/**
 * Render message content based on type
 */
function renderMessageContent(message) {
    switch (message.message_type) {
        case 'text':
            return `<div class="message-text">${escapeHtml(message.content)}</div>`;
        
        case 'image':
            const imageUrl = getFileUrl(message.upload_path);
            console.log('Image URL:', imageUrl);
            return `
                <div class="message-media">
                    <img src="${imageUrl}" 
                         alt="${escapeHtml(message.file_name)}"
                         onclick="openImageModal('${imageUrl}')">
                </div>
            `;
        
        case 'video':
            const videoUrl = getFileUrl(message.upload_path);
            return `
                <div class="message-media">
                    <video controls>
                        <source src="${videoUrl}" type="${message.mime_type || 'video/mp4'}">
                        Your browser does not support video playback.
                    </video>
                </div>
            `;
        
        case 'file':
            const fileSize = formatFileSize(message.file_size);
            const fileUrl = getFileUrl(message.upload_path);
            return `
                <div class="message-file">
                    <div class="message-file-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                            <polyline points="13 2 13 9 20 9"></polyline>
                        </svg>
                    </div>
                    <div class="message-file-info">
                        <div class="message-file-name">${escapeHtml(message.file_name)}</div>
                        <div class="message-file-size">${fileSize}</div>
                    </div>
                    <a href="${fileUrl}" 
                       download="${escapeHtml(message.file_name)}"
                       class="icon-btn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                    </a>
                </div>
            `;
        
        default:
            return `<div class="message-text">Unsupported message type</div>`;
    }
}

/**
 * Render message reactions
 */
function renderMessageReactions(groupedReactions, messageId) {
    const reactionKeys = Object.keys(groupedReactions);
    
    if (reactionKeys.length === 0) {
        return '';
    }
    
    const reactionsHtml = reactionKeys.map(emoji => {
        const users = groupedReactions[emoji];
        const currentUser = getCurrentUser();
        const hasUserReacted = users.some(u => u.userId === currentUser.userId);
        
        return `
            <span class="reaction ${hasUserReacted ? 'user-reacted' : ''}" 
                  onclick="toggleReaction(${messageId}, '${emoji}')"
                  title="${users.map(u => u.username).join(', ')}">
                ${emoji} ${users.length}
            </span>
        `;
    }).join('');
    
    return `<div class="message-reactions">${reactionsHtml}</div>`;
}

/**
 * Get status icon
 */
function getStatusIcon(status) {
    switch (status) {
        case 'sent':
            return '✓';
        case 'delivered':
            return '✓✓';
        case 'read':
            return '<span style="color: var(--primary-color)">✓✓</span>';
        default:
            return '';
    }
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Send a text message
 */
async function sendTextMessage(chatId, content) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.SEND_MESSAGE, {
            method: 'POST',
            body: JSON.stringify({
                chatId: chatId,
                messageType: 'text',
                content: content
            })
        });
        
        if (response.success) {
            // Message will be added via WebSocket
            return response;
        }
        
        return response;
    } catch (error) {
        console.error('Send message error:', error);
        return { success: false, message: 'Failed to send message' };
    }
}

/**
 * Upload and send file
 */
async function uploadFile(chatId, file) {
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('chatId', chatId);
        
        const token = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
        
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.UPLOAD_FILE}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Message will be added via WebSocket
            return data;
        }
        
        return data;
    } catch (error) {
        console.error('Upload file error:', error);
        return { success: false, message: 'Failed to upload file' };
    }
}

/**
 * Toggle reaction on message
 */
async function toggleReaction(messageId, emoji) {
    const currentUser = getCurrentUser();
    const message = currentMessages.find(m => m.id === messageId);
    
    if (!message) return;
    
    // Check if user already reacted with this emoji
    let reactions = [];
    if (message.reactions && typeof message.reactions === 'string') {
        try {
            reactions = JSON.parse(message.reactions) || [];
        } catch (e) {
            reactions = [];
        }
    } else if (Array.isArray(message.reactions)) {
        reactions = message.reactions;
    }
    
    const hasReacted = reactions.some(r => r.userId === currentUser.userId && r.emoji === emoji);
    
    if (hasReacted) {
        // Remove reaction
        removeReactionViaSocket(messageId, emoji);
    } else {
        // Add reaction
        addReactionViaSocket(messageId, emoji);
    }
}

/**
 * Scroll to bottom of messages
 */
function scrollToBottom() {
    const container = document.getElementById('messagesContainer');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

/**
 * Add new message to UI
 */
function addMessageToUI(message) {
    currentMessages.push(message);
    renderMessages(currentMessages);
    scrollToBottom();
}

/**
 * Update message status in UI
 */
function updateMessageStatusInUI(messageId, status) {
    const message = currentMessages.find(m => m.id === messageId);
    if (message) {
        message.status = status;
        
        // Update the status icon
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const statusElement = messageElement.querySelector('.message-status');
            if (statusElement) {
                statusElement.innerHTML = getStatusIcon(status);
            }
        }
    }
}

/**
 * Initialize message input
 */
function initializeMessageInput() {
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    
    let typingTimeout;
    
    // Typing indicator
    messageInput.addEventListener('input', () => {
        if (currentChatId) {
            sendTypingIndicator(currentChatId, true);
            
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                sendTypingIndicator(currentChatId, false);
            }, 1000);
        }
    });
    
    // Send message on Enter
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // Send button
    sendBtn.addEventListener('click', sendMessage);
    
    // Attach button
    attachBtn.addEventListener('click', () => {
        fileInput.click();
    });
    
    // File input
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        
        for (const file of files) {
            if (!currentChatId) {
                alert('Please select a chat first');
                return;
            }
            
            // Show uploading indicator
            const uploadingMessage = document.createElement('div');
            uploadingMessage.className = 'message sent';
            uploadingMessage.innerHTML = `
                <div class="message-content">
                    <div class="message-bubble">
                        <div class="message-text">Uploading ${escapeHtml(file.name)}...</div>
                    </div>
                </div>
            `;
            document.getElementById('messagesContainer').appendChild(uploadingMessage);
            scrollToBottom();
            
            // Upload file
            const result = await uploadFile(currentChatId, file);
            
            // Remove uploading indicator
            uploadingMessage.remove();
            
            if (!result.success) {
                alert(result.message || 'Failed to upload file');
            }
        }
        
        // Clear file input
        fileInput.value = '';
    });
}

/**
 * Send message
 */
async function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const content = messageInput.value.trim();
    
    if (!content || !currentChatId) {
        return;
    }
    
    // Clear input
    messageInput.value = '';
    
    // Send via WebSocket (faster) or API
    if (window.socket && window.socket.connected) {
        sendMessageViaSocket(currentChatId, 'text', content);
    } else {
        await sendTextMessage(currentChatId, content);
    }
}

/**
 * Handle message status updates from WebSocket
 */
function handleMessageStatusUpdate(data) {
    const { messageId, status } = data;
    
    // Find and update message in current messages
    const message = currentMessages.find(m => m.id === messageId);
    if (message) {
        message.status = status;
        
        // Update UI
        const statusElement = document.querySelector(`[data-message-id="${messageId}"] .message-status`);
        if (statusElement) {
            statusElement.innerHTML = getStatusIcon(status);
        }
    }
}

// Register message status handler
if (typeof onMessageStatus === 'function') {
    onMessageStatus(handleMessageStatusUpdate);
}

/**
 * Handle reaction update from WebSocket
 */
function handleReactionUpdate(data, action) {
    const { messageId, userId, username, emoji } = data;
    
    // Find message in current messages array
    const message = currentMessages.find(m => m.id === messageId);
    if (!message) return;
    
    // Parse existing reactions
    let reactions = [];
    if (message.reactions && typeof message.reactions === 'string') {
        try {
            reactions = JSON.parse(message.reactions) || [];
        } catch (e) {
            reactions = [];
        }
    } else if (Array.isArray(message.reactions)) {
        reactions = message.reactions;
    }
    
    if (action === 'add') {
        // Add new reaction
        reactions.push({
            userId: userId,
            username: username,
            emoji: emoji
        });
    } else if (action === 'remove') {
        // Remove reaction
        reactions = reactions.filter(r => !(r.userId === userId && r.emoji === emoji));
    }
    
    // Update message reactions
    message.reactions = reactions;
    
    // Re-render just this message
    renderMessages(currentMessages);
}

// Make functions globally accessible
if (typeof window !== 'undefined') {
    window.toggleReaction = toggleReaction;
    window.handleReactionUpdate = handleReactionUpdate;
}
