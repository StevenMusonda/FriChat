/**
 * Composer Module
 * Upload tray (attach button, drag-and-drop, paste) with previews, progress bars and cancel;
 * per-chat drafts kept in this browser; the Enter-to-send setting.
 * File names and draft text are put into the page with textContent, never innerHTML.
 */

(function (FriChat) {

// Files in the tray: { id, file, previewUrl, status: 'queued' | 'uploading' | 'error', progress, xhr, error, fields? }
// fields: extra form fields sent with the file (a voice note's duration and waveform, voice.js)
let pendingUploads = [];
let nextPendingUploadId = 1;
// { maxFileSize, maxAudioFileSize, allowedTypes } from GET /messages/upload-limits (the server enforces them either way)
let uploadLimits = null;
let draftSaveTimer = null;

const DRAFT_MAX_LENGTH = 5000;
const DRAFT_PREVIEW_LENGTH = 60;

// ===== Enter to send =====

function isEnterToSend() {
    try {
        return localStorage.getItem(CONFIG.STORAGE_KEYS.ENTER_TO_SEND) !== '0';
    } catch (e) {
        return true;
    }
}

function setEnterToSend(enabled) {
    try {
        localStorage.setItem(CONFIG.STORAGE_KEYS.ENTER_TO_SEND, enabled ? '1' : '0');
    } catch (e) {
        // Not remembered in private mode; still applies for this page
    }
    updateComposerKeyHint();
}

/**
 * Does this Enter keydown send? Ctrl/Cmd+Enter always does; otherwise it depends on the setting.
 */
function isSendShortcut(e) {
    if (e.ctrlKey || e.metaKey) return true;
    return isEnterToSend() ? !e.shiftKey : e.shiftKey;
}

function updateComposerKeyHint() {
    const hint = document.querySelector('.composer-hint-keys');
    if (hint) {
        hint.textContent = isEnterToSend()
            ? 'Ctrl+B / Ctrl+I · Shift+Enter new line'
            : 'Ctrl+B / Ctrl+I · Shift+Enter to send';
    }
    const toggle = document.getElementById('enterToSendToggle');
    if (toggle) toggle.checked = isEnterToSend();
}

// ===== Drafts =====

function draftKey(chatId) {
    const user = getCurrentUser();
    return user && chatId ? `${CONFIG.STORAGE_KEYS.DRAFT_PREFIX}${user.userId}:${chatId}` : null;
}

function getDraft(chatId) {
    const key = draftKey(chatId);
    if (!key) return '';
    try {
        return localStorage.getItem(key) || '';
    } catch (e) {
        return '';
    }
}

function saveDraft(chatId, text) {
    const key = draftKey(chatId);
    if (!key) return;
    try {
        if (text && text.trim()) {
            localStorage.setItem(key, text.slice(0, DRAFT_MAX_LENGTH));
        } else {
            localStorage.removeItem(key);
        }
    } catch (e) {
        // Storage full or blocked: the draft just isn't kept
    }
}

function clearDraft(chatId) {
    clearTimeout(draftSaveTimer);
    saveDraft(chatId, '');
}

/**
 * One line of a chat's draft for the chat list ('' when there is none)
 */
function getDraftPreview(chatId) {
    const text = getDraft(chatId).replace(/\s+/g, ' ').trim();
    return text.length > DRAFT_PREVIEW_LENGTH ? `${text.slice(0, DRAFT_PREVIEW_LENGTH - 1)}…` : text;
}

/**
 * What the user was typing in the open chat. While editing a message the composer holds that
 * message, and the text typed before the edit is kept in the edit state (messageActions.js).
 */
function getComposerDraftText() {
    if (isEditingMessage()) return composerContext.draft || '';
    const input = document.getElementById('messageInput');
    return input ? input.value : '';
}

function saveCurrentDraft() {
    clearTimeout(draftSaveTimer);
    if (currentChatId) saveDraft(currentChatId, getComposerDraftText());
}

function restoreDraft(chatId) {
    const input = document.getElementById('messageInput');
    if (!input) return;
    input.value = getDraft(chatId);
    autoResizeComposer();
}

// ===== Upload tray =====

async function loadUploadLimits() {
    if (uploadLimits) return uploadLimits;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.UPLOAD_LIMITS);
        if (response.success) uploadLimits = response.data;
    } catch (error) {
        console.error('Upload limits error:', error);
    }
    return uploadLimits;
}

