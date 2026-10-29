/**
 * Search Module
 * Message search in the open chat or across every chat, with sender, type and date filters.
 * Results show a snippet with the matches highlighted (built from text nodes and <mark>,
 * never innerHTML) and open the chat at the message.
 */

let searchState = {
    scope: 'all',   // 'chat' | 'all'
    chatId: null,   // chat searched when scope is 'chat'
    cursor: null,
    token: 0,       // drops responses for an older query
    loading: false
};
let searchDebounceTimer = null;

const SEARCH_DEBOUNCE_MS = 300;

function searchElements() {
    return {
        modal: document.getElementById('searchModal'),
        input: document.getElementById('messageSearchInput'),
        scopeChat: document.getElementById('searchScopeChat'),
        scopeAll: document.getElementById('searchScopeAll'),
        scopeChatLabel: document.getElementById('searchScopeChatLabel'),
        sender: document.getElementById('searchSender'),
        has: document.getElementById('searchHas'),
        from: document.getElementById('searchFrom'),
        to: document.getElementById('searchTo'),
        results: document.getElementById('searchResults'),
        status: document.getElementById('searchStatus'),
        loadMore: document.getElementById('searchLoadMore')
    };
}

/**
 * scope 'chat' searches the open chat; 'all' every chat the user is in
 */
function openSearchPanel(scope) {
    const el = searchElements();
    const chatScope = scope === 'chat' && !!currentChatId;

    searchState.chatId = currentChatId;
    el.scopeChat.disabled = !currentChatId;
    el.scopeChatLabel.textContent = currentChatId
        ? `In ${document.getElementById('chatName').textContent || 'this chat'}`
        : 'In this chat';
    el.scopeChat.checked = chatScope;
    el.scopeAll.checked = !chatScope;
    searchState.scope = chatScope ? 'chat' : 'all';

    fillSenderOptions();
    el.modal.style.display = 'flex';
    el.input.focus();
    el.input.select();
    runSearch(true);
}

function closeSearchPanel() {
    searchState.token++;
    clearTimeout(searchDebounceTimer);
    document.getElementById('searchModal').style.display = 'none';
}

/**
 * "Sender" choices: the open chat's members, or everyone from the user's chats
 */
function fillSenderOptions() {
    const { sender } = searchElements();
    const previous = sender.value;
    const me = getCurrentUser();
    const people = new Map();

    if (searchState.scope === 'chat' && typeof currentChatDetails !== 'undefined' && currentChatDetails
        && currentChatDetails.id === searchState.chatId) {
        for (const p of currentChatDetails.participants || []) {
            people.set(Number(p.id), p.full_name || p.username);
        }
    } else {
        const chats = searchState.scope === 'chat' ? allChats.filter(c => c.id === searchState.chatId) : allChats;
        for (const chat of chats) {
            let participants = [];
            try {
                participants = typeof chat.participants === 'string' ? JSON.parse(chat.participants) : (chat.participants || []);
            } catch (e) {
                participants = [];
            }
            for (const p of participants) {
                people.set(Number(p.userId), p.fullName || p.username);
            }
        }
    }

    const options = [h('option', { text: 'Anyone', attrs: { value: '' } })];
    if (me) options.push(h('option', { text: 'You', attrs: { value: me.userId } }));
    [...people.entries()]
        .filter(([id]) => !me || id !== Number(me.userId))
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
        .forEach(([id, name]) => options.push(h('option', { text: name || 'Unknown', attrs: { value: id } })));

    sender.replaceChildren(...options);
    sender.value = [...sender.options].some(o => o.value === previous) ? previous : '';
}

/**
 * Local calendar date (yyyy-mm-dd) to an ISO instant at the start of that day, plus `days`
 */
function localDayToIso(value, days = 0) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d + days).toISOString();
}

function buildSearchQuery() {
    const el = searchElements();
    const params = new URLSearchParams();
    const q = el.input.value.trim();
    if (q) params.set('q', q);
    if (searchState.scope === 'chat' && searchState.chatId) params.set('chatId', searchState.chatId);
    if (el.sender.value) params.set('senderId', el.sender.value);
    if (el.has.value) params.set('has', el.has.value);
    if (el.from.value) params.set('from', localDayToIso(el.from.value));
    // The "to" day is included: search up to the start of the next day
    if (el.to.value) params.set('to', localDayToIso(el.to.value, 1));
    params.set('limit', CONFIG.SEARCH_PAGE_SIZE);
    return params;
}

function hasSearchCriteria(params) {
    return ['q', 'senderId', 'has', 'from', 'to'].some(key => params.has(key));
}

function scheduleSearch() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runSearch(true), SEARCH_DEBOUNCE_MS);
}

/**
 * reset: a new query (first page); otherwise the next page of the current one
 */
