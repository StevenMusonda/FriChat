/**
 * UI Module
 * Handles UI interactions, theme toggling, and emoji picker
 */

let currentEmojiMessageId = null;

/**
 * Initialize UI components
 */
function initializeUI() {
    initializeThemeToggle();
    initializeEmojiPicker();
    initializeLogout();
    initializeUserProfile();
    initializeChatInfo();
    initializeMobileBackButton();
    initializeCloseChatButton();
}

/**
 * Initialize theme toggle
 */
function initializeThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    
    if (!themeToggle) return;
    
    // Load saved theme
    const savedTheme = localStorage.getItem(CONFIG.STORAGE_KEYS.THEME) || 'light';
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
    }
    
    // Toggle theme
    themeToggle.addEventListener('click', () => {
        document.body.classList.toggle('dark-theme');
        
        const isDark = document.body.classList.contains('dark-theme');
        localStorage.setItem(CONFIG.STORAGE_KEYS.THEME, isDark ? 'dark' : 'light');
    });
}

/**
 * Initialize emoji picker
 */
function initializeEmojiPicker() {
    const emojiBtn = document.getElementById('emojiBtn');
    const emojiPicker = document.getElementById('emojiPicker');
    
    if (!emojiBtn || !emojiPicker) return;
    
    // Toggle emoji picker for message input
    emojiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        
        if (emojiPicker.style.display === 'block') {
            emojiPicker.style.display = 'none';
        } else {
            currentEmojiMessageId = null;
            emojiPicker.style.display = 'block';
        }
    });
    
    // Add emoji to input
    const emojiGrid = emojiPicker.querySelector('.emoji-grid');
    if (emojiGrid) {
        emojiGrid.addEventListener('click', (e) => {
            // Check if clicked element is an emoji span
            if (e.target.classList.contains('emoji-item')) {
                const emoji = e.target.textContent.trim();
                console.log('Emoji clicked:', emoji);
                
                if (currentEmojiMessageId) {
                    // Add reaction to message
                    console.log('Adding reaction to message:', currentEmojiMessageId);
                    toggleReaction(currentEmojiMessageId, emoji);
                    currentEmojiMessageId = null;
                } else {
                    // Add to message input
                    const messageInput = document.getElementById('messageInput');
                    if (messageInput) {
                        messageInput.value += emoji;
                        messageInput.focus();
                    }
                }
                
                emojiPicker.style.display = 'none';
            }
        });
    }
    
    // Close emoji picker when clicking outside
    document.addEventListener('click', (e) => {
        // Don't close if clicking on emoji picker, emoji button, or reaction button
        const isReactionBtn = e.target.closest('.reaction-btn');
        if (!emojiPicker.contains(e.target) && e.target !== emojiBtn && !isReactionBtn) {
            emojiPicker.style.display = 'none';
        }
    });
}

/**
 * Show emoji picker for message reaction
 */
function showEmojiPicker(messageId) {
    console.log('showEmojiPicker called for message:', messageId);
    const emojiPicker = document.getElementById('emojiPicker');
    if (!emojiPicker) {
        console.error('Emoji picker element not found');
        return;
    }
    
    console.log('Emoji picker element:', emojiPicker);
    console.log('Current display:', emojiPicker.style.display);
    
    currentEmojiMessageId = messageId;
    emojiPicker.style.display = 'block';
    emojiPicker.style.visibility = 'visible';
    emojiPicker.style.opacity = '1';
    
    console.log('After setting display to block:', {
        display: emojiPicker.style.display,
        visibility: emojiPicker.style.visibility,
        opacity: emojiPicker.style.opacity,
        zIndex: window.getComputedStyle(emojiPicker).zIndex,
        position: window.getComputedStyle(emojiPicker).position
    });
    
    // Simple fixed positioning at bottom right
    emojiPicker.style.position = 'fixed';
    emojiPicker.style.bottom = '100px';
    emojiPicker.style.right = '30px';
    emojiPicker.style.top = 'auto';
    emojiPicker.style.zIndex = '9999';
    
    console.log('Emoji picker should be visible now at bottom-right');
}

/**
 * Initialize logout
 */
function initializeLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    
    if (!logoutBtn) return;
    
    logoutBtn.addEventListener('click', async () => {
        if (confirm('Are you sure you want to logout?')) {
            // Disconnect WebSocket
            disconnectWebSocket();
            
            // Logout
            await logout();
        }
    });
}

/**
 * Initialize user profile display
 */
function initializeUserProfile() {
    const user = getCurrentUser();
    
    if (!user) return;
    
    // Update user info in sidebar
    const userNameElement = document.getElementById('userName');
    const userInitialElement = document.getElementById('userInitial');
    
    if (userNameElement) {
        userNameElement.textContent = user.fullName || user.username;
    }
    
    if (userInitialElement) {
        const initial = (user.fullName || user.username).charAt(0).toUpperCase();
        userInitialElement.textContent = initial;
    }
}