/**
 * Why a file can't be sent, or null (same rules as the server's upload middleware)
 */
function checkUploadFile(file, limits) {
    if (!file.size) return `${file.name} is empty`;
    if (!limits) return null;
    if (!limits.allowedTypes.includes(file.type)) {
        return `${file.name}: this file type can't be sent`;
    }
    // Audio (voice notes) has its own, smaller cap
    const maxSize = file.type.startsWith('audio/') && limits.maxAudioFileSize ? limits.maxAudioFileSize : limits.maxFileSize;
    if (file.size > maxSize) {
        return `${file.name} is larger than ${formatFileSize(maxSize)}`;
    }
    return null;
}

function hasPendingUploads() {
    return pendingUploads.some(item => item.status === 'queued' || item.status === 'error');
}

/**
 * Put files in the tray for the open chat; they're sent with the next Send
 */
async function addFilesToTray(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0 || !currentChatId) return;

    if (!FriChat.canPostInCurrentChat()) {
        showNotification('You can\'t send files in this chat', 'error');
        return;
    }
    if (isEditingMessage()) {
        showNotification('Finish editing the message first', 'error');
        return;
    }

    const chatId = currentChatId;
    const limits = await loadUploadLimits();
    if (chatId !== currentChatId) return;

    for (const file of files) {
        if (pendingUploads.length >= CONFIG.MAX_TRAY_FILES) {
            showNotification(`You can send up to ${CONFIG.MAX_TRAY_FILES} files at a time`, 'error');
            break;
        }
        const problem = checkUploadFile(file, limits);
        if (problem) {
            showNotification(problem, 'error');
            continue;
        }
        pendingUploads.push({
            id: nextPendingUploadId++,
            file,
            previewUrl: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null,
            status: 'queued',
            progress: 0,
            xhr: null,
            error: null
        });
    }

    renderUploadTray();
    document.getElementById('messageInput').focus();
}

/**
 * A voice note whose upload failed: kept in the tray (with its duration and waveform) so Send retries it
 */
function addVoiceNoteToTray(file, fields, error) {
    pendingUploads.push({
        id: nextPendingUploadId++,
        file,
        previewUrl: null,
        status: 'error',
        progress: 0,
        xhr: null,
        error: error || 'Failed',
        fields
    });
    renderUploadTray();
}

/**
 * Remove a file from the tray, cancelling its upload if it's running
 */
function removeFromTray(id) {
    const item = pendingUploads.find(i => i.id === id);
    if (!item) return;
    if (item.xhr) item.xhr.abort();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    pendingUploads = pendingUploads.filter(i => i !== item);
    renderUploadTray();
}

/**
 * Leaving the chat: queued files are dropped. Running uploads finish in the background
 * (their message still arrives) but leave the tray.
 */
