/**
 * Message Actions Module
 * Handles reply, edit, forward, star, delete, pin, and other message actions
 */

let selectedMessageForPin = null;

// Reply/edit state of the composer: null, { mode: 'reply', messageId } or { mode: 'edit', messageId, draft }
let composerContext = null;

// Multi-select for forwarding
let selectionMode = false;
const selectedMessageIds = new Set();

// Starred panel paging
let starredCursor = null;

const FORWARD_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 17 20 12 15 7"></polyline><path d="M4 18v-2a4 4 0 0 1 4-4h12"></path></svg>';
const REPLY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>';
const EDIT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>';
const STAR_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
const SELECT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>';

/**
 * Whether the current user may still edit a message (the server re-checks all of this)
 */
function canEditMessage(message) {
    const currentUser = getCurrentUser();
    if (!message || message.sender_id !== currentUser.userId) return false;
    if (message.message_type !== 'text' || message.is_forwarded) return false;
    if (message.is_deleted || message.deleted_at) return false;

    const age = Date.now() - new Date(message.created_at).getTime();
    return age < CONFIG.MESSAGE_EDIT_WINDOW_MINUTES * 60 * 1000;
}

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
        <div class="message-action-item" onclick="startReply(${messageId})">
            ${REPLY_ICON_SVG}
            Reply
        </div>
        ${canEditMessage(message) ? `
            <div class="message-action-item" onclick="startEdit(${messageId})">
                ${EDIT_ICON_SVG}
                Edit
            </div>
        ` : ''}
        <div class="message-action-item" onclick="openForwardModal([${messageId}])">
            ${FORWARD_ICON_SVG}
            Forward
        </div>
        <div class="message-action-item" onclick="enterSelectionMode(${messageId})">
            ${SELECT_ICON_SVG}
            Select
        </div>
        <div class="message-action-item" onclick="toggleStar(${messageId})">
            ${STAR_ICON_SVG}
            ${message.is_starred ? 'Unstar' : 'Star'}
        </div>
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
            if (response.deletedForEveryone) {
                // Same update every open client gets from the message_deleted broadcast
                applyMessageDeleted({ messageId, chatId: currentChatId, deletedForEveryone: true });
            } else {
                // Just remove from view
                const messageElement = document.querySelector(`#messagesContainer [data-message-id="${messageId}"]`);
                if (messageElement) messageElement.remove();
            }
        } else {
            showNotification(response.message || 'Failed to delete message', 'error');
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
        const messagesWrapper = document.getElementById('messagesWrapper');
        activeChat.insertBefore(container, messagesWrapper);
    }
    
    if (!pinnedMessages || pinnedMessages.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'flex';
    container.innerHTML = pinnedMessages.map(pin => {
        const timeLeft = getTimeUntil(pin.pinned_until);
        return `
            <div class="pinned-message" data-pin-id="${parseInt(pin.id)}" data-pinned-message-id="${parseInt(pin.message_id)}">
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

/**
 * Close the per-message "..." menu (not the chat header menu)
 */
function closeMessageActionMenus() {
    document.querySelectorAll('.message .message-action-dropdown').forEach(d => d.remove());
}

/**
 * Small DOM helper: element with a class and plain-text content (never parsed as HTML)
 */
function createTextElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
}

/**
 * Name shown for a chat (other participant for direct chats), same rules as the sidebar
 */
function getChatDisplayName(chat) {
    if (!chat) return 'Chat';
    if (chat.chat_type !== 'direct') return chat.chat_name || 'Group';

    let participants = chat.participants;
    if (typeof participants === 'string') {
        try {
            participants = JSON.parse(participants);
        } catch (e) {
            participants = [];
        }
    }

    const currentUserId = parseInt(getCurrentUser().userId);
    const other = (participants || []).find(p => parseInt(p.userId || p.userid) !== currentUserId);
    return other ? (other.fullName || other.fullname || other.username) : (chat.chat_name || 'Chat');
}

/* ===== Composer: reply and edit ===== */

function getReplyTargetId() {
    return composerContext && composerContext.mode === 'reply' ? composerContext.messageId : null;
}

function isEditingMessage() {
    return !!(composerContext && composerContext.mode === 'edit');
}

/**
 * Quote the message above the composer; the next message sent replies to it
 */
function startReply(messageId) {
    closeMessageActionMenus();
    const message = currentMessages.find(m => m.id === messageId);
    if (!message) return;

    const input = document.getElementById('messageInput');
    if (isEditingMessage()) {
        input.value = composerContext.draft || '';
    }

    composerContext = { mode: 'reply', messageId };
    renderComposerContext();
    input.focus();
}

/**
 * Load the message into the composer; Enter saves, Escape cancels
 */
function startEdit(messageId) {
    closeMessageActionMenus();
    const message = currentMessages.find(m => m.id === messageId);
    if (!canEditMessage(message)) {
        showNotification('This message can no longer be edited', 'error');
        return;
    }

    const input = document.getElementById('messageInput');
    // Keep whatever was being typed so cancelling the edit gives it back
    const draft = isEditingMessage() ? composerContext.draft : input.value;

    composerContext = { mode: 'edit', messageId, draft };
    input.value = message.content || '';
    autoResizeComposer();
    renderComposerContext();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * Forget the reply/edit state (after sending, or when the chat changes)
 */
function clearComposerContext() {
    composerContext = null;
    renderComposerContext();
}

/**
 * User dismissed the bar: an edit gives the composer back its previous draft
 */
function cancelComposerContext() {
    if (isEditingMessage()) {
        document.getElementById('messageInput').value = composerContext.draft || '';
    }
    clearComposerContext();
}

/**
 * The bar above the composer ("Replying to ..." / "Edit message")
 */
function renderComposerContext() {
    const bar = document.getElementById('composerContext');
    if (!bar) return;

    const message = composerContext && currentMessages.find(m => m.id === composerContext.messageId);
    const container = document.getElementById('messagesContainer');
    container.classList.toggle('with-composer-context', !!message);

    if (!composerContext || !message) {
        bar.hidden = true;
        document.getElementById('messageInput').placeholder = 'Type a message...';
        if (composerContext && !message) composerContext = null;
        return;
    }

    const editing = composerContext.mode === 'edit';
    bar.classList.toggle('editing', editing);
    bar.querySelector('.composer-context-icon').innerHTML = editing ? EDIT_ICON_SVG : REPLY_ICON_SVG;
    bar.querySelector('.composer-context-title').textContent = editing
        ? 'Edit message'
        : `Replying to ${message.sender_id === getCurrentUser().userId ? 'yourself' : (message.full_name || message.username)}`;
    bar.querySelector('.composer-context-text').textContent =
        getMessagePreviewText(message.message_type, message.content, message.file_name);
    document.getElementById('messageInput').placeholder = editing ? 'Edit your message...' : 'Type a reply...';
    bar.hidden = false;
}

/**
 * Save the edit currently in the composer
 */
async function submitMessageEdit(content) {
    const { messageId } = composerContext;
    const message = currentMessages.find(m => m.id === messageId);
    const input = document.getElementById('messageInput');

    // Nothing changed: just leave edit mode
    if (message && message.content === content) {
        cancelComposerContext();
        return;
    }

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.EDIT_MESSAGE(messageId), {
            method: 'PATCH',
            body: JSON.stringify({ content })
        });

        if (response.success) {
            applyMessageEdit(response.data);
            // Still editing this message (not switched away meanwhile): give back the earlier draft
            if (composerContext && composerContext.messageId === messageId) {
                input.value = composerContext.draft || '';
                clearComposerContext();
            }
        } else {
            // Stay in edit mode so the text isn't lost
            showNotification(response.message || 'Failed to edit message', 'error');
        }
    } catch (error) {
        console.error('Edit message error:', error);
        showNotification('Failed to edit message', 'error');
    }
}

/**
 * An edit from this tab or from the server broadcast: update the thread and the sidebar preview
 */
function applyMessageEdit(data) {
    if (!data) return;

    if (data.chatId === currentChatId) {
        const message = currentMessages.find(m => m.id === data.messageId);
        if (message) {
            message.content = data.content;
            message.edited_at = data.editedAt;
            if (Array.isArray(data.mentions)) message.mentions = data.mentions;
            rerenderMessage(message);
        }

        // Quotes of the edited message show the new text
        currentMessages.forEach(m => {
            if (m.reply_to && m.reply_to.id === data.messageId && !m.reply_to.deleted) {
                m.reply_to.snippet = data.content;
                rerenderMessage(m);
            }
        });

        if (composerContext && composerContext.mode === 'reply' && composerContext.messageId === data.messageId) {
            renderComposerContext();
        }
    }

    const chat = allChats.find(c => c.id === data.chatId);
    if (chat && chat.lastMessage) {
        let last = chat.lastMessage;
        if (typeof last === 'string') {
            try {
                last = JSON.parse(last);
            } catch (e) {
                last = null;
            }
        }
        if (last && last.id === data.messageId) {
            last.content = data.content;
            chat.lastMessage = last;
            refreshChatList();
        }
    }
}

/**
 * A message was deleted for everyone (broadcast, or this tab's own delete): show the placeholder,
 * blank quotes of it, and drop it from the sidebar preview, composer, selection, pins and stars.
 * Safe to run twice for the same message.
 */
function applyMessageDeleted(data) {
    if (!data || !data.deletedForEveryone) return;
    const messageId = data.messageId;

    if (data.chatId === currentChatId) {
        const message = currentMessages.find(m => m.id === messageId);
        if (message) {
            message.deleted_for_everyone = true;
            message.is_deleted = true;
            message.content = null;
            message.reply_to = null;
            rerenderMessage(message);
        }

        // Replies keep their quote block, but only as "Original message deleted"
        currentMessages.forEach(m => {
            if (m.reply_to && m.reply_to.id === messageId && !m.reply_to.deleted) {
                m.reply_to = { id: messageId, deleted: true };
                rerenderMessage(m);
            }
        });

        if (composerContext && composerContext.messageId === messageId) {
            const wasEditing = isEditingMessage();
            cancelComposerContext();
            showNotification(wasEditing ? 'The message you were editing was deleted' : 'The message you were replying to was deleted', 'error');
        }

        if (selectedMessageIds.has(messageId)) {
            selectedMessageIds.delete(messageId);
            updateSelectionBar();
        }

        if (document.querySelector(`#pinnedMessagesContainer [data-pinned-message-id="${parseInt(messageId)}"]`)) {
            loadPinnedMessages(currentChatId);
        }
    }

    const chat = allChats.find(c => c.id === data.chatId);
    if (chat && chat.lastMessage) {
        let last = chat.lastMessage;
        if (typeof last === 'string') {
            try {
                last = JSON.parse(last);
            } catch (e) {
                last = null;
            }
        }
        if (last && last.id === messageId) {
            last.content = null;
            last.deleted = true;
            chat.lastMessage = last;
            refreshChatList();
        }
    }

    const starredItem = document.querySelector(`#starredModal [data-starred-id="${parseInt(messageId)}"]`);
    if (starredItem) {
        starredItem.remove();
        if (!document.querySelector('#starredModal .starred-item')) renderStarredEmpty();
    }
}

