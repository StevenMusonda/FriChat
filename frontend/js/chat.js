/**
 * Chat Module
 * Handles chat operations and UI updates
 */

// The feature scripts (formatter.js ... disappearing.js) each run in their own scope and share
// only what other files need on this namespace; it exists even if none of them loaded
globalThis.FriChat = globalThis.FriChat || {};

let currentChatId = null;
let allChats = [];
let selectedUsers = [];
// Members of the open group chat, for @mention suggestions (empty for direct chats)
let currentChatMembers = [];

// Whether the sidebar's Archived section is open (remembered per browser)
let archivedExpanded = false;
try {
    archivedExpanded = localStorage.getItem(CONFIG.STORAGE_KEYS.ARCHIVED_EXPANDED) === '1';
} catch (e) {
    // Storage unavailable: start collapsed
}

/**
 * Call an optional feature function (window.FriChat) for the chat list: a feature script that is
 * missing or throws gives the fallback instead of an empty sidebar
 */
function chatListFeature(name, fallback, ...args) {
    const fn = FriChat[name];
    if (typeof fn !== 'function') return fallback;
    try {
        return fn(...args);
    } catch (error) {
        console.error(`Chat list: ${name} failed`, error);
        return fallback;
    }
}

const MUTED_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
const ARCHIVE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`;

/**
 * Load all chats for current user
 */
async function loadChats() {
    try {
        console.log('Loading chats...');
        console.log('User data:', getCurrentUser());
        console.log('API endpoint:', CONFIG.API_BASE_URL + CONFIG.ENDPOINTS.CHATS);
        
        const response = await apiRequest(CONFIG.ENDPOINTS.CHATS);
        
        console.log('Chats response:', response);
        
        if (response.success) {
            allChats = response.data || [];
            console.log('All chats loaded:', allChats.length, 'chats');
            refreshChatList();
            updateChatHeaderState();
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

    const renderChatItem = (chat) => {
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
        // Photo and custom status as the server lets this user see them (privacy settings)
        let avatarSrc = chat.chat_type === 'group' ? chatListFeature('groupAvatarSrc', null, chat.avatar_url) : null;
        let statusLabel = '';
        
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
                avatarSrc = chatListFeature('userAvatarSrc', avatarSrc, otherUser.avatarUrl);
                statusLabel = chatListFeature('customStatusLabel', statusLabel, otherUser.customStatus);
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
            console.log('Chat', chat.id, 'lastMessage:', lastMessage);
        }
        
        let lastMessageText = 'No messages yet';
        let lastMessageTime = '';
        
        if (lastMessage) {
            // Support both snake_case (from backend), camelCase, and lowercase
            const messageType = lastMessage.messageType || lastMessage.message_type || lastMessage.messagetype;
            const content = lastMessage.content;
            const fileName = lastMessage.fileName || lastMessage.file_name || lastMessage.filename;
            const createdAt = lastMessage.createdAt || lastMessage.created_at || lastMessage.createdat;
            
            if (lastMessage.deleted === true || lastMessage.deleted === 1) {
                lastMessageText = '🚫 This message was deleted';
            } else if (messageType === 'text') {
                lastMessageText = content || 'Message';
            } else if (messageType === 'image') {
                lastMessageText = '📷 Photo';
            } else if (messageType === 'video') {
                lastMessageText = '🎥 Video';
            } else if (messageType === 'file') {
                lastMessageText = `📎 ${fileName || 'File'}`;
            } else if (messageType === 'poll') {
                lastMessageText = `📊 ${content || 'Poll'}`;
            } else if (messageType === 'event') {
                lastMessageText = `📅 ${content || 'Event'}`;
            } else if (messageType === 'voice') {
                lastMessageText = '🎤 Voice message';
            } else if (messageType === 'system') {
                // "You turned on disappearing messages..." (disappearing.js; escaped below like any preview)
                lastMessageText = chatListFeature('describeSystemMessage', 'Chat settings were changed', { content, sender_id: lastMessage.senderId || lastMessage.sender_id || lastMessage.senderid, full_name: lastMessage.full_name || null, username: lastMessage.senderName || lastMessage.username || lastMessage.sendername });
            } else {
                lastMessageText = '📎 Attachment';
            }
            
            lastMessageTime = formatTime(createdAt);
        }
        
        // Unsent text saved for this chat (composer.js); not shown for the chat being typed in
        const draft = chat.id !== currentChatId ? chatListFeature('getDraftPreview', '', chat.id) : '';

        // Get unread count (grey when muted)
        const unreadCount = chat.unread_count || 0;
        const unreadLabel = unreadCount > 99 ? '99+' : unreadCount;

        return `
            <div class="chat-item ${chat.id === currentChatId ? 'active' : ''} ${chat.is_muted ? 'muted' : ''}" data-chat-id="${chat.id}">
                <div class="chat-item-avatar">
                    ${chatListFeature('avatarInnerHtml', escapeHtml(displayInitial), displayInitial, avatarSrc)}
                </div>
                <div class="chat-item-content">
                    <div class="chat-item-header">
                        <span class="chat-item-title">
                            <span class="chat-item-name">${escapeHtml(displayName)}</span>
                            ${statusLabel ? `<span class="chat-item-custom-status" title="${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}</span>` : ''}
                            ${chat.is_muted ? `<span class="chat-item-muted" title="Muted" aria-label="Muted">${MUTED_ICON_SVG}</span>` : ''}
                            ${chatListFeature('renderChatListDisappearingIcon', '', chat)}
                        </span>
                        <span class="chat-item-time">${lastMessageTime}</span>
                    </div>
                    ${draft
                        ? `<div class="chat-item-preview has-draft"><span class="chat-item-draft">Draft:</span> ${escapeHtml(draft)}</div>`
                        : `<div class="chat-item-preview">${escapeHtml(lastMessageText)}</div>`}
                </div>
                ${chat.unread_mention_count > 0 ? `<div class="mention-badge" title="You were mentioned" aria-label="Unread mention">@</div>` : ''}
                ${unreadCount > 0 ? `<div class="unread-badge ${chat.is_muted ? 'muted' : ''}" aria-label="${unreadCount} unread">${unreadLabel}</div>` : ''}
                <button class="chat-delete-btn" onclick="event.stopPropagation(); deleteChat(${chat.id})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;
    };

    // Incoming message requests sit in their own section above the list (profile.js);
    // archived chats live in their own collapsible section under the main list
    const isRequest = (chat) => chatListFeature('isIncomingRequest', false, chat);
    const requestChats = chats.filter(isRequest);
    const activeChats = chats.filter(chat => !chat.archived_at && !isRequest(chat));
    const archivedChats = chats.filter(chat => chat.archived_at && !isRequest(chat));

    let html = '';
    if (requestChats.length > 0) {
        const expanded = chatListFeature('isRequestsExpanded', false);
        html += chatListFeature('renderRequestsToggleHtml', '', requestChats.length)
            + `<div class="archived-chat-list request-chat-list" id="requestChatList" ${expanded ? '' : 'hidden'}>${requestChats.map(renderChatItem).join('')}</div>`;
    }

    html += activeChats.length > 0
        ? activeChats.map(renderChatItem).join('')
        : '<div class="empty-state"><p>No active chats</p></div>';

    if (archivedChats.length > 0) {
        const archivedUnread = archivedChats.reduce((sum, chat) => sum + (chat.unread_count || 0), 0);
        html += `
            <button type="button" class="archived-toggle" id="archivedToggle" aria-expanded="${archivedExpanded}" aria-controls="archivedChatList">
                ${ARCHIVE_ICON_SVG}
                <span class="archived-toggle-label">Archived</span>
                <span class="archived-toggle-count">${archivedChats.length}${archivedUnread > 0 ? ` · ${archivedUnread} unread` : ''}</span>
                <svg class="archived-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="archived-chat-list" id="archivedChatList" ${archivedExpanded ? '' : 'hidden'}>
                ${archivedChats.map(renderChatItem).join('')}
            </div>
        `;
    }

    chatList.innerHTML = html;

    // Add click listeners
    document.querySelectorAll('.chat-item').forEach(item => {
        item.addEventListener('click', () => {
            const chatId = parseInt(item.dataset.chatId);
            openChat(chatId);
        });
    });

    chatListFeature('bindRequestsToggle');

    const archivedToggle = document.getElementById('archivedToggle');
    if (archivedToggle) {
        archivedToggle.addEventListener('click', () => {
            archivedExpanded = !archivedExpanded;
            try {
                localStorage.setItem(CONFIG.STORAGE_KEYS.ARCHIVED_EXPANDED, archivedExpanded ? '1' : '0');
            } catch (e) {
                // Remembering the section state is only a convenience
            }
            archivedToggle.setAttribute('aria-expanded', archivedExpanded);
            document.getElementById('archivedChatList').hidden = !archivedExpanded;
        });
    }
}

