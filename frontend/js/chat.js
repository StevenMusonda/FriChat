/**
 * Chat Module
 * Handles chat operations and UI updates
 */

let currentChatId = null;
let allChats = [];
let selectedUsers = [];

/**
 * Load all chats for current user
 */
async function loadChats() {
    try {
        console.log('Loading chats...');
        console.log('User data:', getCurrentUser());
        console.log('Auth token:', localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN));
        console.log('API endpoint:', CONFIG.API_BASE_URL + CONFIG.ENDPOINTS.CHATS);
        
        const response = await apiRequest(CONFIG.ENDPOINTS.CHATS);
        
        console.log('Chats response:', response);
        
        if (response.success) {
            allChats = response.data || [];
            console.log('All chats loaded:', allChats.length, 'chats');
            renderChatList(allChats);
        } else {
            console.error('Failed to load chats:', response.message);
            // Show error to user
            const chatList = document.getElementById('chatList');
            if (chatList) {
                chatList.innerHTML = `
                    <div class="empty-state">
                        <p style="color: #e74c3c;">Error loading chats</p>
                        <p>${response.message || 'Please try again'}</p>
                    </div>
                `;
            }
        }
    } catch (error) {
        console.error('Load chats error:', error);
        // Show error to user
        const chatList = document.getElementById('chatList');
        if (chatList) {
            chatList.innerHTML = `
                <div class="empty-state">
                    <p style="color: #e74c3c;">Connection error</p>
                    <p>Please check your internet connection and try again</p>
                </div>
            `;
        }
    }
}

/**
 * Render chat list in sidebar
 */
