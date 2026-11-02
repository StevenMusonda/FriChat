/**
 * Optional AI features: the catch-up bar with "Summarize unread", Translate on a message, the one-time
 * consent dialog, and the settings. With no API key on the server, GET /api/ai/status says so and
 * nothing here shows.
 *
 * Summaries and translations are model output built from other people's text, so they are only ever
 * written with textContent or escapeHtml, and links in them aren't made clickable.
 */

(function (FriChat) {

// GET /api/ai/status; { available: false } until it answers
let aiStatus = { available: false };
let statusReady = Promise.resolve();

// message id -> { pending } or { text, languageName, source }: shown until the text changes or the page reloads
const translations = new Map();

// Chat the catch-up bar belongs to
let catchUpChatId = null;

let resolveConsent = null;

async function refreshStatus() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.AI_STATUS);
        if (response.success) applyStatus(response.data);
    } catch (error) {
        console.error('AI status error:', error);
    }
}

function applyStatus(status) {
    aiStatus = status || { available: false };
    document.querySelectorAll('.ai-only').forEach((element) => {
        element.hidden = !aiStatus.available;
    });
    renderLanguageOptions(document.getElementById('aiLanguageSelect'), aiStatus.language);
    if (!isAiOffered()) hideCatchUp();
}

/**
 * The server has a key, and this user hasn't turned the feature off
 */
function isAiOffered() {
    return !!aiStatus.available && !!aiStatus.enabled;
}

function isAiOnInChat(chatId) {
    return isAiOffered() && !(aiStatus.disabledChats || []).includes(Number(chatId));
}

function renderLanguageOptions(select, selected) {
    if (!select || !aiStatus.languages) return;
    select.replaceChildren(...aiStatus.languages.map((language) => {
        const option = document.createElement('option');
        option.value = language.code;
        option.textContent = language.name;
        return option;
    }));
    if (selected) select.value = selected;
}

/**
 * The Privacy switch changed, here or in another tab
 */
function applyAiFeaturesSetting(enabled) {
    if (enabled === undefined || !aiStatus.available) return;
    applyStatus({ ...aiStatus, enabled: !!enabled });
}

async function setChatAiEnabled(chatId, enabled) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.AI_CHAT(chatId), {
            method: 'PUT',
            body: JSON.stringify({ enabled })
        });
        if (response.success) {
            applyStatus(response.data);
            if (!enabled && chatId === catchUpChatId) hideCatchUp();
            showNotification(enabled ? 'AI features are on for this chat' : 'AI features are off for this chat', 'info');
        } else {
            showNotification(response.message || 'Failed to save the setting', 'error');
        }
    } catch (error) {
        showNotification('Failed to save the setting', 'error');
    }
}

// ===== Consent =====

/**
 * The dialog appears once, the first time an AI feature is used
 * @returns {Promise<boolean>} true when the user has agreed
 */
function ensureConsent() {
    if (aiStatus.consented) return Promise.resolve(true);

    const select = document.getElementById('aiConsentLanguage');
    // navigator.language picks the likeliest answer; the stored setting is English until changed
    const browserLanguage = String(navigator.language || '').slice(0, 2).toLowerCase();
    const known = (aiStatus.languages || []).some(language => language.code === browserLanguage);
    renderLanguageOptions(select, known ? browserLanguage : aiStatus.language);

    document.getElementById('aiConsentModal').style.display = 'flex';
    return new Promise((resolve) => {
        resolveConsent = resolve;
    });
}

function closeConsent(result) {
    document.getElementById('aiConsentModal').style.display = 'none';
    if (resolveConsent) resolveConsent(result);
    resolveConsent = null;
}

async function acceptConsent() {
    const button = document.getElementById('aiConsentAcceptBtn');
    button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.AI_CONSENT, {
            method: 'POST',
            body: JSON.stringify({ language: document.getElementById('aiConsentLanguage').value })
        });
        if (response.success) {
            applyStatus(response.data);
            closeConsent(true);
        } else {
            showNotification(response.message || 'Failed to save your choice', 'error');
        }
    } catch (error) {
        showNotification('Failed to save your choice', 'error');
    } finally {
        button.disabled = false;
    }
}

// ===== Catch-up bar =====

function hideCatchUp() {
    const bar = document.getElementById('aiCatchUpBar');
    if (bar) {
        bar.hidden = true;
        bar.replaceChildren();
    }
    catchUpChatId = null;
}

function closeButton() {
    return FriChat.h('button', {
        className: 'ai-catchup-close',
        text: '×',
        attrs: { type: 'button', 'aria-label': 'Close' },
        on: { click: hideCatchUp }
    });
}

function renderCatchUpOffer(chatId, unread) {
    const bar = document.getElementById('aiCatchUpBar');
    bar.replaceChildren(
        FriChat.h('span', { className: 'ai-catchup-text', text: `${unread} unread messages` }),
        FriChat.h('button', {
            className: 'btn btn-primary btn-small',
            text: 'Summarize unread',
            attrs: { type: 'button', id: 'aiSummarizeBtn' },
            on: { click: () => summarizeChat(chatId) }
        }),
        closeButton()
    );
    bar.hidden = false;
}

function renderCatchUpMessage(text) {
    const bar = document.getElementById('aiCatchUpBar');
    bar.replaceChildren(FriChat.h('span', { className: 'ai-catchup-text', text }), closeButton());
    bar.hidden = false;
}