/**
 * Re-render the sidebar from allChats, keeping the search filter
 */
function refreshChatList() {
    const search = document.getElementById('chatSearch');
    const query = search ? search.value.toLowerCase() : '';

    renderChatList(query
        ? allChats.filter(chat => (chat.chat_name || '').toLowerCase().includes(query))
        : allChats);

    // App icon badge and tab title (notifications.js)
    updateUnreadIndicators(allChats);
}

/**
 * Set a chat's badge
 */
function setChatUnreadCount(chatId, count) {
    const chat = allChats.find(c => c.id === chatId);
    if (!chat || chat.unread_count === count) return;

    chat.unread_count = count;
    refreshChatList();
}

/**
 * Update the sidebar for an arriving message without refetching every chat
 */
function applyIncomingMessageToChatList(message, countAsUnread) {
    const chat = allChats.find(c => c.id === message.chat_id);
    if (!chat) {
        // A chat we don't know about yet
        loadChats();
        return;
    }

    chat.lastMessage = message;
    chat.updated_at = message.created_at;
    if (countAsUnread) {
        chat.unread_count = (chat.unread_count || 0) + 1;
        // The @ badge stays until the mentioning message is read
        if (isMessageMentioningMe(message)) {
            chat.unread_mention_count = (chat.unread_mention_count || 0) + 1;
        }
    }
    // Same rule the server applies: a new message brings an archived chat back unless it's muted
    if (chat.archived_at && !chat.is_muted) {
        chat.archived_at = null;
    }

    // Most recent first
    allChats = [chat, ...allChats.filter(c => c !== chat)];
    refreshChatList();
}

