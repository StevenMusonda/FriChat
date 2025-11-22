/**
 * Message Actions Module
 * Handles delete, pin, and other message actions
 */

let selectedMessageForPin = null;

/**
 * Show message actions menu
 */
function showMessageActions(messageId, event) {
    event.stopPropagation();
    
    // Remove any existing dropdowns
    document.querySelectorAll('.message-action-dropdown').forEach(d => d.remove());
    
    const message = currentMessages.find(m => m.id === messageId);
    if (!message) return;
    
    const currentUser = getCurrentUser();
    const isSent = message.sender_id === currentUser.userId;
    
    // Calculate time difference
    const messageTime = new Date(message.created_at);
    const currentTime = new Date();
    const timeDiff = (currentTime - messageTime) / 1000; // in seconds
    const canDeleteForEveryone = timeDiff <= 60;
    
    const button = event.currentTarget;
    const messageElement = button.closest('.message');
    
    const dropdown = document.createElement('div');
    dropdown.className = 'message-action-dropdown';
    dropdown.innerHTML = `
        <div class="message-action-item" onclick="pinMessage(${messageId})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2v8"/>
                <path d="M7 7l5 5 5-5"/>
            </svg>
            Pin message
        </div>
        ${isSent ? `
            <div class="message-action-item danger" onclick="deleteMessage(${messageId}, ${canDeleteForEveryone})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                ${canDeleteForEveryone ? 'Delete for everyone' : 'Delete for me'}
            </div>
        ` : ''}
    `;
    
    messageElement.appendChild(dropdown);
    
    // Close dropdown when clicking outside
    setTimeout(() => {
        document.addEventListener('click', function closeDropdown(e) {
            if (!dropdown.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener('click', closeDropdown);
            }
        });
    }, 0);
}

/**
 * Delete a message
 */
async function deleteMessage(messageId, deleteForEveryone) {
    const confirmMsg = deleteForEveryone 
        ? 'Delete this message for everyone?' 
        : 'Delete this message for you?';
    
    if (!confirm(confirmMsg)) return;
    
    try {
        const response = await apiRequest(`/messages/${messageId}`, {
            method: 'DELETE'
        });
        
        if (response.success) {
            // Remove message from UI
            const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
            if (messageElement) {
                if (response.deletedForEveryone) {
                    // Replace with "This message was deleted"
                    const bubble = messageElement.querySelector('.message-bubble');
                    bubble.innerHTML = '<div class="message-deleted">🚫 This message was deleted</div>';
                    messageElement.querySelectorAll('.message-actions, .message-footer').forEach(el => el.remove());
                } else {
                    // Just remove from view
                    messageElement.remove();
                }
            }
            
            // Notify via socket if deleted for everyone
            if (response.deletedForEveryone && window.emitMessageDeleted) {
                window.emitMessageDeleted(messageId, currentChatId);
            }
        }
    } catch (error) {
        console.error('Delete message error:', error);
        alert('Failed to delete message');
    }
}

/**
 * Show pin duration modal
 */