function renderChatList(chats) {
    const chatList = document.getElementById('chatList');
    
    console.log('Rendering chat list with', chats?.length || 0, 'chats');
    
    if (!chats || chats.length === 0) {
        chatList.innerHTML = `
            <div class="empty-state">
                <p>No chats yet. Start a new conversation!</p>
            </div>
        `;
        return;
    }
    
    chatList.innerHTML = chats.map(chat => {
        // Parse participants - they might be string or already parsed
        let participants = [];
        if (typeof chat.participants === 'string') {
            try {
                participants = JSON.parse(chat.participants);
            } catch (e) {
                participants = [];
            }
        } else if (Array.isArray(chat.participants)) {
            participants = chat.participants;
        }
        
        const currentUser = getCurrentUser();
        
        // For direct chats, show the other user's name
        let displayName = chat.chat_name;
        let displayInitial = chat.chat_name ? chat.chat_name.charAt(0).toUpperCase() : 'C';
        
        if (chat.chat_type === 'direct') {
            // Convert both to numbers for comparison to avoid type mismatch
            const currentUserId = parseInt(currentUser.userId);
            console.log('Debug chat name - Chat ID:', chat.id);
            console.log('Debug chat name - Current userId:', currentUserId);
            console.log('Debug chat name - Participants:', participants);
            const otherUser = participants.find(p => {
                const pUserId = parseInt(p.userId || p.userid);
                console.log('Debug chat name - Checking participant:', p, 'userId:', pUserId);
                return pUserId !== currentUserId;
            });
            console.log('Debug chat name - Other user found:', otherUser);
            if (otherUser) {
                displayName = otherUser.fullName || otherUser.fullName || otherUser.username;
                displayInitial = displayName.charAt(0).toUpperCase();
            }
        }
        
        // Parse last message - might be string or already parsed
        let lastMessage = null;
        if (chat.lastMessage) {
            if (typeof chat.lastMessage === 'string') {
                try {
                    lastMessage = JSON.parse(chat.lastMessage);
                } catch (e) {
                    lastMessage = null;
                }
            } else if (typeof chat.lastMessage === 'object') {
                lastMessage = chat.lastMessage;
            }
        }
        
        let lastMessageText = 'No messages yet';
        let lastMessageTime = '';
        
        if (lastMessage) {
            // Support both snake_case (from backend) and camelCase
            const messageType = lastMessage.messageType || lastMessage.message_type;
            const content = lastMessage.content;
            const fileName = lastMessage.fileName || lastMessage.file_name;
            const createdAt = lastMessage.createdAt || lastMessage.created_at;
            
            if (messageType === 'text') {
                lastMessageText = content || 'Message';
            } else if (messageType === 'image') {
                lastMessageText = '📷 Photo';
            } else if (messageType === 'video') {
                lastMessageText = '🎥 Video';
            } else if (messageType === 'file') {
                lastMessageText = `📎 ${fileName || 'File'}`;
            } else {
                lastMessageText = '📎 Attachment';
            }
            
            lastMessageTime = formatTime(createdAt);
        }
        
        // Get unread count
        const unreadCount = chat.unread_count || 0;
        
        return `
            <div class="chat-item ${chat.id === currentChatId ? 'active' : ''}" data-chat-id="${chat.id}">
                <div class="chat-item-avatar">
                    ${displayInitial}
                </div>
                <div class="chat-item-content">
                    <div class="chat-item-header">
                        <span class="chat-item-name">${escapeHtml(displayName)}</span>
                        <span class="chat-item-time">${lastMessageTime}</span>
                    </div>
                    <div class="chat-item-preview">${escapeHtml(lastMessageText)}</div>
                </div>
                ${unreadCount > 0 ? `<div class="unread-badge">${unreadCount}</div>` : ''}
                <button class="chat-delete-btn" onclick="event.stopPropagation(); deleteChat(${chat.id})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;
    }).join('');
    
    // Add click listeners
    document.querySelectorAll('.chat-item').forEach(item => {
        item.addEventListener('click', () => {
            const chatId = parseInt(item.dataset.chatId);
            openChat(chatId);
        });
    });
}

/**
 * Open a specific chat
 */
async function openChat(chatId) {
    currentChatId = chatId;
    localStorage.setItem(CONFIG.STORAGE_KEYS.CURRENT_CHAT, chatId);
    
    // Update UI to show active chat
    document.querySelectorAll('.chat-item').forEach(item => {
        item.classList.remove('active');
        if (parseInt(item.dataset.chatId) === chatId) {
            item.classList.add('active');
        }
    });
    
    // Hide welcome, show chat
    document.querySelector('.chat-welcome').style.display = 'none';
    document.getElementById('activeChat').style.display = 'flex';
    
    // Show/hide close chat button based on screen size
    const closeChatBtn = document.getElementById('closeChatBtn');
    if (closeChatBtn) {
        closeChatBtn.style.display = window.innerWidth > 768 ? 'block' : 'none';
    }
    
    // Mobile: hide sidebar and show chat main
    const chatSidebar = document.querySelector('.chat-sidebar');
    const chatMain = document.querySelector('.chat-main');
    if (window.innerWidth <= 768) {
        if (chatSidebar) chatSidebar.classList.add('hidden');
        if (chatMain) chatMain.classList.add('active');
    }
    
    // Load chat details
    await loadChatDetails(chatId);
    
    // Load messages
    await loadMessages(chatId);
    
    // Load pinned messages
    await loadPinnedMessages(chatId);
    
    // Join WebSocket room
    joinChat(chatId);
}

/**
 * Load chat details
 */
async function loadChatDetails(chatId) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.CHAT_BY_ID(chatId));
        
        if (response.success) {
            const chat = response.data;
            const currentUser = getCurrentUser();
            
            // Update chat header
            let displayName = chat.chat_name;
            let displayInitial = chat.chat_name ? chat.chat_name.charAt(0).toUpperCase() : 'C';
            let displayStatus = `${chat.participants.length} members`;
            
            if (chat.chat_type === 'direct') {
                const otherUser = chat.participants.find(p => p.id !== currentUser.userId);
                if (otherUser) {
                    displayName = otherUser.full_name || otherUser.username;
                    displayInitial = displayName.charAt(0).toUpperCase();
                    displayStatus = otherUser.status || 'offline';
                }
            }
            
            document.getElementById('chatName').textContent = displayName;
            document.getElementById('chatInitial').textContent = displayInitial;
            document.getElementById('chatStatus').textContent = displayStatus;
        }
    } catch (error) {
        console.error('Load chat details error:', error);
    }
}

/**
 * Create a new chat
 */
async function createChat(chatType, chatName, participantIds) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.CREATE_CHAT, {
            method: 'POST',
            body: JSON.stringify({
                chatType: chatType,
                chatName: chatName,
                participants: participantIds
            })
        });
        
        if (response.success) {
            // Reload chats
            await loadChats();
            
            // Open the new chat
            openChat(response.data.chatId);
            
            return response;
        }
        
        return response;
    } catch (error) {
        console.error('Create chat error:', error);
        return { success: false, message: 'Failed to create chat' };
    }
}

/**
 * Search users
 */
async function searchUsers(query) {
    if (!query || query.length < 2) {
        return [];
    }
    
    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.SEARCH_USERS}?query=${encodeURIComponent(query)}`);
        
        if (response.success) {
            return response.data || [];
        }
        
        return [];
    } catch (error) {
        console.error('Search users error:', error);
        return [];
    }
}