/* ===== Stars ===== */

async function toggleStar(messageId) {
    closeMessageActionMenus();
    const message = currentMessages.find(m => m.id === messageId);
    await setMessageStarred(messageId, !(message && message.is_starred));
}

async function setMessageStarred(messageId, starred) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.STAR_MESSAGE(messageId), {
            method: starred ? 'POST' : 'DELETE'
        });

        if (response.success) {
            applyStarUpdate(response.data);
        } else {
            showNotification(response.message || 'Failed to update star', 'error');
        }
    } catch (error) {
        console.error('Star message error:', error);
        showNotification('Failed to update star', 'error');
    }
}

/**
 * Star changed here or in another tab
 */
function applyStarUpdate(data) {
    if (!data) return;

    const message = currentMessages.find(m => m.id === data.messageId);
    if (message && !!message.is_starred !== data.starred) {
        message.is_starred = data.starred;
        rerenderMessage(message);
    }

    const modal = document.getElementById('starredModal');
    if (modal && modal.style.display === 'flex') {
        if (data.starred) {
            loadStarredMessages(true);
        } else {
            const item = modal.querySelector(`[data-starred-id="${parseInt(data.messageId)}"]`);
            if (item) item.remove();
            if (!modal.querySelector('.starred-item')) renderStarredEmpty();
        }
    }
}