async function runSearch(reset) {
    const el = searchElements();
    const params = buildSearchQuery();

    if (reset) {
        searchState.cursor = null;
        el.loadMore.hidden = true;
        el.results.replaceChildren();
    } else if (searchState.cursor) {
        params.set('before', searchState.cursor);
    }

    if (!hasSearchCriteria(params)) {
        searchState.token++;
        el.status.textContent = searchState.scope === 'chat'
            ? 'Type a word to search this chat, or pick a filter.'
            : 'Type a word to search all your chats, or pick a filter.';
        return;
    }
    if (el.from.value && el.to.value && el.to.value < el.from.value) {
        el.status.textContent = 'The end date is before the start date.';
        return;
    }

    const token = ++searchState.token;
    searchState.loading = true;
    el.status.textContent = 'Searching…';
    el.loadMore.disabled = true;

    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.SEARCH_MESSAGES}?${params.toString()}`);
        if (token !== searchState.token) return;

        if (!response.success) {
            el.status.textContent = (response.errors && response.errors[0] && response.errors[0].msg) || response.message || 'Search failed';
            return;
        }

        response.data.forEach(result => el.results.appendChild(renderSearchResult(result)));
        searchState.cursor = response.pagination.nextCursor;
        el.loadMore.hidden = !response.pagination.hasMore;

        const count = el.results.childElementCount;
        el.status.textContent = count === 0
            ? 'No messages found.'
            : `${count}${response.pagination.hasMore ? '+' : ''} message${count === 1 ? '' : 's'} found`;
    } catch (error) {
        console.error('Search error:', error);
        if (token === searchState.token) el.status.textContent = 'Search failed. Check your connection.';
    } finally {
        if (token === searchState.token) {
            searchState.loading = false;
            el.loadMore.disabled = false;
        }
    }
}

/**
 * Snippet text with [start, end) ranges wrapped in <mark>
 */
function highlightedSnippet(snippet) {
    const span = h('span', { className: 'search-result-snippet' });
    let position = 0;
    for (const [start, end] of snippet.highlights || []) {
        if (start < position || end <= start) continue;
        span.appendChild(document.createTextNode(snippet.text.slice(position, start)));
        span.appendChild(h('mark', { text: snippet.text.slice(start, end) }));
        position = end;
    }
    span.appendChild(document.createTextNode(snippet.text.slice(position)));
    return span;
}

function renderSearchResult(result) {
    const me = getCurrentUser();
    const sender = me && Number(result.sender_id) === Number(me.userId) ? 'You' : result.sender_name;
    const date = new Date(result.created_at);

    const body = result.snippet
        ? highlightedSnippet(result.snippet)
        : h('span', { className: 'search-result-snippet', text: getMessagePreviewText(result.message_type, '', result.file_name) });

    return h('button', {
        className: 'search-result',
        attrs: { type: 'button' },
        on: { click: () => {
            closeSearchPanel();
            jumpToMessage(result.chat_id, result.id);
        } }
    },
        h('span', { className: 'search-result-header' },
            searchState.scope === 'all' ? h('span', { className: 'search-result-chat', text: result.chat_display_name }) : null,
            h('span', { className: 'search-result-time', text: date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) })
        ),
        h('span', { className: 'search-result-text' },
            h('strong', { text: `${sender}: ` }),
            body
        )
    );
}

function initializeSearch() {
    const el = searchElements();

    document.getElementById('messageSearchBtn').addEventListener('click', () => openSearchPanel('all'));
    document.getElementById('chatSearchBtn').addEventListener('click', () => openSearchPanel('chat'));
    document.getElementById('closeSearchModal').addEventListener('click', closeSearchPanel);
    el.modal.addEventListener('click', (e) => {
        if (e.target === el.modal) closeSearchPanel();
    });

    el.input.addEventListener('input', scheduleSearch);
    el.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(searchDebounceTimer);
            runSearch(true);
        }
    });

    [el.scopeChat, el.scopeAll].forEach(radio => radio.addEventListener('change', () => {
        searchState.scope = el.scopeChat.checked ? 'chat' : 'all';
        fillSenderOptions();
        runSearch(true);
    }));
    [el.sender, el.has, el.from, el.to].forEach(control => control.addEventListener('change', () => runSearch(true)));

    document.getElementById('searchClearFilters').addEventListener('click', () => {
        el.sender.value = '';
        el.has.value = '';
        el.from.value = '';
        el.to.value = '';
        runSearch(true);
        el.input.focus();
    });

    el.loadMore.addEventListener('click', () => {
        if (!searchState.loading) runSearch(false);
    });

    // Escape closes the panel; Ctrl/Cmd+Shift+F opens it for the open chat
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && el.modal.style.display === 'flex' && !lightbox) {
            closeSearchPanel();
        } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openSearchPanel(currentChatId ? 'chat' : 'all');
        }
    });
}