/**
 * Format timestamp
 */
function formatTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    // Less than 1 minute
    if (diff < 60000) {
        return 'Just now';
    }
    
    // Less than 1 hour
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes}m ago`;
    }
    
    // Less than 24 hours
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}h ago`;
    }
    
    // Less than 7 days
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days}d ago`;
    }
    
    // Show date
    return date.toLocaleDateString();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Initialize new chat modal
 */
function initializeNewChatModal() {
    const modal = document.getElementById('newChatModal');
    const newChatBtn = document.getElementById('newChatBtn');
    const closeBtn = document.getElementById('closeNewChatModal');
    const cancelBtn = document.getElementById('cancelNewChat');
    const createBtn = document.getElementById('createChatBtn');
    const userSearch = document.getElementById('userSearch');
    const chatTypeRadios = document.querySelectorAll('input[name="chatType"]');
    const groupNameGroup = document.getElementById('groupNameGroup');
    
    // Open modal
    newChatBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        selectedUsers = [];
        renderSelectedUsers();
        document.getElementById('userList').innerHTML = '';
        document.getElementById('userSearch').value = '';
    });
    
    // Close modal
    const closeModal = () => {
        modal.style.display = 'none';
    };
    
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
    
    // Toggle group name field
    chatTypeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            groupNameGroup.style.display = radio.value === 'group' ? 'block' : 'none';
        });
    });
    
    // User search
    let searchTimeout;
    userSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
            const query = e.target.value;
            const users = await searchUsers(query);
            renderUserSearchResults(users);
        }, 300);
    });
    
    // Create chat
    createBtn.addEventListener('click', async () => {
        const chatType = document.querySelector('input[name="chatType"]:checked').value;
        const chatName = document.getElementById('groupName').value;
        
        if (selectedUsers.length === 0) {
            alert('Please select at least one user');
            return;
        }
        
        if (chatType === 'group' && !chatName) {
            alert('Please enter a group name');
            return;
        }
        
        const participantIds = selectedUsers.map(u => u.id);
        
        const result = await createChat(chatType, chatName, participantIds);
        
        if (result.success) {
            closeModal();
        } else {
            alert(result.message || 'Failed to create chat');
        }
    });
}

/**
 * Render user search results
 */
function renderUserSearchResults(users) {
    const userList = document.getElementById('userList');
    
    if (users.length === 0) {
        userList.innerHTML = '<div class="empty-state"><p>No users found</p></div>';
        return;
    }
    
    userList.innerHTML = users.map(user => {
        const initial = (user.full_name || user.username).charAt(0).toUpperCase();
        const isSelected = selectedUsers.some(u => u.id === user.id);
        
        return `
            <div class="user-item ${isSelected ? 'selected' : ''}" data-user-id="${user.id}">
                <div class="user-item-avatar">${initial}</div>
                <div class="user-item-info">
                    <div class="user-item-name">${escapeHtml(user.full_name || user.username)}</div>
                    <div class="user-item-username">@${escapeHtml(user.username)}</div>
                </div>
            </div>
        `;
    }).join('');
    
    // Add click listeners
    document.querySelectorAll('.user-item').forEach(item => {
        item.addEventListener('click', () => {
            const userId = parseInt(item.dataset.userId);
            const user = users.find(u => u.id === userId);
            
            if (item.classList.contains('selected')) {
                // Remove from selected
                selectedUsers = selectedUsers.filter(u => u.id !== userId);
                item.classList.remove('selected');
            } else {
                // Add to selected
                selectedUsers.push(user);
                item.classList.add('selected');
            }
            
            renderSelectedUsers();
        });
    });
}

/**
 * Render selected users
 */
function renderSelectedUsers() {
    const selectedUsersContainer = document.getElementById('selectedUsers');
    
    if (selectedUsers.length === 0) {
        selectedUsersContainer.innerHTML = '';
        return;
    }
    
    selectedUsersContainer.innerHTML = selectedUsers.map(user => `
        <div class="selected-user">
            <span>${escapeHtml(user.full_name || user.username)}</span>
            <button onclick="removeSelectedUser(${user.id})">×</button>
        </div>
    `).join('');
}

/**
 * Remove selected user
 */
function removeSelectedUser(userId) {
    selectedUsers = selectedUsers.filter(u => u.id !== userId);
    renderSelectedUsers();
    
    // Update user list display
    document.querySelectorAll('.user-item').forEach(item => {
        if (parseInt(item.dataset.userId) === userId) {
            item.classList.remove('selected');
        }
    });
}