/* ===== Selection and forward ===== */

function enterSelectionMode(messageId) {
    closeMessageActionMenus();
    cancelComposerContext();

    selectionMode = true;
    selectedMessageIds.clear();
    document.getElementById('messagesContainer').classList.add('selecting');
    document.querySelector('.message-input-container').classList.add('selecting');
    document.getElementById('selectionBar').hidden = false;

    if (messageId) toggleMessageSelection(messageId);
    updateSelectionBar();
}

function exitSelectionMode() {
    if (!selectionMode) return;

    selectionMode = false;
    selectedMessageIds.clear();
    const container = document.getElementById('messagesContainer');
    if (container) {
        container.classList.remove('selecting');
        container.querySelectorAll('.message.selected').forEach(el => el.classList.remove('selected'));
    }
    const bar = document.getElementById('selectionBar');
    if (bar) bar.hidden = true;
    const composer = document.querySelector('.message-input-container');
    if (composer) composer.classList.remove('selecting');
}

function toggleMessageSelection(messageId) {
    const message = currentMessages.find(m => m.id === messageId);
    if (!message || message.is_deleted || message.deleted_at) return;

    if (selectedMessageIds.has(messageId)) {
        selectedMessageIds.delete(messageId);
    } else {
        if (selectedMessageIds.size >= CONFIG.MAX_FORWARD_MESSAGES) {
            showNotification(`You can forward up to ${CONFIG.MAX_FORWARD_MESSAGES} messages at a time`, 'error');
            return;
        }
        selectedMessageIds.add(messageId);
    }

    const element = document.querySelector(`#messagesContainer [data-message-id="${messageId}"]`);
    if (element) {
        element.classList.toggle('selected', selectedMessageIds.has(messageId));
    }
    updateSelectionBar();
}