function resetUploadTray() {
    for (const item of pendingUploads) {
        if (item.status !== 'uploading' && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    pendingUploads = [];
    renderUploadTray();
}

/**
 * POST /messages/upload with progress events; resolves { success, cancelled?, message? }
 */
function uploadWithProgress(chatId, item, replyToMessageId, onProgress) {
    return new Promise(async (resolve) => {
        const token = await getAccessToken();
        if (!token) {
            resolve({ success: false, message: 'Your session has ended. Please sign in again.' });
            return;
        }

        const formData = new FormData();
        formData.append('file', item.file);
        formData.append('chatId', chatId);
        if (replyToMessageId) formData.append('replyToMessageId', replyToMessageId);
        for (const [name, value] of Object.entries(item.fields || {})) {
            if (value !== null && value !== undefined && value !== '') formData.append(name, value);
        }

        const xhr = new XMLHttpRequest();
        item.xhr = xhr;
        xhr.open('POST', `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.UPLOAD_FILE}`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
        });
        xhr.addEventListener('load', () => {
            let data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                // Not JSON (proxy error page etc.)
            }
            if (xhr.status >= 200 && xhr.status < 300 && data && data.success) {
                resolve(data);
            } else {
                resolve({ success: false, message: (data && data.message) || `Upload failed (${xhr.status})` });
            }
        });
        xhr.addEventListener('error', () => resolve({ success: false, message: 'Network error while uploading' }));
        xhr.addEventListener('abort', () => resolve({ success: false, cancelled: true }));
        xhr.send(formData);
    });
}

/**
 * Upload every waiting file one after another (the reply goes on the first), then send the text.
 * Each finished file arrives in the thread as its own message over the socket.
 */
async function sendPendingUploads(chatId, replyToMessageId, text) {
    const items = pendingUploads.filter(item => item.status === 'queued' || item.status === 'error');
    items.forEach(item => {
        item.status = 'queued';
        item.error = null;
    });
    renderUploadTray();

    let replyId = replyToMessageId;
    for (const item of items) {
        // Removed while waiting for its turn (or the user left the chat)
        if (!pendingUploads.includes(item)) continue;

        item.status = 'uploading';
        item.progress = 0;
        renderUploadTray();

        const result = await uploadWithProgress(chatId, item, replyId, (progress) => {
            item.progress = progress;
            updateUploadProgress(item);
        });
        item.xhr = null;

        if (result.success) {
            replyId = null;
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
            pendingUploads = pendingUploads.filter(i => i !== item);
        } else if (!result.cancelled) {
            item.status = 'error';
            item.error = result.message;
            if (chatId === currentChatId) {
                showNotification(`${item.file.name}: ${result.message}`, 'error');
            }
        }
        renderUploadTray();
    }

    if (text) await sendTextContent(chatId, text, replyId);
}

function uploadStatusText(item) {
    if (item.status === 'uploading') return `Uploading ${Math.round(item.progress * 100)}%`;
    if (item.status === 'error') return item.error || 'Failed';
    return formatFileSize(item.file.size);
}

function updateUploadProgress(item) {
    const row = document.querySelector(`#uploadTray [data-upload-id="${item.id}"]`);
    if (!row) return;
    row.querySelector('.upload-item-bar').style.width = `${Math.round(item.progress * 100)}%`;
    row.querySelector('.upload-item-status').textContent = uploadStatusText(item);
}