function pinMessage(messageId) {
    selectedMessageForPin = messageId;
    
    const modal = document.createElement('div');
    modal.id = 'pinDurationModal';
    modal.className = 'pin-duration-modal';
    modal.innerHTML = `
        <div class="pin-duration-content">
            <h3>Pin message for:</h3>
            <div class="pin-duration-options">
                <button class="pin-duration-btn" onclick="confirmPin('24h')">24 hours</button>
                <button class="pin-duration-btn" onclick="confirmPin('7d')">7 days</button>
                <button class="pin-duration-btn" onclick="confirmPin('30d')">30 days</button>
            </div>
            <div class="pin-duration-actions">
                <button class="btn-cancel" onclick="closePinModal()">Cancel</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

/**
 * Confirm pin with duration
 */
async function confirmPin(duration) {
    if (!selectedMessageForPin) return;
    
    try {
        const response = await apiRequest(`/messages/${selectedMessageForPin}/pin`, {
            method: 'POST',
            body: JSON.stringify({ duration })
        });
        
        if (response.success) {
            // Reload pinned messages
            await loadPinnedMessages(currentChatId);
            closePinModal();
        }
    } catch (error) {
        console.error('Pin message error:', error);
        alert('Failed to pin message');
    }
}

/**
 * Close pin modal
 */
function closePinModal() {
    const modal = document.getElementById('pinDurationModal');
    if (modal) modal.remove();
    selectedMessageForPin = null;
}

/**
 * Load pinned messages for current chat
 */
async function loadPinnedMessages(chatId) {
    try {
        const response = await apiRequest(`/messages/chat/${chatId}/pinned`);
        
        if (response.success) {
            renderPinnedMessages(response.data);
        }
    } catch (error) {
        console.error('Load pinned messages error:', error);
    }
}

/**
 * Render pinned messages
 */
function renderPinnedMessages(pinnedMessages) {
    let container = document.getElementById('pinnedMessagesContainer');
    
    if (!container) {
        // Create container if it doesn't exist
        container = document.createElement('div');
        container.id = 'pinnedMessagesContainer';
        container.className = 'pinned-messages-container';
        
        const activeChat = document.getElementById('activeChat');
        const messagesContainer = document.getElementById('messagesContainer');
        activeChat.insertBefore(container, messagesContainer);
    }
    
    if (!pinnedMessages || pinnedMessages.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'flex';
    container.innerHTML = pinnedMessages.map(pin => {
        const timeLeft = getTimeUntil(pin.pinned_until);
        return `
            <div class="pinned-message" data-pin-id="${pin.id}">
                <div class="pinned-message-content">
                    <div class="pinned-message-header">
                        <svg class="pinned-icon" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2l-2 8H8l-2 2 4 4-3 6 1 1 6-3 4 4 2-2v-2l8-2-10-16z"/>
                        </svg>
                        <span style="font-weight: 600; font-size: 0.85rem;">Pinned Message</span>
                    </div>
                    <div class="pinned-message-text">${escapeHtml(pin.content || 'Media message')}</div>
                    <div class="pinned-message-info">
                        <span>Pinned by ${escapeHtml(pin.pinned_by_username)}</span>
                        <span>•</span>
                        <span>${timeLeft}</span>
                    </div>
                </div>
                <div class="pinned-message-actions">
                    <button class="unpin-btn" onclick="unpinMessage(${pin.message_id})">Unpin</button>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Unpin a message
 */
async function unpinMessage(messageId) {
    try {
        const response = await apiRequest(`/messages/${messageId}/unpin`, {
            method: 'DELETE'
        });
        
        if (response.success) {
            await loadPinnedMessages(currentChatId);
        }
    } catch (error) {
        console.error('Unpin message error:', error);
        alert('Failed to unpin message');
    }
}

/**
 * Get time until a date
 */
function getTimeUntil(dateString) {
    const target = new Date(dateString);
    const now = new Date();
    const diff = target - now;
    
    if (diff <= 0) return 'Expired';
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} left`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} left`;
    return 'Less than 1 hour left';
}

/**
 * Delete a chat
 */
async function deleteChat(chatId) {
    if (!confirm('Remove this chat from your list? You can start a new conversation later.')) {
        return;
    }
    
    try {
        const response = await apiRequest(`/chats/${chatId}`, {
            method: 'DELETE'
        });
        
        if (response.success) {
            // Remove from chat list
            const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
            if (chatItem) chatItem.remove();
            
            // If this was the current chat, show welcome screen
            if (currentChatId === chatId) {
                document.getElementById('activeChat').style.display = 'none';
                document.querySelector('.chat-welcome').style.display = 'flex';
                currentChatId = null;
            }
            
            // Reload chats to get updated list
            await loadChats();
        }
    } catch (error) {
        console.error('Delete chat error:', error);
        alert('Failed to delete chat');
    }
}