function updateSelectionBar() {
    const count = selectedMessageIds.size;
    document.getElementById('selectionCount').textContent = `${count} selected`;
    document.getElementById('selectionForwardBtn').disabled = count === 0;
}

/**
 * Pick target chats for one or more messages
 */
function openForwardModal(messageIds) {
    closeMessageActionMenus();
    const ids = (messageIds || []).slice(0, CONFIG.MAX_FORWARD_MESSAGES);
    if (ids.length === 0) return;

    const modal = document.getElementById('forwardModal');
    modal.dataset.messageIds = JSON.stringify(ids);
    document.getElementById('forwardModalTitle').textContent =
        ids.length === 1 ? 'Forward message' : `Forward ${ids.length} messages`;
    document.getElementById('forwardSearch').value = '';
    document.getElementById('forwardChatList').dataset.checked = '[]';
    renderForwardChatList();
    updateForwardSubmit();

    modal.style.display = 'flex';
    document.getElementById('forwardSearch').focus();
}

function closeForwardModal() {
    document.getElementById('forwardModal').style.display = 'none';
}

function renderForwardChatList() {
    const list = document.getElementById('forwardChatList');
    const query = document.getElementById('forwardSearch').value.trim().toLowerCase();
    // Keep ticks across searches
    const checked = new Set(JSON.parse(list.dataset.checked || '[]'));

    list.replaceChildren();

    const chats = allChats
        .map(chat => ({ chat, name: getChatDisplayName(chat) }))
        .filter(({ name }) => !query || name.toLowerCase().includes(query));

    if (chats.length === 0) {
        list.appendChild(createTextElement('p', 'forward-empty', 'No chats found'));
        return;
    }

    for (const { chat, name } of chats) {
        const label = createTextElement('label', 'forward-chat-item');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = chat.id;
        checkbox.checked = checked.has(chat.id);

        const avatar = createTextElement('span', 'forward-chat-avatar', name.charAt(0).toUpperCase());
        avatar.setAttribute('aria-hidden', 'true');
        const text = createTextElement('span', 'forward-chat-name', name);
        const type = createTextElement('span', 'forward-chat-type', chat.chat_type === 'group' ? 'Group' : '');

        label.append(checkbox, avatar, text, type);
        list.appendChild(label);
    }
}

function getForwardSelection() {
    return JSON.parse(document.getElementById('forwardChatList').dataset.checked || '[]');
}

function updateForwardSubmit() {
    const count = getForwardSelection().length;
    const button = document.getElementById('forwardSubmitBtn');
    button.disabled = count === 0;
    button.textContent = count > 1 ? `Forward to ${count} chats` : 'Forward';
}