function renderSummary(data) {
    const left = data.unreadMessages - data.summarizedMessages;
    const bar = document.getElementById('aiCatchUpBar');
    bar.replaceChildren(
        FriChat.h('div', { className: 'ai-summary' },
            FriChat.h('div', { className: 'ai-summary-title', text: 'Summary (AI-generated, only you can see this)' }),
            FriChat.h('ul', { className: 'ai-summary-list' }, ...data.bullets.map(bullet => FriChat.h('li', { text: bullet }))),
            left > 0
                ? FriChat.h('p', { className: 'ai-summary-note', text: `Based on the ${data.summarizedMessages} newest text messages. ${left} others weren't included (media, deleted, disappearing or too old).` })
                : null),
        closeButton()
    );
    bar.hidden = false;
}

/**
 * Called when a chat opens. unread was read from the chat list before opening cleared it.
 */
async function showCatchUp(chatId, unread) {
    await statusReady;
    // Clicking the open chat again keeps the offer: its unread count is already 0
    if (chatId !== currentChatId || chatId === catchUpChatId) return;
    hideCatchUp();
    if (!isAiOnInChat(chatId) || unread <= aiStatus.summaryMinUnread) return;
    catchUpChatId = chatId;
    renderCatchUpOffer(chatId, unread);
}

async function summarizeChat(chatId) {
    if (!(await ensureConsent())) return;
    if (chatId !== catchUpChatId) return;

    renderCatchUpMessage('Summarizing…');
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.AI_SUMMARY(chatId), { method: 'POST' });
        if (chatId !== catchUpChatId) return;
        if (response.success) {
            renderSummary(response.data);
        } else {
            renderCatchUpMessage(response.message || 'The summary failed. Please try again later.');
        }
    } catch (error) {
        if (chatId === catchUpChatId) renderCatchUpMessage('The summary failed. Please try again later.');
    }
}

// ===== Translation =====

function canTranslateMessage(message) {
    return !!message
        && isAiOnInChat(message.chat_id)
        && message.message_type === 'text'
        && !!message.content
        && !message.file_id
        && !message.expires_at
        && !message.deleted_for_everyone;
}

function refreshTranslationView(messageId) {
    const message = currentMessages.find(m => m.id === messageId);
    if (message) rerenderMessage(message);
}

async function translateMessage(messageId) {
    closeMessageActionMenus();
    const message = currentMessages.find(m => m.id === messageId);
    if (!message || !(await ensureConsent())) return;

    translations.set(messageId, { pending: true, source: message.content });
    refreshTranslationView(messageId);
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.AI_TRANSLATE(messageId), { method: 'POST' });
        if (response.success) {
            translations.set(messageId, { text: response.data.text, languageName: response.data.languageName, source: message.content });
        } else {
            translations.delete(messageId);
            showNotification(response.message || 'Failed to translate this message', 'error');
        }
    } catch (error) {
        translations.delete(messageId);
        showNotification('Failed to translate this message', 'error');
    }
    refreshTranslationView(messageId);
}

/**
 * Under a message's text; an edit drops it, because it translated the old text
 */
function renderTranslationHtml(message) {
    const entry = translations.get(message.id);
    if (!entry || entry.source !== message.content) return '';
    if (entry.pending) return '<div class="message-translation" role="status">Translating…</div>';
    return `
        <div class="message-translation">
            <div class="message-translation-label">
                <span>Translated to ${escapeHtml(entry.languageName)} by AI</span>
                <button type="button" class="poll-link" data-hide-translation="${parseInt(message.id)}">Hide</button>
            </div>
            <div class="message-translation-text" dir="auto">${escapeHtml(entry.text)}</div>
        </div>
    `;
}

async function saveLanguage(select) {
    const status = document.getElementById('aiLanguageStatus');
    status.textContent = 'Saving…';
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.AI_LANGUAGE, {
            method: 'PUT',
            body: JSON.stringify({ language: select.value })
        });
        if (response.success) {
            applyStatus(response.data);
            status.textContent = 'Saved';
        } else {
            status.textContent = response.message || 'Failed to save';
        }
    } catch (error) {
        status.textContent = 'Failed to save';
    }
}

function initializeAi() {
    statusReady = refreshStatus();

    document.getElementById('aiConsentAcceptBtn').addEventListener('click', acceptConsent);
    document.getElementById('aiConsentCancelBtn').addEventListener('click', () => closeConsent(false));
    document.getElementById('aiConsentClose').addEventListener('click', () => closeConsent(false));

    const language = document.getElementById('aiLanguageSelect');
    language.addEventListener('change', () => saveLanguage(language));

    document.getElementById('messagesContainer').addEventListener('click', (e) => {
        const hide = e.target.closest('[data-hide-translation]');
        if (!hide) return;
        e.stopPropagation();
        const messageId = parseInt(hide.dataset.hideTranslation);
        translations.delete(messageId);
        refreshTranslationView(messageId);
    });
}

Object.assign(FriChat, {
    initializeAi,
    isAiOffered,
    isAiOnInChat,
    setChatAiEnabled,
    applyAiFeaturesSetting,
    hideCatchUp,
    showCatchUp,
    canTranslateMessage,
    translateMessage,
    renderTranslationHtml
});

})(globalThis.FriChat = globalThis.FriChat || {});
