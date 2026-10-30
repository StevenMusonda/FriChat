/**
 * Media Module
 * Shared media in chat info (Media, Files and Links tabs, paginated) and the full-screen
 * lightbox for photos and videos (next/previous across the chat, keyboard, download,
 * "Show in chat"). Everything user-written goes in with textContent, never innerHTML.
 */

(function (FriChat) {

// ===== Shared media panel =====

const SHARED_MEDIA_TABS = [
    { id: 'media', label: 'Media', empty: 'No photos or videos yet' },
    { id: 'files', label: 'Files', empty: 'No files yet' },
    { id: 'links', label: 'Links', empty: 'No links yet' }
];

// The panel's state while chat info is open: { chatId, tab, element, tabs: { [id]: { items, cursor, hasMore, loaded, loading } } }
let sharedMedia = null;

const PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="8 5 19 12 8 19 8 5"></polygon></svg>';
const DOWNLOAD_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

/**
 * Chat info was (re)opened: start the tabs over
 */
function resetSharedMediaSection() {
    sharedMedia = null;
}

/**
 * The section for chat info. While the panel stays open the same element is returned,
 * so the group panel can re-render around it without losing the loaded pages.
 */
function renderSharedMediaSection(chatId) {
    if (sharedMedia && sharedMedia.chatId === chatId) return sharedMedia.element;

    const tabs = {};
    SHARED_MEDIA_TABS.forEach(tab => {
        tabs[tab.id] = { items: [], cursor: null, hasMore: false, loaded: false, loading: false };
    });

    const tabButtons = SHARED_MEDIA_TABS.map(tab => FriChat.h('button', {
        className: 'shared-media-tab',
        text: tab.label,
        attrs: { type: 'button', role: 'tab', id: `sharedMediaTab-${tab.id}`, 'aria-controls': 'sharedMediaPanel', 'data-tab': tab.id },
        on: { click: () => selectSharedMediaTab(tab.id) }
    }));

    const element = FriChat.h('section', { className: 'chat-info-section shared-media-section' },
        FriChat.h('h4', { text: 'Shared media' }),
        FriChat.h('div', { className: 'shared-media-tabs', attrs: { role: 'tablist', 'aria-label': 'Shared media' } }, tabButtons),
        FriChat.h('div', { className: 'shared-media-panel', attrs: { id: 'sharedMediaPanel', role: 'tabpanel' } }),
        FriChat.h('button', {
            className: 'btn btn-secondary btn-small shared-media-more',
            text: 'Load more',
            attrs: { type: 'button', hidden: true },
            on: { click: () => loadSharedMediaPage(sharedMedia.tab) }
        })
    );

    sharedMedia = { chatId, tab: 'media', element, tabs };
    selectSharedMediaTab('media');
    return element;
}

function selectSharedMediaTab(tabId) {
    if (!sharedMedia) return;
    sharedMedia.tab = tabId;
    sharedMedia.element.querySelectorAll('.shared-media-tab').forEach(button => {
        const selected = button.dataset.tab === tabId;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    sharedMedia.element.querySelector('.shared-media-panel').setAttribute('aria-labelledby', `sharedMediaTab-${tabId}`);

    if (sharedMedia.tabs[tabId].loaded) {
        renderSharedMediaTab();
    } else {
        loadSharedMediaPage(tabId);
    }
}

async function loadSharedMediaPage(tabId) {
    const state = sharedMedia;
    if (!state) return;
    const tab = state.tabs[tabId];
    if (tab.loading) return;
    tab.loading = true;
    if (state.tab === tabId) renderSharedMediaTab();

    try {
        const query = `?type=${tabId}&limit=${CONFIG.MEDIA_PAGE_SIZE}${tab.cursor ? `&before=${tab.cursor}` : ''}`;
        const response = await apiRequest(CONFIG.ENDPOINTS.SHARED_MEDIA(state.chatId) + query);
        if (sharedMedia !== state) return;

        if (response.success) {
            tab.items = tab.items.concat(response.data);
            tab.cursor = response.pagination.nextCursor;
            tab.hasMore = response.pagination.hasMore;
            tab.loaded = true;
        } else {
            tab.error = response.message || 'Could not load shared media';
        }
    } catch (error) {
        console.error('Shared media error:', error);
        tab.error = 'Could not load shared media';
    } finally {
        tab.loading = false;
        if (sharedMedia === state && state.tab === tabId) renderSharedMediaTab();
    }
}

function renderSharedMediaTab() {
    const { element, tab: tabId, tabs, chatId } = sharedMedia;
    const tab = tabs[tabId];
    const panel = element.querySelector('.shared-media-panel');
    const more = element.querySelector('.shared-media-more');

    let content;
    if (tab.items.length === 0) {
        const text = tab.loading ? 'Loading…' : (tab.error || SHARED_MEDIA_TABS.find(t => t.id === tabId).empty);
        content = [FriChat.h('p', { className: 'shared-media-empty', text })];
    } else if (tabId === 'media') {
        content = [FriChat.h('div', { className: 'shared-media-grid' }, tab.items.map(item => renderMediaTile(chatId, item)))];
    } else if (tabId === 'files') {
        content = [FriChat.h('ul', { className: 'shared-media-list' }, tab.items.map(item => renderFileRow(chatId, item)))];
    } else {
        content = [FriChat.h('ul', { className: 'shared-media-list' }, tab.items.map(item => renderLinkRow(chatId, item)))];
    }

    panel.replaceChildren(...content);
    more.hidden = !tab.hasMore || tab.items.length === 0;
    more.disabled = tab.loading;
    more.textContent = tab.loading ? 'Loading…' : 'Load more';
}

function sharedItemMeta(item) {
    return `${item.sender_name || 'Unknown'} · ${new Date(item.created_at).toLocaleDateString()}`;
}

function renderMediaTile(chatId, item) {
    const url = getFileUrl(item.upload_path);
    const tile = FriChat.h('button', {
        className: 'shared-media-tile',
        attrs: {
            type: 'button',
            title: `${item.file_name || ''} — ${sharedItemMeta(item)}`,
            'aria-label': `Open ${item.message_type === 'video' ? 'video' : 'photo'} ${item.file_name || ''} from ${sharedItemMeta(item)}`
        },
        on: { click: () => openLightbox(chatId, item.message_id) }
    });
    if (item.message_type === 'video') {
        tile.appendChild(FriChat.h('video', { attrs: { src: url, muted: true, preload: 'metadata' } }));
        const play = FriChat.h('span', { className: 'shared-media-play' });
        play.innerHTML = PLAY_ICON_SVG;
        tile.appendChild(play);
    } else {
        tile.appendChild(FriChat.h('img', { attrs: { src: url, alt: '', loading: 'lazy' } }));
    }
    return tile;
}

function renderFileRow(chatId, item) {
    const download = FriChat.h('a', {
        className: 'icon-btn shared-media-download',
        attrs: { href: getFileUrl(item.upload_path), download: item.file_name || '', target: '_blank', rel: 'noopener', title: 'Download', 'aria-label': `Download ${item.file_name || 'file'}` }
    });
    download.innerHTML = DOWNLOAD_ICON_SVG;

    return FriChat.h('li', { className: 'shared-media-row' },
        FriChat.h('button', {
            className: 'shared-media-row-open',
            attrs: { type: 'button', title: 'Show in chat' },
            on: { click: () => showMessageInChat(chatId, item.message_id) }
        },
            FriChat.h('span', { className: 'shared-media-row-title', text: `📎 ${item.file_name || 'File'}` }),
            FriChat.h('span', { className: 'shared-media-row-meta', text: `${formatFileSize(item.file_size)} · ${sharedItemMeta(item)}` })
        ),
        download
    );
}

function renderLinkRow(chatId, item) {
    const links = item.urls.map(url => {
        const href = FriChat.safeHttpUrl(url);
        return href
            ? FriChat.h('a', { className: 'shared-media-link', text: url, attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow ugc' } })
            : null;
    });

    return FriChat.h('li', { className: 'shared-media-row shared-media-link-row' },
        FriChat.h('div', { className: 'shared-media-row-body' },
            ...links,
            FriChat.h('span', { className: 'shared-media-row-meta', text: sharedItemMeta(item) })
        ),
        FriChat.h('button', {
            className: 'btn btn-secondary btn-small shared-media-show',
            text: 'Show in chat',
            attrs: { type: 'button' },
            on: { click: () => showMessageInChat(chatId, item.message_id) }
        })
    );
}

/**
 * Close chat info and the lightbox, then open the chat at the message
 */
function showMessageInChat(chatId, messageId) {
    closeLightbox();
    const modal = document.getElementById('chatInfoModal');
    if (typeof FriChat.groupInfoOpenFor !== 'undefined' && FriChat.groupInfoOpenFor) {
        FriChat.closeGroupInfo();
    } else if (modal) {
        modal.style.display = 'none';
    }
    jumpToMessage(chatId, messageId);
}

// ===== Lightbox =====

// { chatId, items (oldest first), index, hasOlder, hasNewer, loading, element, returnFocus }
let lightbox = null;
const LIGHTBOX_PAGE = 30;

async function fetchLightboxPage(chatId, cursorName, cursor) {
    const response = await apiRequest(
        `${CONFIG.ENDPOINTS.SHARED_MEDIA(chatId)}?type=media&limit=${LIGHTBOX_PAGE}&${cursorName}=${cursor}`
    );
    if (!response.success) throw new Error(response.message || 'Could not load media');
    return response;
}

/**
 * Open a chat's photo or video full screen, with the chat's other media a step away
 */
async function openLightbox(chatId, messageId) {
    if (!chatId || !messageId) return;
    closeLightbox();

    const state = {
        chatId,
        items: [],
        index: -1,
        hasOlder: false,
        hasNewer: false,
        loading: true,
        returnFocus: document.activeElement,
        element: buildLightboxElement()
    };
    lightbox = state;
    document.body.appendChild(state.element);
    document.body.classList.add('lightbox-open');
    state.element.querySelector('.lightbox-close').focus();
    renderLightbox();

    try {
        // This message and older ones (newest first), then newer ones (oldest first)
        const [older, newer] = await Promise.all([
            fetchLightboxPage(chatId, 'before', messageId + 1),
            fetchLightboxPage(chatId, 'after', messageId)
        ]);
        if (lightbox !== state) return;

        state.items = older.data.slice().reverse().concat(newer.data);
        state.hasOlder = older.pagination.hasMore;
        state.hasNewer = newer.pagination.hasMore;
        state.index = state.items.findIndex(item => item.message_id === messageId);
        state.loading = false;

        if (state.index === -1) {
            closeLightbox();
            showNotification('That photo or video is no longer available', 'error');
            return;
        }
        renderLightbox();
    } catch (error) {
        console.error('Lightbox error:', error);
        if (lightbox === state) {
            closeLightbox();
            showNotification(error.message || 'Could not open the media', 'error');
        }
    }
}

function lightboxButton(className, label, svg, onClick) {
    const button = FriChat.h('button', {
        className: `lightbox-btn ${className}`,
        attrs: { type: 'button', title: label, 'aria-label': label },
        on: { click: (e) => { e.stopPropagation(); onClick(); } }
    });
    button.innerHTML = svg;
    return button;
}

function buildLightboxElement() {
    const close = lightboxButton('lightbox-close', 'Close (Esc)',
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        closeLightbox);
    const download = lightboxButton('lightbox-download', 'Download', DOWNLOAD_ICON_SVG, downloadLightboxItem);
    const showInChat = FriChat.h('button', {
        className: 'lightbox-show btn btn-secondary btn-small',
        text: 'Show in chat',
        attrs: { type: 'button' },
        on: { click: (e) => {
            e.stopPropagation();
            const item = lightbox && lightbox.items[lightbox.index];
            if (item) showMessageInChat(lightbox.chatId, item.message_id);
        } }
    });
    const prev = lightboxButton('lightbox-prev', 'Previous (←)',
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>',
        () => stepLightbox(-1));
    const next = lightboxButton('lightbox-next', 'Next (→)',
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>',
        () => stepLightbox(1));

    const element = FriChat.h('div', {
        className: 'lightbox',
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer' },
        on: { click: (e) => { if (e.target === element || e.target.classList.contains('lightbox-stage')) closeLightbox(); } }
    },
        FriChat.h('div', { className: 'lightbox-toolbar' },
            FriChat.h('div', { className: 'lightbox-caption' },
                FriChat.h('span', { className: 'lightbox-sender' }),
                FriChat.h('span', { className: 'lightbox-meta' })
            ),
            FriChat.h('div', { className: 'lightbox-actions' }, showInChat, download, close)
        ),
        FriChat.h('div', { className: 'lightbox-stage' }, prev, FriChat.h('div', { className: 'lightbox-media', attrs: { 'aria-live': 'polite' } }), next)
    );

    // Swipe left/right on touch screens
    let touchX = null;
    element.addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    element.addEventListener('touchend', (e) => {
        if (touchX === null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    });

    return element;
}

function renderLightbox() {
    const state = lightbox;
    if (!state) return;
    const { element } = state;
    const mediaBox = element.querySelector('.lightbox-media');
    const item = state.items[state.index];

    // Stop a playing video before replacing it
    const playing = mediaBox.querySelector('video');
    if (playing) playing.pause();

    if (!item) {
        mediaBox.replaceChildren(FriChat.h('span', { className: 'lightbox-loading', text: 'Loading…' }));
    } else if (item.message_type === 'video') {
        mediaBox.replaceChildren(FriChat.h('video', {
            attrs: { src: getFileUrl(item.upload_path), controls: true, autoplay: true, playsinline: true, 'aria-label': item.file_name || 'Video' }
        }));
    } else {
        mediaBox.replaceChildren(FriChat.h('img', { attrs: { src: getFileUrl(item.upload_path), alt: item.file_name || 'Photo' } }));
    }

    element.querySelector('.lightbox-sender').textContent = item ? (item.sender_name || '') : '';
    element.querySelector('.lightbox-meta').textContent = item
        ? `${new Date(item.created_at).toLocaleString()}${item.file_name ? ` · ${item.file_name}` : ''}`
        : '';

    const atStart = state.index <= 0 && !state.hasOlder;
    const atEnd = state.index >= state.items.length - 1 && !state.hasNewer;
    element.querySelector('.lightbox-prev').disabled = !item || atStart;
    element.querySelector('.lightbox-next').disabled = !item || atEnd;
    element.querySelector('.lightbox-download').disabled = !item;
    element.querySelector('.lightbox-show').disabled = !item;
}

/**
 * Previous (-1) or next (+1), loading another page at either end
 */
async function stepLightbox(delta) {
    const state = lightbox;
    if (!state || state.loading || state.index < 0) return;
    const target = state.index + delta;

    if (target < 0 && state.hasOlder) {
        state.loading = true;
        try {
            const page = await fetchLightboxPage(state.chatId, 'before', state.items[0].message_id);
            if (lightbox !== state) return;
            const older = page.data.slice().reverse();
            state.items = older.concat(state.items);
            state.index += older.length;
            state.hasOlder = page.pagination.hasMore;
        } catch (error) {
            showNotification(error.message, 'error');
        } finally {
            state.loading = false;
        }
    } else if (target >= state.items.length && state.hasNewer) {
        state.loading = true;
        try {
            const page = await fetchLightboxPage(state.chatId, 'after', state.items[state.items.length - 1].message_id);
            if (lightbox !== state) return;
            state.items = state.items.concat(page.data);
            state.hasNewer = page.pagination.hasMore;
        } catch (error) {
            showNotification(error.message, 'error');
        } finally {
            state.loading = false;
        }
    }

    const index = state.index + delta;
    if (index >= 0 && index < state.items.length) {
        state.index = index;
    }
    renderLightbox();
}

/**
 * Save the file. Uploads come from the API's origin, where <a download> is ignored,
 * so fetch it first; fall back to opening it in a new tab.
 */
async function downloadLightboxItem() {
    const item = lightbox && lightbox.items[lightbox.index];
    if (!item) return;
    const url = getFileUrl(item.upload_path);
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blobUrl = URL.createObjectURL(await response.blob());
        const link = FriChat.h('a', { attrs: { href: blobUrl, download: item.file_name || 'download' } });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (error) {
        window.open(url, '_blank', 'noopener');
    }
}

function closeLightbox() {
    if (!lightbox) return;
    const { element, returnFocus } = lightbox;
    lightbox = null;
    const video = element.querySelector('video');
    if (video) video.pause();
    element.remove();
    document.body.classList.remove('lightbox-open');
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
}

/**
 * Arrow keys and Escape while the lightbox is open (capture phase, so nothing behind it reacts)
 */
function handleLightboxKeydown(e) {
    if (!lightbox) return;
    if (e.key === 'Escape') {
        closeLightbox();
    } else if (e.key === 'ArrowLeft') {
        stepLightbox(-1);
    } else if (e.key === 'ArrowRight') {
        stepLightbox(1);
    } else if (e.key === 'Tab') {
        // Keep focus inside the viewer
        const focusable = Array.from(lightbox.element.querySelectorAll('button:not([disabled]), video[controls]'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            first.focus();
        } else {
            return;
        }
    } else {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
}

function initializeMedia() {
    document.addEventListener('keydown', handleLightboxKeydown, true);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    openLightbox,
    resetSharedMediaSection,
    renderSharedMediaSection,
    initializeMedia
});
Object.defineProperty(FriChat, 'lightbox', { get: () => lightbox, enumerable: true });
})(globalThis.FriChat = globalThis.FriChat || {});