function renderUploadTray() {
    const tray = document.getElementById('uploadTray');
    if (!tray) return;

    tray.replaceChildren(...pendingUploads.map(item => {
        let thumb;
        if (item.previewUrl && item.file.type.startsWith('image/')) {
            thumb = FriChat.h('img', { attrs: { src: item.previewUrl, alt: '' } });
        } else if (item.previewUrl) {
            thumb = FriChat.h('video', { attrs: { src: item.previewUrl, muted: true, preload: 'metadata' } });
        } else {
            const ext = (item.file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
            thumb = FriChat.h('span', { className: 'upload-item-ext', text: ext });
        }

        const cancelLabel = item.status === 'uploading' ? `Cancel uploading ${item.file.name}` : `Remove ${item.file.name}`;
        return FriChat.h('div', {
            className: `upload-item ${item.status}`,
            attrs: { 'data-upload-id': item.id, role: 'listitem' }
        },
            FriChat.h('div', { className: 'upload-item-thumb' }, thumb),
            FriChat.h('div', { className: 'upload-item-info' },
                FriChat.h('span', { className: 'upload-item-name', text: item.file.name, attrs: { title: item.file.name } }),
                FriChat.h('span', { className: 'upload-item-status', text: uploadStatusText(item) }),
                FriChat.h('span', { className: 'upload-item-progress', attrs: { 'aria-hidden': 'true' } },
                    FriChat.h('span', { className: 'upload-item-bar', attrs: { style: `width: ${Math.round(item.progress * 100)}%` } }))
            ),
            FriChat.h('button', {
                className: 'icon-btn upload-item-remove',
                attrs: { type: 'button', title: item.status === 'uploading' ? 'Cancel upload' : 'Remove', 'aria-label': cancelLabel },
                on: { click: () => removeFromTray(item.id) }
            }, '×')
        );
    }));

    tray.hidden = pendingUploads.length === 0;
    document.getElementById('messagesContainer').classList.toggle('with-upload-tray', pendingUploads.length > 0);
    positionUploadTray();
}

/**
 * The tray floats above the composer, and above the reply/edit bar when that's open
 */
function positionUploadTray() {
    const tray = document.getElementById('uploadTray');
    const bar = document.getElementById('composerContext');
    if (!tray) return;
    tray.style.bottom = bar && !bar.hidden ? `calc(100% + ${bar.offsetHeight}px)` : '';
}

// ===== Wiring =====

function initializeComposer() {
    const input = document.getElementById('messageInput');
    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    const activeChat = document.getElementById('activeChat');

    updateComposerKeyHint();

    const enterToggle = document.getElementById('enterToSendToggle');
    if (enterToggle) {
        enterToggle.checked = isEnterToSend();
        enterToggle.addEventListener('change', () => setEnterToSend(enterToggle.checked));
    }

    // Save the draft shortly after typing stops, and right away when the page goes away
    input.addEventListener('input', () => {
        clearTimeout(draftSaveTimer);
        const chatId = currentChatId;
        draftSaveTimer = setTimeout(() => {
            if (chatId === currentChatId) saveCurrentDraft();
        }, 300);
    });
    window.addEventListener('pagehide', saveCurrentDraft);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) saveCurrentDraft();
    });

    // Attach button: pick files into the tray
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        addFilesToTray(fileInput.files);
        fileInput.value = '';
    });

    // Paste screenshots or copied files
    input.addEventListener('paste', (e) => {
        const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
        const files = items
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter(Boolean)
            .map((file, index) => {
                // Screenshots arrive as "image.png"; give them a more useful name
                if (file.name && file.name !== 'image.png') return file;
                const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
                return new File([file], `pasted-${Date.now()}${index ? `-${index}` : ''}.${ext}`, { type: file.type });
            });
        if (files.length === 0) return;
        // Keep pasted text too, unless the clipboard holds only files
        if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
        addFilesToTray(files);
    });

    // Drag files anywhere over the open chat
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    activeChat.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        activeChat.classList.add('drag-over');
    });
    activeChat.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = FriChat.canPostInCurrentChat() ? 'copy' : 'none';
    });
    activeChat.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) activeChat.classList.remove('drag-over');
    });
    activeChat.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        activeChat.classList.remove('drag-over');
        addFilesToTray(e.dataTransfer.files);
    });

    // A file dropped anywhere else (sidebar, welcome screen) must not navigate away from the app
    window.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
        if (hasFiles(e)) e.preventDefault();
    });

    // Keep the tray above the reply bar if the window (and the bar's wrapping) changes
    window.addEventListener('resize', positionUploadTray);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    getDraftPreview,
    saveCurrentDraft,
    resetUploadTray,
    restoreDraft,
    isSendShortcut,
    hasPendingUploads,
    clearDraft,
    sendPendingUploads,
    positionUploadTray,
    loadUploadLimits,
    uploadWithProgress,
    addVoiceNoteToTray,
    initializeComposer
});
})(globalThis.FriChat = globalThis.FriChat || {});
