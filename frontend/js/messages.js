/**
 * Messages Module
 * Handles message display, sending, and file uploads
 */

let currentMessages = [];

// Paging: the newest page is loaded on open, older pages as the user scrolls up
let hasOlderMessages = false;
let oldestMessageCursor = null;
let loadingOlderMessages = false;
let messagesLoadToken = 0; // bumps on every chat open so late responses for the old chat are dropped

// After jumping to an older message (search, quote, star) the newest page isn't loaded:
// newer pages load as the user scrolls down, and live messages wait behind the jump button
let hasNewerMessages = false;
let newestMessageCursor = null;
let loadingNewerMessages = false;

// Read position
let lastReadAtOpen = null;   // server read position when the chat was opened (places the divider)
let unreadDividerId = null;  // message the "New messages" line sits above
let lastMarkedReadId = 0;    // newest id already sent to the server
let newWhileScrolledUp = 0;  // arrivals the user hasn't scrolled down to yet

const NEAR_BOTTOM_PX = 150;
const LOAD_OLDER_THRESHOLD_PX = 120;

/**
 * Load the newest page of messages for a chat
 */
async function loadMessages(chatId) {
    const loadToken = ++messagesLoadToken;
    resetThreadState();

    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.MESSAGES(chatId)}?limit=${CONFIG.MESSAGE_PAGE_SIZE}`);

        if (loadToken !== messagesLoadToken) return;

        if (response.success) {
            currentMessages = response.data || [];
            hasOlderMessages = !!(response.pagination && response.pagination.hasMore);
            oldestMessageCursor = response.pagination ? response.pagination.nextCursor : null;
            lastReadAtOpen = response.lastReadMessageId || 0;
            unreadDividerId = findFirstUnreadId(currentMessages, lastReadAtOpen);

            renderMessages(currentMessages);
            scrollToFirstUnreadOrBottom();
            updateJumpButton();

            markChatAsRead(chatId);
        }
    } catch (error) {
        console.error('Load messages error:', error);
    }
}

/**
 * Load a page centred on a message that may be far back in the history.
 * Returns true when the message is in the thread afterwards.
 */
async function loadMessagesAround(chatId, messageId) {
    const loadToken = ++messagesLoadToken;
    resetThreadState();

    try {
        const response = await apiRequest(
            `${CONFIG.ENDPOINTS.MESSAGES(chatId)}?limit=${CONFIG.MESSAGE_PAGE_SIZE}&around=${encodeURIComponent(messageId)}`
        );

        if (loadToken !== messagesLoadToken || !response.success) return false;

        const pagination = response.pagination || {};
        currentMessages = response.data || [];
        hasOlderMessages = !!pagination.hasMore;
        oldestMessageCursor = pagination.nextCursor || null;
        hasNewerMessages = !!pagination.hasNewer;
        newestMessageCursor = pagination.newerCursor || null;
        lastReadAtOpen = response.lastReadMessageId || 0;
        unreadDividerId = findFirstUnreadId(currentMessages, lastReadAtOpen);

        renderMessages(currentMessages);
        updateJumpButton();

        // Only when the page reaches the newest message does opening it count as reading it
        if (!hasNewerMessages) markChatAsRead(chatId);

        return currentMessages.some(m => m.id === messageId);
    } catch (error) {
        console.error('Load messages around error:', error);
        return false;
    }
}

/**
 * Fetch the page after the newest loaded message (only after a jump into the history)
 */
async function loadNewerMessages() {
    if (!hasNewerMessages || loadingNewerMessages || !currentChatId) return;

    const chatId = currentChatId;
    const loadToken = messagesLoadToken;
    loadingNewerMessages = true;

    try {
        const response = await apiRequest(
            `${CONFIG.ENDPOINTS.MESSAGES(chatId)}?limit=${CONFIG.MESSAGE_PAGE_SIZE}&after=${newestMessageCursor}`
        );

        if (loadToken !== messagesLoadToken || !response.success) return;

        const pagination = response.pagination || {};
        hasNewerMessages = !!pagination.hasNewer;
        newestMessageCursor = pagination.newerCursor || null;

        const newer = (response.data || []).filter(m => !currentMessages.some(existing => existing.id === m.id));
        currentMessages = currentMessages.concat(newer);
        document.getElementById('messagesContainer').insertAdjacentHTML('beforeend', renderMessagesHtml(newer));

        // Caught up with the live thread: arrivals behind the button are in this page now
        if (!hasNewerMessages) newWhileScrolledUp = 0;
        updateJumpButton();
    } catch (error) {
        console.error('Load newer messages error:', error);
    } finally {
        if (loadToken === messagesLoadToken) loadingNewerMessages = false;
    }
}

/**
 * Leave the history and show the newest page at the bottom
 */
async function returnToLatestMessages() {
    if (!currentChatId) return;
    await loadMessages(currentChatId);
    scrollToBottom();
    updateJumpButton();
}

/**
 * Forget everything about the previously open thread
 */
function resetThreadState() {
    currentMessages = [];
    hasOlderMessages = false;
    oldestMessageCursor = null;
    loadingOlderMessages = false;
    hasNewerMessages = false;
    newestMessageCursor = null;
    loadingNewerMessages = false;
    lastReadAtOpen = null;
    unreadDividerId = null;
    lastMarkedReadId = 0;
    newWhileScrolledUp = 0;
}

/**
 * Fetch the page before the oldest loaded message and prepend it without moving the view
 */
async function loadOlderMessages() {
    if (!hasOlderMessages || loadingOlderMessages || !currentChatId) return;

    const chatId = currentChatId;
    const loadToken = messagesLoadToken;
    loadingOlderMessages = true;
    setLoaderSpinning(true);

    try {
        const response = await apiRequest(
            `${CONFIG.ENDPOINTS.MESSAGES(chatId)}?limit=${CONFIG.MESSAGE_PAGE_SIZE}&before=${oldestMessageCursor}`
        );

        if (loadToken !== messagesLoadToken) return;

        if (response.success) {
            hasOlderMessages = !!(response.pagination && response.pagination.hasMore);
            oldestMessageCursor = response.pagination ? response.pagination.nextCursor : null;
            prependMessages(response.data || []);
        }
    } catch (error) {
        console.error('Load older messages error:', error);
    } finally {
        if (loadToken === messagesLoadToken) {
            loadingOlderMessages = false;
            setLoaderSpinning(false);
        }
    }
}

/**
 * Insert older messages above the current ones, keeping what the user sees in place
 */
function prependMessages(older) {
    const container = document.getElementById('messagesContainer');
    const loader = document.getElementById('messagesLoader');
    if (!container || !loader) return;

    // Keep the message at the top of the view exactly where it is
    const anchor = container.querySelector('.message');
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;

    // Everything loaded so far is newer than the read position, so the first unread may be further up
    if (unreadDividerId && currentMessages.length > 0 && currentMessages[0].id > lastReadAtOpen) {
        const earlier = findFirstUnreadId(older, lastReadAtOpen);
        if (earlier) {
            const divider = document.getElementById('unreadDivider');
            if (divider) divider.remove();
            unreadDividerId = earlier;
        }
    }

    currentMessages = older.concat(currentMessages);
    loader.insertAdjacentHTML('afterend', renderMessagesHtml(older));
    loader.style.display = hasOlderMessages ? '' : 'none';

    if (anchor && anchor.isConnected) {
        container.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
}

/**
 * First message from someone else newer than the read position
 */
function findFirstUnreadId(messages, lastReadId) {
    const currentUser = getCurrentUser();
    const unread = messages.find(m =>
        m.id > (lastReadId || 0) &&
        m.sender_id !== currentUser.userId &&
        !m.deleted_for_everyone
    );
    return unread ? unread.id : null;
}

/**
 * Tell the server the user has seen everything loaded (the newest page is always loaded)
 */
function markChatAsRead(chatId) {
    if (!chatId || currentMessages.length === 0) return;

    const newestId = currentMessages[currentMessages.length - 1].id;
    if (newestId <= lastMarkedReadId) return;
    lastMarkedReadId = newestId;

    if (window.socket && window.socket.connected) {
        markReadViaSocket(chatId, newestId);
    } else {
        apiRequest(CONFIG.ENDPOINTS.MARK_READ(chatId), {
            method: 'POST',
            body: JSON.stringify({ messageId: newestId })
        }).catch(error => console.error('Mark read error:', error));
    }

    // The server confirms with read_position_updated; clear the badge now so it doesn't flicker
    setChatUnreadCount(chatId, 0);
}

/**
 * Distance check used for auto-scroll, auto-read and the jump button
 */
function isNearBottom() {
    const container = document.getElementById('messagesContainer');
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
}

/**
 * Open a chat at the "New messages" line if there is one, otherwise at the bottom
 */
function scrollToFirstUnreadOrBottom() {
    const container = document.getElementById('messagesContainer');
    const divider = document.getElementById('unreadDivider');

    if (container && divider) {
        container.scrollTop += divider.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
    } else {
        scrollToBottom();
    }
}

/**
 * Show the floating button when scrolled away from the bottom, with a count of arrivals
 */
function updateJumpButton() {
    const button = document.getElementById('jumpToLatestBtn');
    if (!button) return;

    const count = button.querySelector('.jump-to-latest-count');
    button.hidden = isNearBottom() && !hasNewerMessages;
    button.classList.toggle('has-count', newWhileScrolledUp > 0);
    count.textContent = newWhileScrolledUp > 0 ? `${newWhileScrolledUp > 99 ? '99+' : newWhileScrolledUp} new` : '';
    button.setAttribute('aria-label', newWhileScrolledUp > 0
        ? `Jump to latest, ${newWhileScrolledUp} new messages`
        : 'Jump to latest');
}

/**
 * The user is looking at the bottom of the thread: everything there counts as read
 */
function handleReachedLatest() {
    // In the history the bottom of the view isn't the latest message
    if (!currentChatId || document.hidden || hasNewerMessages || !isNearBottom()) return;

    if (newWhileScrolledUp > 0) {
        newWhileScrolledUp = 0;
        updateJumpButton();
    }
    markChatAsRead(currentChatId);
}

/**
 * Scroll handling for the thread: load older pages near the top, read state near the bottom
 */
function initializeMessageScroll() {
    const container = document.getElementById('messagesContainer');
    const jumpButton = document.getElementById('jumpToLatestBtn');

    container.addEventListener('scroll', () => {
        if (container.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
            loadOlderMessages();
        }
        if (hasNewerMessages && container.scrollHeight - container.scrollTop - container.clientHeight < LOAD_OLDER_THRESHOLD_PX) {
            loadNewerMessages();
        }
        updateJumpButton();
        handleReachedLatest();
    }, { passive: true });

    jumpButton.addEventListener('click', () => {
        if (hasNewerMessages) {
            returnToLatestMessages();
            return;
        }
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    });
}

/**
 * Receipts: someone else read up to a message, so our messages up to it are read
 */
function handleMessagesRead(data) {
    const currentUser = getCurrentUser();
    if (data.chatId !== currentChatId || data.readerId === currentUser.userId) return;

    currentMessages.forEach(message => {
        if (message.sender_id === currentUser.userId && message.id <= data.upToMessageId && message.status !== 'read') {
            updateMessageStatusInUI(message.id, 'read');
        }
    });
}

/**
 * Render messages in chat window
 */
function renderMessages(messages) {
    const container = document.getElementById('messagesContainer');

    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>No messages yet. Start the conversation!</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = renderLoaderHtml() + renderMessagesHtml(messages);
}

/**
 * Spinner row at the top of the thread; takes space only while older pages exist
 */
function renderLoaderHtml() {
    return `
        <div class="messages-loader" id="messagesLoader" style="${hasOlderMessages ? '' : 'display: none;'}" aria-hidden="true">
            <span class="messages-loader-spinner"></span>
        </div>
    `;
}

/**
 * Spin only while a request is in flight (visibility, so the layout doesn't shift)
 */
function setLoaderSpinning(spinning) {
    const loader = document.getElementById('messagesLoader');
    if (loader) loader.classList.toggle('loading', spinning);
}

/**
 * HTML for a run of messages, with the "New messages" line where it belongs
 */
function renderMessagesHtml(messages) {
    return messages.map(message => {
        const divider = message.id === unreadDividerId
            ? '<div class="unread-divider" id="unreadDivider" role="separator"><span>New messages</span></div>'
            : '';
        return divider + renderMessageHtml(message);
    }).join('');
}

/**
 * HTML for one message ('' when it was deleted for the current user only)
 */
function renderMessageHtml(message) {
    const currentUser = getCurrentUser();
    const isSent = message.sender_id === currentUser.userId;
    const senderInitial = escapeHtml((message.full_name || message.username).charAt(0).toUpperCase());
    // Clicking the sender's name opens their profile card (profile.js)
    const senderProfileAttrs = `data-profile-user-id="${Number(message.sender_id)}" role="button" tabindex="0"`;

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
                    ${!isSent ? `<div class="message-sender profile-link" ${senderProfileAttrs}>${escapeHtml(message.full_name || message.username)}${typeof renderMemberTagHtml === 'function' ? renderMemberTagHtml(message.sender_id) : ''}</div>` : ''}
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

    const isSelected = typeof selectedMessageIds !== 'undefined' && selectedMessageIds.has(message.id);
    const mentionsMe = isMessageMentioningMe(message);

    return `
        <div class="message ${isSent ? 'sent' : 'received'} ${isSelected ? 'selected' : ''} ${mentionsMe ? 'mentioned' : ''}" data-message-id="${message.id}">
            <div class="message-actions">
                <button class="message-action-btn" onclick="showMessageActions(${message.id}, event)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="1"></circle>
                        <circle cx="19" cy="12" r="1"></circle>
                        <circle cx="5" cy="12" r="1"></circle>
                    </svg>
                </button>
            </div>
            <div class="message-avatar profile-link" ${senderProfileAttrs}>${senderInitial}</div>
            <div class="message-content">
                ${!isSent ? `<div class="message-sender profile-link" ${senderProfileAttrs}>${escapeHtml(message.full_name || message.username)}${typeof renderMemberTagHtml === 'function' ? renderMemberTagHtml(message.sender_id) : ''}</div>` : ''}
                <div class="message-bubble">
                    ${message.is_forwarded ? `<div class="message-forwarded">${FORWARD_ICON_SVG}<span>Forwarded</span></div>` : ''}
                    ${renderReplyQuote(message.reply_to)}
                    ${renderMessageContent(message)}
                    ${renderMessageReactions(groupedReactions, message.id)}
                </div>
                <div class="message-footer">
                    ${message.is_starred ? `<span class="message-starred" title="Starred" aria-label="Starred"><svg class="message-star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></span>` : ''}
                    ${message.edited_at ? `<span class="message-edited" title="Edited ${escapeHtml(new Date(message.edited_at).toLocaleString())}">edited</span>` : ''}
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
}