/**
 * Show notification
 */
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: ${type === 'error' ? 'var(--danger-color)' : 'var(--primary-color)'};
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: var(--shadow-md);
        z-index: 10000;
        animation: slideInRight 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

/**
 * Show loading indicator
 */
function showLoading() {
    const loading = document.createElement('div');
    loading.id = 'loadingIndicator';
    loading.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    loading.innerHTML = `
        <div style="
            background-color: var(--bg-primary);
            padding: 30px;
            border-radius: 12px;
            text-align: center;
        ">
            <div style="
                width: 50px;
                height: 50px;
                border: 4px solid var(--border-color);
                border-top-color: var(--primary-color);
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 15px;
            "></div>
            <div style="color: var(--text-primary);">Loading...</div>
        </div>
    `;
    
    document.body.appendChild(loading);
}

/**
 * Hide loading indicator
 */
function hideLoading() {
    const loading = document.getElementById('loadingIndicator');
    if (loading) {
        loading.remove();
    }
}

/**
 * Open image modal
 */
function openImageModal(imageUrl) {
    console.log('Opening image modal for:', imageUrl);
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 90vw; max-height: 90vh; padding: 0;">
            <div class="modal-header">
                <h3>Image Preview</h3>
                <button class="modal-close" id="closeImageModal">&times;</button>
            </div>
            <div class="modal-body" style="padding: 0; display: flex; align-items: center; justify-content: center; background: #000;">
                <img id="modalImage" src="${imageUrl}" style="max-width: 100%; max-height: 70vh; object-fit: contain;" alt="Preview">
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Check if image loads
    const img = modal.querySelector('#modalImage');
    img.onerror = () => {
        console.error('Failed to load image:', imageUrl);
        img.alt = 'Failed to load image';
        img.style.display = 'none';
        modal.querySelector('.modal-body').innerHTML = `
            <div style="color: white; padding: 20px; text-align: center;">
                <p>Failed to load image</p>
                <p style="font-size: 12px; opacity: 0.7;">${imageUrl}</p>
            </div>
        `;
    };
    
    img.onload = () => {
        console.log('Image loaded successfully');
    };
    
    // Close button click
    const closeBtn = modal.querySelector('#closeImageModal');
    closeBtn.addEventListener('click', () => {
        modal.remove();
    });
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
    
    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

// Make function globally accessible
if (typeof window !== 'undefined') {
    window.openImageModal = openImageModal;
}

/**
 * Handle typing indicator display
 */
function handleTypingIndicator(data) {
    const typingIndicator = document.getElementById('typingIndicator');
    
    if (!typingIndicator) return;
    
    if (data.chatId !== currentChatId) return;
    
    if (data.isTyping) {
        typingIndicator.querySelector('span').textContent = data.username;
        typingIndicator.style.display = 'block';
    } else {
        typingIndicator.style.display = 'none';
    }
}

/**
 * Handle user status updates
 */
function handleUserStatusUpdate(data) {
    // Update chat list
    const chatItems = document.querySelectorAll('.chat-item');
    chatItems.forEach(item => {
        // This is simplified - in production, you'd need to check if the user is in this chat
        // and update the status accordingly
    });
    
    // Update current chat if it's a direct chat with this user
    if (currentChatId) {
        const chatStatus = document.getElementById('chatStatus');
        if (chatStatus && chatStatus.textContent !== 'members') {
            // This is a direct chat, update status
            chatStatus.textContent = data.status;
        }
    }
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOutRight {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
    
    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }
`;
document.head.appendChild(style);

/**
 * Initialize chat info modal
 */
function initializeChatInfo() {
    const chatInfoBtn = document.getElementById('chatInfoBtn');
    const chatInfoModal = document.getElementById('chatInfoModal');
    const closeChatInfoModal = document.getElementById('closeChatInfoModal');
    
    if (!chatInfoBtn || !chatInfoModal) return;
    
    // Open chat info modal
    chatInfoBtn.addEventListener('click', () => {
        showChatInfo();
    });
    
    // Close modal handlers
    if (closeChatInfoModal) {
        closeChatInfoModal.addEventListener('click', () => {
            chatInfoModal.style.display = 'none';
        });
    }
    
    chatInfoModal.addEventListener('click', (e) => {
        if (e.target === chatInfoModal) {
            chatInfoModal.style.display = 'none';
        }
    });
}

/**
 * Show chat information
 */
function showChatInfo() {
    if (!currentChatId) {
        console.error('No active chat');
        return;
    }
    
    const chatInfoModal = document.getElementById('chatInfoModal');
    const chatInfoContent = document.getElementById('chatInfoContent');
    
    if (!chatInfoModal || !chatInfoContent) return;
    
    // Find current chat data
    const chat = allChats.find(c => c.id === currentChatId);
    
    if (!chat) {
        console.error('Chat not found:', currentChatId);
        return;
    }
    
    // Parse participants if it's a JSON string
    let participants = [];
    try {
        participants = typeof chat.participants === 'string' 
            ? JSON.parse(chat.participants) 
            : (chat.participants || []);
    } catch (e) {
        console.error('Error parsing participants:', e);
        participants = [];
    }
    
    // Build chat info HTML
    let infoHTML = '';
    
    if (chat.type === 'group') {
        // Group chat info
        infoHTML = `
            <div class="chat-info-section">
                <h4>Group Name</h4>
                <p>${escapeHtml(chat.name || 'Unnamed Group')}</p>
            </div>
            <div class="chat-info-section">
                <h4>Members (${participants.length})</h4>
                <div class="members-list">
                    ${participants.length > 0 ? participants.map(p => `
                        <div class="member-item">
                            <div class="member-avatar">
                                ${p.avatar_url ? 
                                    `<img src="${p.avatar_url}" alt="${escapeHtml(p.full_name || p.username)}">` :
                                    `<span>${(p.full_name || p.username).charAt(0).toUpperCase()}</span>`
                                }
                            </div>
                            <div class="member-info">
                                <div class="member-name">${escapeHtml(p.full_name || p.username)}</div>
                                <div class="member-username">@${escapeHtml(p.username)}</div>
                            </div>
                        </div>
                    `).join('') : '<p>No members</p>'}
                </div>
            </div>
        `;
    } else {
        // Direct chat info
        const otherUser = participants.find(p => p.id !== getCurrentUser().id);
        
        if (otherUser) {
            infoHTML = `
                <div class="chat-info-section">
                    <div class="user-profile-large">
                        <div class="profile-avatar-large">
                            ${otherUser.avatar_url ? 
                                `<img src="${otherUser.avatar_url}" alt="${escapeHtml(otherUser.full_name || otherUser.username)}">` :
                                `<span>${(otherUser.full_name || otherUser.username).charAt(0).toUpperCase()}</span>`
                            }
                        </div>
                        <h4>${escapeHtml(otherUser.full_name || otherUser.username)}</h4>
                        <p class="username">@${escapeHtml(otherUser.username)}</p>
                    </div>
                </div>
                <div class="chat-info-section">
                    <h4>Email</h4>
                    <p>${escapeHtml(otherUser.email || 'Not available')}</p>
                </div>
            `;
        } else {
            infoHTML = '<p>User information not available</p>';
        }
    }
    
    infoHTML += `
        <div class="chat-info-section">
            <h4>Chat ID</h4>
            <p>${chat.id}</p>
        </div>
        <div class="chat-info-section">
            <h4>Created</h4>
            <p>${new Date(chat.created_at).toLocaleString()}</p>
        </div>
    `;
    
    chatInfoContent.innerHTML = infoHTML;
    chatInfoModal.style.display = 'flex';
}

/**
 * Initialize mobile back button
 */
function initializeMobileBackButton() {
    const mobileBackBtn = document.getElementById('mobileBackBtn');
    
    if (!mobileBackBtn) return;
    
    mobileBackBtn.addEventListener('click', () => {
        // Hide active chat and show sidebar on mobile
        const chatMain = document.querySelector('.chat-main');
        const chatSidebar = document.querySelector('.chat-sidebar');
        
        if (chatMain) chatMain.classList.remove('active');
        if (chatSidebar) chatSidebar.classList.remove('hidden');
        
        // Clear current chat
        currentChatId = null;
    });
}

/**
 * Initialize close chat button for desktop
 */
function initializeCloseChatButton() {
    const closeChatBtn = document.getElementById('closeChatBtn');
    
    if (!closeChatBtn) return;
    
    closeChatBtn.addEventListener('click', () => {
        // Hide active chat and show welcome screen
        const activeChat = document.getElementById('activeChat');
        const chatWelcome = document.querySelector('.chat-welcome');
        
        if (activeChat) activeChat.style.display = 'none';
        if (chatWelcome) chatWelcome.style.display = 'flex';
        
        // Clear current chat
        currentChatId = null;
        
        // Remove active class from all chat items
        document.querySelectorAll('.chat-item').forEach(item => {
            item.classList.remove('active');
        });
    });
}

// Make functions globally accessible
window.showEmojiPicker = showEmojiPicker;
window.openImageModal = openImageModal;
window.removeSelectedUser = removeSelectedUser;
window.toggleReaction = toggleReaction;
