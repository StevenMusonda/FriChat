/**
 * Disappearing Messages Module
 * Per-chat timer (off, 24 hours, 7 days, 90 days) for new messages: the dialog, the clock in the chat
 * header and the chat list, the system notices that announce a change, and removing expired messages
 * from the open thread (the server deletes them and sends messages_expired; a local sweep also hides
 * any whose time is up before that arrives).
 * Text from users (names) is escaped; system notices are built from a fixed code, never stored text.
 */

(function (FriChat) {

const DISAPPEARING_CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"></circle><polyline points="12 9 12 13 14.5 15"></polyline><line x1="9" y1="2" x2="15" y2="2"></line></svg>';
const DISAPPEARING_SWEEP_MS = 10 * 1000;

// Open chat: { chatId, seconds, canChange } from GET /chats/:id
let currentDisappearing = { chatId: null, seconds: 0, canChange: false };
let disappearingSweepTimer = null;
let chatListRefreshTimer = null;

// ===== Text =====

function disappearingLabel(seconds) {
    const option = CONFIG.DISAPPEARING_OPTIONS.find(o => o.seconds === Number(seconds));
    if (option) return option.label;
    const days = Math.round(Number(seconds) / 86400);
    return days >= 1 ? `${days} days` : 'Off';
}

/**
 * Plain text of a system notice ("disappearing:604800" from the server). Callers escape it.
 */
function describeSystemMessage(message) {
    const match = /^disappearing:(\d+)$/.exec(String(message && message.content || ''));
    if (!match) return 'Chat settings were changed';

    const isMe = message.sender_id === getCurrentUser().userId;
    const actor = isMe ? 'You' : (message.full_name || message.username || 'Someone');
    const seconds = Number(match[1]);
    return seconds > 0
        ? `${actor} turned on disappearing messages. New messages will disappear ${disappearingLabel(seconds)} after they're sent.`
        : `${actor} turned off disappearing messages.`;
}

/**
 * Centred notice in the thread (no actions: it can't be replied to, forwarded or reacted to)
 */
function renderSystemMessageHtml(message) {
    return `
        <div class="system-message" data-system-message-id="${parseInt(message.id)}" role="note">
            <span class="system-message-text">${DISAPPEARING_CLOCK_SVG}<span>${escapeHtml(describeSystemMessage(message))}</span></span>
            <span class="system-message-time">${formatTime(message.created_at)}</span>
        </div>
    `;
}

/**
 * Small clock in a message's footer, with when it will disappear
 */
function renderExpiryBadgeHtml(message) {
    if (!message || !message.expires_at) return '';
    const when = new Date(message.expires_at);
    if (isNaN(when)) return '';
    const label = `Disappears ${when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    return `<span class="message-expiry" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${DISAPPEARING_CLOCK_SVG}</span>`;
}

/**
 * Clock next to a chat's name in the sidebar when its timer is on
 */
function renderChatListDisappearingIcon(chat) {
    const seconds = Number(chat && chat.disappearing_seconds) || 0;
    if (seconds <= 0) return '';
    const label = `Disappearing messages: ${disappearingLabel(seconds)}`;
    return `<span class="chat-item-disappearing" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${DISAPPEARING_CLOCK_SVG}</span>`;
}

// ===== Open chat state =====

/**
 * Called with GET /chats/:id for the chat being opened
 */
function applyDisappearingDetails(chat) {
    currentDisappearing = {
        chatId: chat.id,
        seconds: Number(chat.disappearing_seconds) || 0,
        canChange: !!chat.can_change_disappearing
    };
    const listed = allChats.find(c => c.id === chat.id);
    if (listed) listed.disappearing_seconds = currentDisappearing.seconds;
    updateDisappearingHeader();
}

function resetDisappearingState() {
    currentDisappearing = { chatId: null, seconds: 0, canChange: false };
    updateDisappearingHeader();
}

function updateDisappearingHeader() {
    const icon = document.getElementById('chatDisappearingIcon');
    if (!icon) return;
    const on = currentDisappearing.chatId === currentChatId && currentDisappearing.seconds > 0;
    icon.hidden = !on;
    if (on) {
        const label = `Disappearing messages: ${disappearingLabel(currentDisappearing.seconds)}`;
        icon.title = label;
        icon.setAttribute('aria-label', label);
    }
}

/**
 * Status line for the chat options menu
 */
function disappearingMenuLabel() {
    const seconds = currentDisappearing.chatId === currentChatId ? currentDisappearing.seconds : 0;
    return seconds > 0 ? `Disappearing messages: ${disappearingLabel(seconds)}` : 'Disappearing messages: Off';
}

// ===== Dialog =====

function openDisappearingModal() {
    if (!currentChatId) return;
    const modal = document.getElementById('disappearingModal');
    const options = document.getElementById('disappearingOptions');
    const note = document.getElementById('disappearingPermissionNote');
    const save = document.getElementById('disappearingSaveBtn');
    const chat = allChats.find(c => c.id === currentChatId);
    const current = currentDisappearing.chatId === currentChatId ? currentDisappearing.seconds : 0;
    const canChange = currentDisappearing.chatId === currentChatId && currentDisappearing.canChange;

    options.replaceChildren(...CONFIG.DISAPPEARING_OPTIONS.map(option => {
        const input = FriChat.h('input', {
            attrs: {
                type: 'radio',
                name: 'disappearingTimer',
                value: String(option.seconds),
                checked: option.seconds === current,
                disabled: !canChange
            }
        });
        return FriChat.h('label', { className: 'disappearing-option' }, input, FriChat.h('span', { text: option.label }));
    }));

    note.hidden = canChange;
    note.textContent = canChange ? '' : (chat && chat.chat_type === 'group'
        ? 'Only group admins can change this.'
        : 'You can\'t change this while you can\'t message this person.');
    save.disabled = !canChange;
    save.hidden = !canChange;

    modal.style.display = 'flex';
    const checked = options.querySelector('input:checked') || options.querySelector('input');
    if (checked) checked.focus();
}

function closeDisappearingModal() {
    document.getElementById('disappearingModal').style.display = 'none';
}

async function saveDisappearingTimer() {
    const chatId = currentChatId;
    const selected = document.querySelector('#disappearingOptions input:checked');
    if (!chatId || !selected) return;
    const seconds = Number(selected.value);
    const save = document.getElementById('disappearingSaveBtn');
    save.disabled = true;

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.DISAPPEARING(chatId), {
            method: 'PUT',
            body: JSON.stringify({ seconds })
        });
        if (response.success) {
            // chat_disappearing_updated and the notice arrive over the socket; apply now in case it's slow
            applyDisappearingUpdate({ chatId, seconds: response.data.seconds });
            closeDisappearingModal();
        } else {
            showNotification(response.message || 'Could not change disappearing messages', 'error');
        }
    } catch (error) {
        console.error('Disappearing timer error:', error);
        showNotification('Could not change disappearing messages', 'error');
    } finally {
        save.disabled = false;
    }
}

// ===== Live updates =====

/**
 * The timer changed (this user or another member): chat list clock, header clock
 */
function applyDisappearingUpdate(data) {
    if (!data) return;
    const chat = allChats.find(c => c.id === data.chatId);
    if (chat) chat.disappearing_seconds = Number(data.seconds) || 0;
    if (data.chatId === currentDisappearing.chatId) {
        currentDisappearing.seconds = Number(data.seconds) || 0;
        updateDisappearingHeader();
    }
    refreshChatList();
}

/**
 * Take messages out of the open thread: the element, quotes of them, a reply/edit in progress,
 * the selection, a voice note that's playing, and the pinned bar
 */
function removeMessagesFromThread(messageIds) {
    const ids = new Set(messageIds.map(Number));
    if (ids.size === 0) return;
    const present = currentMessages.filter(m => ids.has(m.id));
    if (present.length === 0) return;

    for (const id of ids) {
        const element = document.querySelector(`#messagesContainer [data-message-id="${id}"], #messagesContainer [data-system-message-id="${id}"]`);
        if (element) {
            const divider = element.previousElementSibling;
            element.remove();
            // The "New messages" line belonged to this message
            if (divider && divider.id === 'unreadDivider') divider.remove();
        }
        if (typeof FriChat.voicePlayer !== 'undefined' && FriChat.voicePlayer.messageId === id) FriChat.stopVoicePlayback();
        if (typeof selectedMessageIds !== 'undefined' && selectedMessageIds.has(id)) {
            selectedMessageIds.delete(id);
            if (typeof updateSelectionBar === 'function') updateSelectionBar();
        }
        if (typeof composerContext !== 'undefined' && composerContext && composerContext.messageId === id) {
            cancelComposerContext();
            showNotification('The message you were replying to has disappeared', 'info');
        }
    }

    currentMessages = currentMessages.filter(m => !ids.has(m.id));

    // Replies keep their quote block, as "Original message deleted"
    currentMessages.forEach(m => {
        if (m.reply_to && ids.has(m.reply_to.id) && !m.reply_to.deleted) {
            m.reply_to = { id: m.reply_to.id, deleted: true };
            rerenderMessage(m);
        }
    });

    if (currentMessages.length === 0 && !hasOlderMessages) renderMessages([]);
    if (typeof loadPinnedMessages === 'function' && document.querySelector('#pinnedMessagesContainer [data-pinned-message-id]')) {
        loadPinnedMessages(currentChatId);
    }
}

/**
 * The server deleted expired messages (messages_expired)
 */
function applyMessagesExpired(data) {
    if (!data || !Array.isArray(data.messageIds)) return;
    if (data.chatId === currentChatId) removeMessagesFromThread(data.messageIds);

    // Last message and unread count in the sidebar come from the server (debounced: a sweep can be several events)
    if (allChats.some(c => c.id === data.chatId)) {
        clearTimeout(chatListRefreshTimer);
        chatListRefreshTimer = setTimeout(() => loadChats(), 1500);
    }
}

/**
 * Hide messages whose time is up, even before the server's sweep reaches them
 */
function sweepExpiredMessages(now = Date.now()) {
    if (!currentChatId || typeof currentMessages === 'undefined') return;
    const expired = currentMessages
        .filter(m => m.expires_at && Date.parse(m.expires_at) <= now)
        .map(m => m.id);
    if (expired.length > 0) removeMessagesFromThread(expired);
}

function initializeDisappearing() {
    document.getElementById('closeDisappearingModal').addEventListener('click', closeDisappearingModal);
    document.getElementById('disappearingCancelBtn').addEventListener('click', closeDisappearingModal);
    document.getElementById('disappearingSaveBtn').addEventListener('click', saveDisappearingTimer);
    const modal = document.getElementById('disappearingModal');
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDisappearingModal();
    });
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDisappearingModal();
    });

    const headerIcon = document.getElementById('chatDisappearingIcon');
    if (headerIcon) headerIcon.addEventListener('click', openDisappearingModal);

    onLifecycleEvent((event, data) => {
        if (event === 'chat_disappearing_updated') applyDisappearingUpdate(data);
        else if (event === 'messages_expired') applyMessagesExpired(data);
    });

    clearInterval(disappearingSweepTimer);
    disappearingSweepTimer = setInterval(() => sweepExpiredMessages(), DISAPPEARING_SWEEP_MS);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    renderChatListDisappearingIcon,
    describeSystemMessage,
    disappearingMenuLabel,
    openDisappearingModal,
    resetDisappearingState,
    applyDisappearingDetails,
    renderExpiryBadgeHtml,
    renderSystemMessageHtml,
    initializeDisappearing
});
})(globalThis.FriChat = globalThis.FriChat || {});