/**
 * Does this message @mention the current user? (mentions come from the server)
 */
function isMessageMentioningMe(message) {
    const currentUser = getCurrentUser();
    return !!(message && currentUser && Array.isArray(message.mentions)
        && message.mentions.some(m => Number(m.user_id) === Number(currentUser.userId)));
}

/**
 * Server-fetched link preview card under a text message. Every field is escaped; the link and the
 * image must be http(s). The sender gets a button to remove it.
 */
function renderLinkPreview(message) {
    const preview = message.link_preview;
    if (!preview) return '';

    const href = safeHttpUrl(preview.url);
    if (!href || (!preview.title && !preview.description)) return '';
    const image = preview.image_url ? safeHttpUrl(preview.image_url) : null;
    const isSent = message.sender_id === getCurrentUser().userId;

    return `
        <div class="link-preview">
            <a class="link-preview-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow ugc">
                ${image ? `<img class="link-preview-image" src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
                <span class="link-preview-body">
                    ${preview.site_name ? `<span class="link-preview-site">${escapeHtml(preview.site_name)}</span>` : ''}
                    ${preview.title ? `<span class="link-preview-title">${escapeHtml(preview.title)}</span>` : ''}
                    ${preview.description ? `<span class="link-preview-description">${escapeHtml(preview.description)}</span>` : ''}
                </span>
            </a>
            ${isSent ? `<button type="button" class="link-preview-dismiss" data-dismiss-preview="${parseInt(message.id)}" title="Remove preview" aria-label="Remove preview">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>` : ''}
        </div>
    `;
}

/**
 * A preview arrived for a message, or was removed (message_link_preview)
 */
function applyLinkPreview(data) {
    if (!data || data.chatId !== currentChatId) return;
    const message = currentMessages.find(m => m.id === data.messageId);
    if (!message) return;

    const wasNearBottom = isNearBottom();
    message.link_preview = data.preview || null;
    rerenderMessage(message);
    if (wasNearBottom) scrollToBottom();
}

/**
 * Sender removes the preview card from their message
 */
async function dismissLinkPreview(messageId) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LINK_PREVIEW(messageId), { method: 'DELETE' });
        if (response.success) {
            applyLinkPreview(response.data);
        } else {
            showNotification(response.message || 'Failed to remove the preview', 'error');
        }
    } catch (error) {
        console.error('Dismiss link preview error:', error);
        showNotification('Failed to remove the preview', 'error');
    }
}

/**
 * Copy a code block's text (the button sits in the block's header)
 */
async function copyCodeBlock(button) {
    const code = button.closest('.code-block').querySelector('code').textContent;
    try {
        await navigator.clipboard.writeText(code);
    } catch (e) {
        // Older browsers / insecure origins: copy through a temporary textarea
        const area = document.createElement('textarea');
        area.value = code;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (!ok) {
            showNotification('Could not copy the code', 'error');
            return;
        }
    }
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('copied');
    }, 1500);
}

/**
 * Clicks inside message bodies: code copy buttons and preview dismiss buttons
 * (delegated, so nothing user-written ever ends up in an inline handler)
 */
function initializeMessageContentActions() {
    document.getElementById('messagesContainer').addEventListener('click', (e) => {
        const copyButton = e.target.closest('[data-copy-code]');
        if (copyButton) {
            e.stopPropagation();
            copyCodeBlock(copyButton);
            return;
        }

        const dismissButton = e.target.closest('[data-dismiss-preview]');
        if (dismissButton) {
            e.preventDefault();
            e.stopPropagation();
            dismissLinkPreview(parseInt(dismissButton.dataset.dismissPreview));
            return;
        }

        // Photos and videos open full screen with the chat's other media (media.js)
        const media = e.target.closest('[data-lightbox]');
        if (media) {
            e.preventDefault();
            e.stopPropagation();
            openLightbox(currentChatId, parseInt(media.dataset.lightbox));
        }
    });

    // Keyboard users open a photo with Enter or Space
    document.getElementById('messagesContainer').addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('img[data-lightbox]')) {
            e.preventDefault();
            openLightbox(currentChatId, parseInt(e.target.dataset.lightbox));
        }
    });
}

/**
 * One-line description of a message for quotes, the reply bar and the starred list
 * (media shows an icon and label instead of content)
 */
function getMessagePreviewText(messageType, text, fileName) {
    switch (messageType) {
        case 'image':
            return '📷 Photo';
        case 'video':
            return '🎥 Video';
        case 'file':
            return `📎 ${fileName || 'File'}`;
        case 'poll':
            return `📊 ${text || 'Poll'}`;
        default:
            return text || '';
    }
}

/**
 * Compact quote above a reply's content; clicking it jumps to the original
 */
function renderReplyQuote(replyTo) {
    if (!replyTo) return '';

    if (replyTo.deleted) {
        return '<div class="message-quote deleted">Original message deleted</div>';
    }

    return `
        <button type="button" class="message-quote" data-reply-id="${parseInt(replyTo.id)}" aria-label="Go to the original message">
            <span class="message-quote-sender">${escapeHtml(replyTo.sender_name || 'Unknown')}</span>
            <span class="message-quote-text">${escapeHtml(getMessagePreviewText(replyTo.message_type, replyTo.snippet, replyTo.file_name))}</span>
        </button>
    `;
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
    console.log('Rendering message:', message.id, 'type:', message.message_type, 'upload_path:', message.upload_path);
    switch (message.message_type) {
        case 'text':
            // Whitelist formatter (formatter.js): the text is escaped, only fixed tags are added
            return `<div class="message-text">${formatMessageText(message.content, {
                mentions: message.mentions,
                currentUserId: getCurrentUser().userId
            })}</div>${renderLinkPreview(message)}`;
        
        case 'image':
            const imageUrl = getFileUrl(message.upload_path);
            console.log('Image URL:', imageUrl);
            // Clicking opens the lightbox (media.js) on this message
            return `
                <div class="message-media">
                    <img src="${escapeHtml(imageUrl)}"
                         alt="${escapeHtml(message.file_name)}"
                         loading="lazy"
                         role="button"
                         tabindex="0"
                         aria-label="Open ${escapeHtml(message.file_name || 'photo')} full screen"
                         data-lightbox="${parseInt(message.id)}">
                </div>
            `;

        case 'video':
            const videoUrl = getFileUrl(message.upload_path);
            return `
                <div class="message-media">
                    <video controls preload="metadata">
                        <source src="${escapeHtml(videoUrl)}" type="${escapeHtml(message.mime_type || 'video/mp4')}">
                        Your browser does not support video playback.
                    </video>
                    <button type="button" class="message-media-expand" data-lightbox="${parseInt(message.id)}" title="Full screen" aria-label="Open video full screen">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
                    </button>
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
        
        case 'poll':
            // Card with options, counts and voters (polls.js); every text in it is escaped
            return typeof renderPollHtml === 'function'
                ? renderPollHtml(message)
                : `<div class="message-text">📊 ${escapeHtml(message.content || 'Poll')}</div>`;

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
                  data-emoji="${escapeHtml(emoji)}"
                  onclick="toggleReaction(${messageId}, this.dataset.emoji)"
                  title="${escapeHtml(users.map(u => u.username).join(', '))}">
                ${escapeHtml(emoji)} ${users.length}
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
async function sendTextMessage(chatId, content, replyToMessageId = null) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.SEND_MESSAGE, {
            method: 'POST',
            body: JSON.stringify({
                chatId: chatId,
                messageType: 'text',
                content: content,
                replyToMessageId: replyToMessageId
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
 * Toggle reaction on message. The server applies the rule (one reaction per user:
 * a different emoji replaces it, the same emoji removes it) and broadcasts the result.
 */
async function toggleReaction(messageId, emoji) {
    if (!currentMessages.some(m => m.id === messageId)) return;
    addReactionViaSocket(messageId, emoji);
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
 * Add an arriving message to the open thread.
 * Returns true when the user has seen it (own message, or looking at the bottom of a visible tab).
 */
function addMessageToUI(message) {
    if (currentMessages.some(m => m.id === message.id)) return true;

    const container = document.getElementById('messagesContainer');
    const currentUser = getCurrentUser();
    const isOwn = message.sender_id === currentUser.userId;

    // Viewing older history: the gap to the newest message isn't loaded, so don't append past it
    if (hasNewerMessages) {
        if (isOwn) {
            // Sending takes the user back to the latest messages
            returnToLatestMessages();
            return true;
        }
        newWhileScrolledUp++;
        updateJumpButton();
        return false;
    }
    const wasNearBottom = isNearBottom();
    const seen = isOwn || (wasNearBottom && !document.hidden);

    // Mark where unseen messages start, if the line isn't already on screen
    if (!seen && !unreadDividerId) {
        unreadDividerId = message.id;
    }

    currentMessages.push(message);

    if (container.querySelector('.empty-state')) {
        renderMessages(currentMessages);
    } else {
        container.insertAdjacentHTML('beforeend', renderMessagesHtml([message]));
    }

    if (isOwn || wasNearBottom) {
        scrollToBottom();
    }

    if (seen) {
        if (isOwn) {
            // The server already moved our read position to our own message
            lastMarkedReadId = Math.max(lastMarkedReadId, message.id);
        } else {
            markChatAsRead(currentChatId);
        }
    } else {
        newWhileScrolledUp++;
    }

    updateJumpButton();
    return seen;
}

/**
 * Replace one message's element after its data changed (reactions)
 */
function rerenderMessage(message) {
    const element = document.querySelector(`#messagesContainer [data-message-id="${message.id}"]`);
    if (element) {
        element.outerHTML = renderMessageHtml(message);
    }
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

    let typingTimeout;

    // The composer grows with its text (Shift+Enter adds lines)
    messageInput.addEventListener('input', autoResizeComposer);

    // Ctrl/Cmd+B and Ctrl/Cmd+I wrap the selection in ** or _
    messageInput.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        const key = e.key.toLowerCase();
        if (key === 'b' || key === 'i') {
            e.preventDefault();
            wrapComposerSelection(key === 'b' ? '**' : '_');
        }
    });

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
    
    // Enter sends and Shift+Enter adds a line, or the other way round (Settings > Chat; composer.js).
    // Ctrl/Cmd+Enter always sends. The @mention list handles Enter first and prevents the default.
    messageInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.altKey) return;
        if (isSendShortcut(e)) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Send button
    sendBtn.addEventListener('click', sendMessage);

    // Attach button, drag-and-drop, paste and the upload tray live in composer.js
}

/**
 * Fit the composer textarea to its content (up to the CSS max-height)
 */
function autoResizeComposer() {
    const input = document.getElementById('messageInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}

/**
 * Wrap the selected text in a formatting marker, or insert a pair and put the caret inside
 */
function wrapComposerSelection(marker) {
    const input = document.getElementById('messageInput');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end);

    input.setRangeText(`${marker}${selected}${marker}`, start, end, 'select');
    if (selected) {
        input.setSelectionRange(start + marker.length, end + marker.length);
    } else {
        input.setSelectionRange(start + marker.length, start + marker.length);
    }
    input.focus();
    autoResizeComposer();
}

/**
 * Send message
 */
async function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const content = messageInput.value.trim();
    // Files waiting in the upload tray (composer.js) go out with the text
    const hasTrayFiles = !isEditingMessage() && hasPendingUploads();

    if ((!content && !hasTrayFiles) || !currentChatId) {
        return;
    }

    // Announcement-only group and not an admin (groups.js); the server refuses it too
    if (typeof canPostInCurrentChat === 'function' && !canPostInCurrentChat()) {
        showNotification('Only admins can send messages in this group', 'error');
        return;
    }

    // The composer is editing an existing message (messageActions.js)
    if (isEditingMessage()) {
        await submitMessageEdit(content);
        return;
    }

    const replyToMessageId = getReplyTargetId();

    // Clear input, the saved draft and the reply bar
    messageInput.value = '';
    autoResizeComposer();
    clearComposerContext();
    clearDraft(currentChatId);

    // Files first (the reply goes on the first one), then the text
    if (hasTrayFiles) {
        sendPendingUploads(currentChatId, replyToMessageId, content);
        return;
    }

    await sendTextContent(currentChatId, content, replyToMessageId);
}

/**
 * Send composer text via WebSocket (faster) or the API
 */
async function sendTextContent(chatId, content, replyToMessageId = null) {
    if (window.socket && window.socket.connected) {
        sendMessageViaSocket(chatId, 'text', content, null, replyToMessageId);
    } else {
        const result = await sendTextMessage(chatId, content, replyToMessageId);
        if (result && result.success === false) {
            showNotification(result.message || 'Failed to send message', 'error');
        }
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

// Register read receipt handler
if (typeof onMessagesRead === 'function') {
    onMessagesRead(handleMessagesRead);
}

/**
 * Handle reaction update from WebSocket (add and replace arrive as 'add', toggle-off as 'remove')
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
    
    // A user has at most one reaction per message: drop theirs, then add the new one
    reactions = reactions.filter(r => r.userId !== userId);
    if (action === 'add') {
        reactions.push({
            userId: userId,
            username: username,
            emoji: emoji
        });
    }
    
    // Update message reactions
    message.reactions = reactions;
    
    // Re-render just this message
    rerenderMessage(message);
}

// Make functions globally accessible
if (typeof window !== 'undefined') {
    window.toggleReaction = toggleReaction;
    window.handleReactionUpdate = handleReactionUpdate;
}