async function submitForward() {
    const modal = document.getElementById('forwardModal');
    const messageIds = JSON.parse(modal.dataset.messageIds || '[]');
    const chatIds = getForwardSelection();
    if (messageIds.length === 0 || chatIds.length === 0) return;

    const button = document.getElementById('forwardSubmitBtn');
    button.disabled = true;

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.FORWARD_MESSAGES, {
            method: 'POST',
            body: JSON.stringify({ messageIds, chatIds })
        });

        if (response.success) {
            closeForwardModal();
            exitSelectionMode();
            showNotification(response.message || 'Forwarded');
        } else {
            showNotification(response.message || 'Failed to forward', 'error');
        }
    } catch (error) {
        console.error('Forward error:', error);
        showNotification('Failed to forward', 'error');
    } finally {
        updateForwardSubmit();
    }
}

/* ===== Starred messages panel ===== */

function openStarredPanel() {
    document.getElementById('starredModal').style.display = 'flex';
    loadStarredMessages(true);
}

function closeStarredPanel() {
    document.getElementById('starredModal').style.display = 'none';
}

function renderStarredEmpty() {
    const list = document.getElementById('starredList');
    list.replaceChildren(createTextElement('p', 'starred-empty', "No starred messages yet. Choose Star in a message's menu to keep it here."));
    document.getElementById('starredLoadMore').hidden = true;
}

/**
 * Fetch a page of starred messages (reset = start over from the newest star)
 */
async function loadStarredMessages(reset) {
    const list = document.getElementById('starredList');
    const loadMore = document.getElementById('starredLoadMore');

    if (reset) {
        starredCursor = null;
        loadMore.hidden = true;
        list.replaceChildren(createTextElement('p', 'starred-empty', 'Loading…'));
    }

    try {
        const query = `?limit=30${starredCursor ? `&before=${starredCursor}` : ''}`;
        const response = await apiRequest(CONFIG.ENDPOINTS.STARRED_MESSAGES + query);
        if (!response.success) {
            list.replaceChildren(createTextElement('p', 'starred-empty', response.message || 'Failed to load starred messages'));
            return;
        }

        if (reset) list.replaceChildren();
        response.data.forEach(message => list.appendChild(renderStarredItem(message)));

        if (!list.querySelector('.starred-item')) {
            renderStarredEmpty();
            return;
        }

        starredCursor = response.pagination.nextCursor;
        loadMore.hidden = !response.pagination.hasMore;
    } catch (error) {
        console.error('Load starred messages error:', error);
        list.replaceChildren(createTextElement('p', 'starred-empty', 'Failed to load starred messages'));
    }
}

function renderStarredItem(message) {
    const item = createTextElement('div', 'starred-item');
    item.dataset.starredId = message.id;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'starred-item-open';

    const header = createTextElement('span', 'starred-item-header');
    header.append(
        createTextElement('span', 'starred-item-chat', message.chat_display_name),
        createTextElement('span', 'starred-item-time', formatTime(message.created_at))
    );

    const sender = message.sender_id === getCurrentUser().userId ? 'You' : (message.full_name || message.username);
    const preview = createTextElement('span', 'starred-item-text');
    preview.append(
        createTextElement('strong', null, `${sender}: `),
        document.createTextNode(getMessagePreviewText(message.message_type, message.content, message.file_name))
    );

    open.append(header, preview);
    open.addEventListener('click', () => {
        closeStarredPanel();
        jumpToMessage(message.chat_id, message.id);
    });

    const unstar = document.createElement('button');
    unstar.type = 'button';
    unstar.className = 'icon-btn starred-item-unstar';
    unstar.title = 'Unstar';
    unstar.setAttribute('aria-label', 'Unstar');
    unstar.innerHTML = STAR_ICON_SVG;
    unstar.addEventListener('click', () => setMessageStarred(message.id, false));

    item.append(open, unstar);
    return item;
}

/* ===== Jump to a message (quotes and starred list) ===== */

const MAX_PAGES_TO_FIND_MESSAGE = 50;

/**
 * Load older pages until the message is in the thread (or there's nothing older)
 */
async function ensureMessageLoaded(messageId) {
    for (let page = 0; page <= MAX_PAGES_TO_FIND_MESSAGE; page++) {
        if (currentMessages.some(m => m.id === messageId)) return true;

        // Already past it: it was deleted for this user
        if (!hasOlderMessages || (currentMessages.length > 0 && currentMessages[0].id < messageId)) return false;

        // A scroll-triggered load may be running; wait for it instead of skipping a page
        while (loadingOlderMessages) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        await loadOlderMessages();
    }
    return false;
}