/**
 * Server-confirmed read position (from this tab or another one)
 */
function applyReadPosition(data) {
    const chat = allChats.find(c => c.id === data.chatId);
    if (!chat) return;

    chat.last_read_message_id = data.lastReadMessageId;
    if (data.chatId === currentChatId) {
        lastMarkedReadId = Math.max(lastMarkedReadId, data.lastReadMessageId || 0);
    }

    chat.unread_count = data.unreadCount;
    if (data.unreadMentionCount !== undefined) {
        chat.unread_mention_count = data.unreadMentionCount;
    }
    refreshChatList();
}

/**
 * Server-confirmed mute/archive state (from this tab or another one)
 */
function applyChatSettings(data) {
    const chat = allChats.find(c => c.id === data.chatId);
    if (!chat) return;

    chat.muted_until = data.mutedUntil;
    chat.is_muted = data.isMuted;
    chat.archived_at = data.archivedAt;
    if (data.mentionsOnly !== undefined) {
        chat.mentions_only = data.mentionsOnly;
    }

    refreshChatList();
    if (chat.id === currentChatId) {
        updateChatHeaderState();
    }
}

/**
 * Show the muted icon in the open chat's header
 */
function updateChatHeaderState() {
    const mutedIcon = document.getElementById('chatMutedIcon');
    const chat = allChats.find(c => c.id === currentChatId);
    if (mutedIcon) {
        mutedIcon.hidden = !(chat && chat.is_muted);
    }
}

/**
 * "Muted until ..." text for the options menu
 */
function getMuteStatusText(chat) {
    const until = new Date(chat.muted_until);
    if (isNaN(until) || until.getFullYear() >= 9999) {
        return 'Muted until you unmute';
    }
    return `Muted until ${until.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Header menu with mute and archive options for the open chat
 */
function toggleChatOptionsMenu(event) {
    event.stopPropagation();

    if (document.getElementById('chatOptionsMenu')) {
        closeChatOptionsMenu();
        return;
    }

    const chat = allChats.find(c => c.id === currentChatId);
    if (!chat) return;

    const item = (action, label) =>
        `<button type="button" class="message-action-item" role="menuitem" data-action="${action}">${label}</button>`;

    const menu = document.createElement('div');
    menu.id = 'chatOptionsMenu';
    menu.className = 'message-action-dropdown chat-options-dropdown';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = (chat.is_muted
        ? `<div class="chat-options-note">${escapeHtml(getMuteStatusText(chat))}</div>` + item('mute:off', 'Unmute')
        : item('mute:8h', 'Mute for 8 hours') + item('mute:1w', 'Mute for 1 week') + item('mute:always', 'Mute always'))
        + (chat.chat_type === 'group'
            ? '<div class="chat-options-separator" role="separator"></div>'
              + `<button type="button" class="message-action-item chat-options-check" role="menuitemcheckbox" aria-checked="${chat.mentions_only ? 'true' : 'false'}" data-action="mentions:${chat.mentions_only ? 'off' : 'on'}">`
              + `<span class="chat-options-checkmark" aria-hidden="true">${chat.mentions_only ? '✓' : ''}</span>Notify only for @mentions</button>`
              + (chat.mentions_only ? `<div class="chat-options-note">${chat.is_muted ? 'Muted, but @mentions still notify you' : 'Other messages don\'t notify you'}</div>` : '')
            : '')
        + '<div class="chat-options-separator" role="separator"></div>'
        + item('plans:event', 'New event')
        + item('plans:open', 'Events &amp; lists')
        + '<div class="chat-options-separator" role="separator"></div>'
        + item('disappearing:open', escapeHtml(typeof FriChat.disappearingMenuLabel === 'function' ? FriChat.disappearingMenuLabel() : 'Disappearing messages'))
        + '<div class="chat-options-separator" role="separator"></div>'
        + (chat.archived_at ? item('archive:off', 'Unarchive chat') : item('archive:on', 'Archive chat'));

    // Direct chats: block or unblock the other person (security.js keeps the blocked list)
    const otherUser = chat.chat_type === 'direct' ? getDirectChatOtherUser(chat) : null;
    if (otherUser) {
        menu.innerHTML += '<div class="chat-options-separator" role="separator"></div>'
            + (FriChat.isUserBlocked(otherUser.userId) ? item('block:off', 'Unblock user') : item('block:on', 'Block user'));
    }

    menu.addEventListener('click', (e) => {
        const button = e.target.closest('[data-action]');
        if (!button) return;

        const [kind, value] = button.dataset.action.split(':');
        closeChatOptionsMenu();
        if (kind === 'mute') {
            setChatMute(chat.id, value);
        } else if (kind === 'block') {
            FriChat.setUserBlocked(otherUser.userId, value === 'on', otherUser.fullName || otherUser.username);
        } else if (kind === 'mentions') {
            setChatMentionsOnly(chat.id, value === 'on');
        } else if (kind === 'disappearing') {
            FriChat.openDisappearingModal();
        } else if (kind === 'plans') {
            if (value === 'event') FriChat.openEventForm();
            else FriChat.openChatPlans();
        } else {
            setChatArchived(chat.id, value === 'on');
        }
    });

    document.getElementById('chatOptionsBtn').setAttribute('aria-expanded', 'true');
    document.querySelector('.chat-actions').appendChild(menu);
    menu.querySelector('[data-action]').focus();

    setTimeout(() => {
        document.addEventListener('click', closeChatOptionsMenuOnOutsideClick);
        document.addEventListener('keydown', closeChatOptionsMenuOnEscape);
    }, 0);
}

/**
 * The other participant of a direct chat from the chat list ({ userId, username, fullName }), or null
 */
function getDirectChatOtherUser(chat) {
    let participants = [];
    try {
        participants = typeof chat.participants === 'string' ? JSON.parse(chat.participants) : (chat.participants || []);
    } catch (e) {
        return null;
    }
    const me = getCurrentUser().userId;
    return participants.find(p => Number(p.userId) !== Number(me)) || null;
}

function closeChatOptionsMenu() {
    const menu = document.getElementById('chatOptionsMenu');
    if (menu) menu.remove();

    const button = document.getElementById('chatOptionsBtn');
    if (button) button.setAttribute('aria-expanded', 'false');

    document.removeEventListener('click', closeChatOptionsMenuOnOutsideClick);
    document.removeEventListener('keydown', closeChatOptionsMenuOnEscape);
}

function closeChatOptionsMenuOnOutsideClick(e) {
    const menu = document.getElementById('chatOptionsMenu');
    if (menu && !menu.contains(e.target)) closeChatOptionsMenu();
}

function closeChatOptionsMenuOnEscape(e) {
    if (e.key === 'Escape') {
        closeChatOptionsMenu();
        document.getElementById('chatOptionsBtn').focus();
    }
}

/**
 * duration: '8h' | '1w' | 'always' | 'off'
 */
async function setChatMute(chatId, duration) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MUTE_CHAT(chatId), {
            method: 'PUT',
            body: JSON.stringify({ duration })
        });

        if (response.success) {
            applyChatSettings(response.data);
        } else {
            showNotification(response.message || 'Failed to update mute setting', 'error');
        }
    } catch (error) {
        console.error('Mute chat error:', error);
        showNotification('Failed to update mute setting', 'error');
    }
}

/**
 * Push only for @mentions in this chat (mentions also get through a mute)
 */
async function setChatMentionsOnly(chatId, enabled) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MENTIONS_ONLY(chatId), {
            method: 'PUT',
            body: JSON.stringify({ enabled })
        });

        if (response.success) {
            applyChatSettings(response.data);
        } else {
            showNotification(response.message || 'Failed to update notification setting', 'error');
        }
    } catch (error) {
        console.error('Mentions-only error:', error);
        showNotification('Failed to update notification setting', 'error');
    }
}

async function setChatArchived(chatId, archived) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.ARCHIVE_CHAT(chatId), {
            method: 'PUT',
            body: JSON.stringify({ archived })
        });

        if (response.success) {
            applyChatSettings(response.data);
        } else {
            showNotification(response.message || 'Failed to update archive setting', 'error');
        }
    } catch (error) {
        console.error('Archive chat error:', error);
        showNotification('Failed to update archive setting', 'error');
    }
}

/**
 * Open a specific chat
 * options.aroundMessageId: open at that message instead of the newest one (search, stars, quotes)
 */
async function openChat(chatId, options = {}) {
    // Unsent text stays with the chat being left (composer.js); read before an edit is cancelled
    const leavingChatId = currentChatId;
    FriChat.saveCurrentDraft();

    // Reply/edit/selection belong to the chat being left (messageActions.js)
    resetMessageActionState();

    currentChatId = chatId;

    // Files waiting in the tray belong to the chat being left; bring back this chat's draft
    if (leavingChatId !== chatId) {
        FriChat.resetUploadTray();
        FriChat.restoreDraft(chatId);
    }
    currentChatMembers = [];
    // Composer lock, header avatar and join-request badge belong to the chat being left (groups.js)
    FriChat.resetGroupState();
    // Message request bar (profile.js)
    if (typeof FriChat.resetMessageRequestState === 'function') FriChat.resetMessageRequestState();
    // "N scheduled messages in this chat" bar (planner.js)
    if (typeof FriChat.resetPlannerChatState === 'function') FriChat.resetPlannerChatState();
    // Voice note playing or being recorded, disappearing-messages clock (voice.js, disappearing.js)
    if (typeof FriChat.resetVoiceState === 'function') FriChat.resetVoiceState();
    if (typeof FriChat.resetDisappearingState === 'function') FriChat.resetDisappearingState();
    // Voice/video call buttons belong to the chat being left (calls.js)
    if (typeof FriChat.resetCallHeader === 'function') FriChat.resetCallHeader();
    // Birthday banner of the chat being left (events.js)
    if (typeof FriChat.resetPlanChatState === 'function') FriChat.resetPlanChatState();
    localStorage.setItem(CONFIG.STORAGE_KEYS.CURRENT_CHAT, chatId);
    closeChatOptionsMenu();
    updateChatHeaderState();
    
    // Update UI to show active chat (re-rendered so the left chat shows its "Draft:" preview)
    if (leavingChatId !== chatId) {
        refreshChatList();
    }
    
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
    
    // Load messages: the newest page, or the page around the message being jumped to
    if (options.aroundMessageId) {
        await loadMessagesAround(chatId, options.aroundMessageId);
    } else {
        await loadMessages(chatId);
    }
    
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

            // @mention suggestions (mentions.js) only exist in groups, and only for the chat still open
            if (chat.id === currentChatId) {
                currentChatMembers = chat.chat_type === 'group'
                    ? chat.participants.filter(p => p.id !== currentUser.userId)
                    : [];
            }
            
            // Update chat header
            let displayName = chat.chat_name;
            let displayInitial = chat.chat_name ? chat.chat_name.charAt(0).toUpperCase() : 'C';
            let displayStatus = `${chat.participants.length} members`;
            
            if (chat.chat_type === 'direct') {
                const otherUser = chat.participants.find(p => p.id !== currentUser.userId);
                if (otherUser) {
                    displayName = otherUser.full_name || otherUser.username;
                    displayInitial = displayName.charAt(0).toUpperCase();
                    // Only what the other person shares (privacy settings); empty when hidden
                    displayStatus = typeof FriChat.directChatStatusText === 'function' ? FriChat.directChatStatusText(otherUser) : (otherUser.status || '');
                }
            }
            
            if (chat.id !== currentChatId) return;

            document.getElementById('chatName').textContent = displayName;
            document.getElementById('chatInitial').textContent = displayInitial;
            document.getElementById('chatStatus').textContent = displayStatus;

            // Group avatar, announcement-only composer and join-request badge (groups.js)
            FriChat.applyChatDetails(chat);

            // Message request bar (profile.js)
            if (typeof FriChat.applyMessageRequestState === 'function') FriChat.applyMessageRequestState(chat);

            // Disappearing messages timer: header clock, who may change it (disappearing.js)
            if (typeof FriChat.applyDisappearingDetails === 'function') FriChat.applyDisappearingDetails(chat);

            // Voice/video call buttons for direct chats (calls.js)
            if (typeof FriChat.applyCallDetails === 'function') FriChat.applyCallDetails(chat);

            // Birthday banner in groups (events.js)
            if (typeof FriChat.applyPlanChatState === 'function') FriChat.applyPlanChatState(chat);
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
            if (response.data && response.data.messageRequest) {
                showNotification('Sent as a message request: they\'ll see it in their Requests until they accept.', 'info');
            }

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
 * The one HTML-escaping helper for user content inserted with innerHTML/template strings.
 * The server stores text raw, so everything user-written must pass through here (or textContent).
 * Escapes quotes too, so the result is also safe inside quoted attributes.
 */
function escapeHtml(text) {
    if (text === null || text === undefined) return '';

    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
        const avatarSrc = typeof FriChat.userAvatarSrc === 'function' ? FriChat.userAvatarSrc(user.avatar_url) : null;
        
        return `
            <div class="user-item ${isSelected ? 'selected' : ''}" data-user-id="${user.id}">
                <div class="user-item-avatar">${typeof FriChat.avatarInnerHtml === 'function' ? FriChat.avatarInnerHtml(initial, avatarSrc) : escapeHtml(initial)}</div>
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