/**
 * Open the chat if needed, scroll the message into view and flash it
 */
async function jumpToMessage(chatId, messageId) {
    if (chatId !== currentChatId) {
        await openChat(chatId);
    }

    const found = await ensureMessageLoaded(messageId);
    const element = found && document.querySelector(`#messagesContainer [data-message-id="${messageId}"]`);
    if (!element) {
        showNotification('That message is no longer available', 'error');
        return;
    }

    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.classList.remove('message-highlight');
    // Reflow so the animation restarts when the same message is jumped to twice
    void element.offsetWidth;
    element.classList.add('message-highlight');
    setTimeout(() => element.classList.remove('message-highlight'), 2000);
}

/**
 * Leaving a chat: drop reply/edit/selection state that belongs to it
 */
function resetMessageActionState() {
    cancelComposerContext();
    exitSelectionMode();
}

/**
 * Wire up the composer bar, selection bar, forward dialog and starred panel
 */
function initializeMessageActions() {
    const container = document.getElementById('messagesContainer');

    // Capture phase so a click in selection mode never opens images, links or menus
    container.addEventListener('click', (e) => {
        if (selectionMode) {
            const element = e.target.closest('.message[data-message-id]');
            if (!element) return;
            e.preventDefault();
            e.stopPropagation();
            toggleMessageSelection(parseInt(element.dataset.messageId));
            return;
        }

        const quote = e.target.closest('.message-quote[data-reply-id]');
        if (quote) {
            e.stopPropagation();
            jumpToMessage(currentChatId, parseInt(quote.dataset.replyId));
        }
    }, true);

    document.getElementById('composerContextClose').addEventListener('click', () => {
        cancelComposerContext();
        document.getElementById('messageInput').focus();
    });

    document.getElementById('messageInput').addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && composerContext) {
            e.preventDefault();
            e.stopPropagation();
            cancelComposerContext();
        }
    });

    document.getElementById('selectionCancelBtn').addEventListener('click', exitSelectionMode);
    document.getElementById('selectionForwardBtn').addEventListener('click', () => {
        openForwardModal([...selectedMessageIds].sort((a, b) => a - b));
    });

    // Forward dialog
    const forwardModal = document.getElementById('forwardModal');
    const forwardList = document.getElementById('forwardChatList');
    document.getElementById('closeForwardModal').addEventListener('click', closeForwardModal);
    document.getElementById('cancelForward').addEventListener('click', closeForwardModal);
    document.getElementById('forwardSubmitBtn').addEventListener('click', submitForward);
    document.getElementById('forwardSearch').addEventListener('input', renderForwardChatList);
    forwardModal.addEventListener('click', (e) => {
        if (e.target === forwardModal) closeForwardModal();
    });
    forwardList.addEventListener('change', (e) => {
        if (!e.target.matches('input[type="checkbox"]')) return;

        const checked = new Set(getForwardSelection());
        const chatId = parseInt(e.target.value);
        if (e.target.checked) {
            if (checked.size >= CONFIG.MAX_FORWARD_CHATS) {
                e.target.checked = false;
                showNotification(`You can forward to up to ${CONFIG.MAX_FORWARD_CHATS} chats at a time`, 'error');
                return;
            }
            checked.add(chatId);
        } else {
            checked.delete(chatId);
        }
        forwardList.dataset.checked = JSON.stringify([...checked]);
        updateForwardSubmit();
    });

    // Starred panel
    const starredModal = document.getElementById('starredModal');
    document.getElementById('starredBtn').addEventListener('click', openStarredPanel);
    document.getElementById('closeStarredModal').addEventListener('click', closeStarredPanel);
    document.getElementById('starredLoadMore').addEventListener('click', () => loadStarredMessages(false));
    starredModal.addEventListener('click', (e) => {
        if (e.target === starredModal) closeStarredPanel();
    });

    // Escape closes the topmost of: forward dialog, starred panel, selection mode
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (forwardModal.style.display === 'flex') {
            closeForwardModal();
        } else if (starredModal.style.display === 'flex') {
            closeStarredPanel();
        } else if (selectionMode) {
            exitSelectionMode();
        }
    });
}
