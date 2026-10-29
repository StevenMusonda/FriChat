/**
 * Groups Module
 * Group info panel (profile, settings, invite links with QR code, join requests, members, leave),
 * the announcement-only composer lock and live group events.
 * Everything user-written is put into the page with textContent, never innerHTML.
 */

// GET /api/chats/:id for the open chat (role, can_post, settings, members with tags)
let currentChatDetails = null;
// Chat whose group panel is showing
let groupInfoOpenFor = null;
// The full link exists only in the create response, so it's kept here until the panel closes
let lastCreatedInvite = null;

// Mirrors backend/config/groups.js (the server enforces them)
const GROUP_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const GROUP_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const GROUP_NAME_MAX = 100;
const GROUP_DESCRIPTION_MAX = 500;
const MEMBER_TAG_MAX = 30;
const INVITE_EXPIRY_LABELS = { never: 'Never expires', '1h': '1 hour', '1d': '1 day', '7d': '7 days' };
const INVITE_STATUS_LABELS = { active: 'Active', revoked: 'Revoked', expired: 'Expired', used_up: 'Used up' };

/**
 * Small DOM builder: h('div', { className, text, attrs, on }, ...children). Strings become text nodes.
 */
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
    if (props.attrs) {
        for (const [name, value] of Object.entries(props.attrs)) {
            if (value === false || value === null || value === undefined) continue;
            node.setAttribute(name, value === true ? '' : String(value));
        }
    }
    if (props.on) {
        for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

/**
 * URL of a stored group avatar; anything that isn't one of the server's own avatar paths is ignored
 */
function groupAvatarSrc(avatarUrl) {
    if (typeof avatarUrl !== 'string' || !/^uploads\/group-avatars\/[a-f0-9]{32}\.(webp|jpg|png)$/.test(avatarUrl)) {
        return null;
    }
    const base = CONFIG.SOCKET_URL || CONFIG.API_BASE_URL.replace(/\/api$/, '');
    return `${base}/${avatarUrl}`;
}

function avatarNode(name, avatarUrl, className) {
    const wrap = h('div', { className });
    const src = groupAvatarSrc(avatarUrl) || (typeof userAvatarSrc === 'function' ? userAvatarSrc(avatarUrl) : null);
    if (src) {
        wrap.appendChild(h('img', { attrs: { src, alt: '' } }));
    } else {
        wrap.appendChild(h('span', { text: (name || '?').charAt(0).toUpperCase() }));
    }
    return wrap;
}

function displayNameOf(person) {
    return person.full_name || person.fullName || person.username;
}

// ===== Open chat state =====

/**
 * Called whenever GET /api/chats/:id returns for the open chat
 */
function applyChatDetails(chat) {
    if (!chat || chat.id !== currentChatId) return;
    currentChatDetails = chat;
    updateChatHeaderAvatar();
    updateComposerAccess();
    updateChatInfoBadge(chat.pending_request_count || 0);
}

function resetGroupState() {
    currentChatDetails = null;
    updateChatHeaderAvatar();
    updateComposerAccess();
    updateChatInfoBadge(0);
}

function isCurrentGroup() {
    return !!currentChatDetails && currentChatDetails.id === currentChatId && currentChatDetails.chat_type === 'group';
}

function updateChatHeaderAvatar() {
    const avatar = document.getElementById('chatAvatar');
    const initial = document.getElementById('chatInitial');
    if (!avatar || !initial) return;

    const existing = avatar.querySelector('img');
    if (existing) existing.remove();

    let src = isCurrentGroup() ? groupAvatarSrc(currentChatDetails.avatar_url) : null;
    // Direct chats: the other person's photo, if they share it (profile.js)
    if (!src && typeof currentDirectPartner === 'function' && typeof userAvatarSrc === 'function') {
        const partner = currentDirectPartner();
        src = partner ? userAvatarSrc(partner.avatar_url) : null;
    }
    initial.hidden = !!src;
    if (src) avatar.appendChild(h('img', { attrs: { src, alt: '' } }));
}

/**
 * False while the open chat is announcement-only and the user isn't an admin (the server refuses it anyway)
 */
function canPostInCurrentChat() {
    return !(currentChatDetails && currentChatDetails.id === currentChatId && currentChatDetails.can_post === false);
}

/**
 * Announcement-only groups (for members) and blocked direct chats show a disabled composer with an explanation
 */
function updateComposerAccess() {
    const container = document.querySelector('.message-input-container');
    const notice = document.getElementById('composerLockedNotice');
    if (!container || !notice) return;

    const locked = !canPostInCurrentChat();
    container.classList.toggle('composer-locked', locked);
    notice.hidden = !locked;

    // Announcement-only group, or a direct chat with a block (the server words the reason)
    const text = document.getElementById('composerLockedText');
    if (text) {
        text.textContent = locked && currentChatDetails && currentChatDetails.post_blocked_message
            ? currentChatDetails.post_blocked_message
            : 'Only admins can send messages in this group. You can still read and react.';
    }
    ['messageInput', 'sendBtn', 'attachBtn', 'emojiBtn', 'pollBtn', 'scheduleBtn'].forEach((id) => {
        const control = document.getElementById(id);
        if (control) control.disabled = locked;
    });

    if (locked) {
        const input = document.getElementById('messageInput');
        if (input && document.activeElement === input) input.blur();
        if (typeof clearComposerContext === 'function') clearComposerContext();
        const picker = document.getElementById('emojiPicker');
        if (picker) picker.style.display = 'none';
    }
}

function updateChatInfoBadge(count) {
    const badge = document.getElementById('chatInfoBadge');
    if (!badge) return;
    badge.hidden = !(count > 0);
    badge.textContent = count > 99 ? '99+' : String(count || '');
    const button = document.getElementById('chatInfoBtn');
    if (button) {
        button.setAttribute('aria-label', count > 0 ? `Chat info, ${count} join request${count === 1 ? '' : 's'}` : 'Chat info');
    }
}

/**
 * Tag shown next to a sender's name in the open group (HTML-escaped, for messages.js templates)
 */
function renderMemberTagHtml(senderId) {
    if (!isCurrentGroup()) return '';
    const member = (currentChatDetails.participants || []).find(p => p.id === senderId);
    if (!member || !member.member_tag) return '';
    return ` <span class="member-tag">${escapeHtml(member.member_tag)}</span>`;
}

// ===== Group info panel =====

function groupInfoModalOpen() {
    const modal = document.getElementById('chatInfoModal');
    return !!groupInfoOpenFor && !!modal && modal.style.display !== 'none';
}

async function openGroupInfo(chatId) {
    const modal = document.getElementById('chatInfoModal');
    const content = document.getElementById('chatInfoContent');
    const title = document.getElementById('chatInfoTitle');
    if (!modal || !content) return;

    if (groupInfoOpenFor !== chatId) lastCreatedInvite = null;
    groupInfoOpenFor = chatId;
    // Fresh tabs each time the panel opens; refreshes while it's open keep them (media.js)
    resetSharedMediaSection();
    if (title) title.textContent = 'Group info';
    content.replaceChildren(h('p', { className: 'group-info-loading', text: 'Loading…' }));
    modal.style.display = 'flex';
    await refreshGroupInfo();
}

function closeGroupInfo() {
    const modal = document.getElementById('chatInfoModal');
    if (modal) modal.style.display = 'none';
    groupInfoOpenFor = null;
    lastCreatedInvite = null;
}

async function refreshGroupInfo() {
    const chatId = groupInfoOpenFor;
    if (!chatId) return;

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.CHAT_BY_ID(chatId));
        if (groupInfoOpenFor !== chatId) return;
        if (!response.success) {
            document.getElementById('chatInfoContent').replaceChildren(h('p', { className: 'group-info-error', text: response.message || 'Could not load this group' }));
            return;
        }

        const chat = response.data;
        applyChatDetails(chat);

        let invites = [];
        let requests = [];
        let bans = [];
        if (chat.my_role === 'admin') {
            const [inviteResponse, requestResponse, banResponse] = await Promise.all([
                chat.invite_links_enabled ? apiRequest(CONFIG.ENDPOINTS.GROUP_INVITES(chatId)) : null,
                apiRequest(CONFIG.ENDPOINTS.JOIN_REQUESTS(chatId)),
                apiRequest(CONFIG.ENDPOINTS.GROUP_BANS(chatId))
            ]);
            if (inviteResponse && inviteResponse.success) invites = inviteResponse.data;
            if (requestResponse && requestResponse.success) requests = requestResponse.data;
            if (banResponse && banResponse.success) bans = banResponse.data;
            updateChatInfoBadge(requests.length);
        }

        if (groupInfoOpenFor !== chatId) return;
        renderGroupInfo(chat, invites, requests, bans);
    } catch (error) {
        console.error('Group info error:', error);
    }
}

function renderGroupInfo(chat, invites, requests, bans = []) {
    const content = document.getElementById('chatInfoContent');
    const isAdmin = chat.my_role === 'admin';
    const scrollTop = content.parentElement ? content.parentElement.scrollTop : 0;

    // replaceChildren would turn a null into the text "null", so sections a member doesn't get are dropped
    content.replaceChildren(...[
        renderProfileSection(chat, isAdmin),
        renderSettingsSection(chat, isAdmin),
        isAdmin ? renderInviteSection(chat, invites) : null,
        isAdmin && (chat.approve_new_members || requests.length > 0) ? renderRequestsSection(chat, requests) : null,
        renderMembersSection(chat, isAdmin),
        renderSharedMediaSection(chat.id),
        isAdmin && bans.length > 0 ? renderBansSection(chat, bans) : null,
        renderLeaveSection(chat)
    ].filter(Boolean));

    if (content.parentElement) content.parentElement.scrollTop = scrollTop;
}

function section(title, ...children) {
    return h('section', { className: 'chat-info-section group-info-section' }, h('h4', { text: title }), ...children);
}

// --- profile ---

function renderProfileSection(chat, isAdmin) {
    const count = (chat.participants || []).length;
    const view = h('div', { className: 'group-profile' },
        avatarNode(chat.chat_name, chat.avatar_url, 'group-profile-avatar'),
        h('div', { className: 'group-profile-text' },
            h('div', { className: 'group-profile-name', text: chat.chat_name || 'Unnamed group' }),
            h('div', { className: 'group-profile-meta', text: `${count} member${count === 1 ? '' : 's'}` }),
            chat.description
                ? h('p', { className: 'group-profile-description', text: chat.description })
                : (isAdmin ? h('p', { className: 'group-profile-description empty', text: 'No description yet' }) : null)
        )
    );

    if (!isAdmin) return section('Group', view);

    const fileInput = h('input', {
        attrs: { type: 'file', accept: GROUP_AVATAR_TYPES.join(','), hidden: true },
        on: { change: (e) => uploadGroupAvatar(chat.id, e.target.files[0], e.target) }
    });

    const actions = h('div', { className: 'group-actions-row' },
        h('button', { className: 'btn btn-secondary btn-small', text: 'Edit name & description', attrs: { type: 'button' }, on: { click: () => showProfileEditor(chat, view, actions) } }),
        h('button', { className: 'btn btn-secondary btn-small', text: chat.avatar_url ? 'Change photo' : 'Add photo', attrs: { type: 'button' }, on: { click: () => fileInput.click() } }),
        chat.avatar_url
            ? h('button', { className: 'btn btn-secondary btn-small', text: 'Remove photo', attrs: { type: 'button' }, on: { click: () => removeGroupAvatar(chat.id) } })
            : null,
        fileInput
    );

    return section('Group', view, actions,
        h('p', { className: 'settings-note', text: 'Photos: JPEG, PNG or WebP, up to 2 MB.' }));
}

function showProfileEditor(chat, view, actions) {
    const nameInput = h('input', { attrs: { type: 'text', maxlength: GROUP_NAME_MAX, required: true, 'aria-label': 'Group name' } });
    nameInput.value = chat.chat_name || '';
    const descriptionInput = h('textarea', { attrs: { rows: 3, maxlength: GROUP_DESCRIPTION_MAX, 'aria-label': 'Description', placeholder: 'What is this group about?' } });
    descriptionInput.value = chat.description || '';

    const form = h('form', { className: 'group-edit-form', on: {
        submit: async (e) => {
            e.preventDefault();
            const chatName = nameInput.value.trim();
            if (!chatName) {
                nameInput.focus();
                return;
            }
            const ok = await saveGroupSettings(chat.id, { chatName, description: descriptionInput.value.trim() });
            if (ok) refreshGroupInfo();
        }
    } },
        h('label', { className: 'group-field' }, h('span', { text: 'Name' }), nameInput),
        h('label', { className: 'group-field' }, h('span', { text: `Description (up to ${GROUP_DESCRIPTION_MAX} characters)` }), descriptionInput),
        h('div', { className: 'group-actions-row' },
            h('button', { className: 'btn btn-primary btn-small', text: 'Save', attrs: { type: 'submit' } }),
            h('button', { className: 'btn btn-secondary btn-small', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => refreshGroupInfo() } })
        )
    );

    view.replaceWith(form);
    actions.hidden = true;
    nameInput.focus();
}

async function saveGroupSettings(chatId, changes) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.GROUP_SETTINGS(chatId), {
            method: 'PATCH',
            body: JSON.stringify(changes)
        });
        if (!response.success) {
            showNotification(firstErrorMessage(response, 'Failed to update the group'), 'error');
            return false;
        }
        return true;
    } catch (error) {
        showNotification('Failed to update the group', 'error');
        return false;
    }
}

async function uploadGroupAvatar(chatId, file, input) {
    if (input) input.value = '';
    if (!file) return;

    if (!GROUP_AVATAR_TYPES.includes(file.type)) {
        showNotification('Choose a JPEG, PNG or WebP image', 'error');
        return;
    }
    if (file.size > GROUP_AVATAR_MAX_BYTES) {
        showNotification('The photo must be at most 2 MB', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('avatar', file);
    try {
        const token = await getAccessToken();
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.GROUP_AVATAR(chatId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });
        const data = await response.json();
        if (!data.success) {
            showNotification(data.message || 'Failed to update the photo', 'error');
            return;
        }
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to update the photo', 'error');
    }
}

async function removeGroupAvatar(chatId) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.GROUP_AVATAR(chatId), { method: 'DELETE' });
        if (!response.success) {
            showNotification(response.message || 'Failed to remove the photo', 'error');
            return;
        }
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to remove the photo', 'error');
    }
}

// --- settings ---

function switchRow(id, title, hint, checked, disabled, onChange) {
    const input = h('input', { className: 'switch', attrs: { type: 'checkbox', id, disabled } });
    input.checked = !!checked;
    if (onChange) input.addEventListener('change', () => onChange(input));
    return h('label', { className: 'settings-row', attrs: { for: id } },
        h('span', { className: 'settings-row-text' },
            h('span', { className: 'settings-row-title', text: title }),
            h('span', { className: 'settings-row-hint', text: hint })
        ),
        input
    );
}

function renderSettingsSection(chat, isAdmin) {
    const toggle = (key) => async (input) => {
        input.disabled = true;
        const ok = await saveGroupSettings(chat.id, { [key]: input.checked });
        if (!ok) input.checked = !input.checked;
        input.disabled = false;
        if (ok) refreshGroupInfo();
    };

    if (!isAdmin) {
        const notes = [];
        if (chat.announcement_only) notes.push(h('p', { className: 'settings-note', text: 'Only admins can send messages in this group.' }));
        if (chat.approve_new_members) notes.push(h('p', { className: 'settings-note', text: 'Admins approve people who join with an invite link.' }));
        return notes.length ? section('Settings', ...notes) : null;
    }

    return section('Settings',
        switchRow('groupApproveToggle', 'Approve new members', 'People who join with an invite link wait until an admin approves them.', chat.approve_new_members, false, toggle('approveNewMembers')),
        switchRow('groupAnnouncementToggle', 'Announcement-only', 'Only admins can send messages. Members can still read and react.', chat.announcement_only, false, toggle('announcementOnly'))
    );
}

// --- invite links ---

function renderInviteSection(chat, invites) {
    if (!chat.invite_links_enabled) {
        return section('Invite links', h('p', { className: 'settings-note', text: 'Invite links are turned off on this server.' }));
    }

    const expiry = h('select', { attrs: { 'aria-label': 'Link expires after' } },
        ...Object.entries(INVITE_EXPIRY_LABELS).map(([value, label]) => h('option', { text: label, attrs: { value } })));
    const maxUses = h('input', { attrs: { type: 'number', min: 1, max: 1000, step: 1, inputmode: 'numeric', placeholder: 'No limit', 'aria-label': 'Maximum uses' } });

    const form = h('form', { className: 'invite-create-form', on: {
        submit: async (e) => {
            e.preventDefault();
            const uses = maxUses.value.trim();
            if (uses && !(Number.isInteger(Number(uses)) && Number(uses) >= 1 && Number(uses) <= 1000)) {
                showNotification('Max uses must be a whole number from 1 to 1000', 'error');
                return;
            }
            await createGroupInvite(chat.id, expiry.value, uses ? Number(uses) : null);
        }
    } },
        h('label', { className: 'group-field' }, h('span', { text: 'Expires' }), expiry),
        h('label', { className: 'group-field' }, h('span', { text: 'Max uses' }), maxUses),
        h('button', { className: 'btn btn-primary btn-small', text: 'Create link', attrs: { type: 'submit' } })
    );

    const created = lastCreatedInvite && lastCreatedInvite.chatId === chat.id ? renderCreatedInvite(lastCreatedInvite) : null;

    const list = invites.length
        ? h('ul', { className: 'invite-list' }, ...invites.map(invite => renderInviteItem(chat.id, invite)))
        : h('p', { className: 'settings-note', text: 'No invite links yet.' });

    return section('Invite links', form, created, list);
}

function renderCreatedInvite(invite) {
    const urlInput = h('input', { className: 'invite-url', attrs: { type: 'text', readonly: true, 'aria-label': 'Invite link' } });
    urlInput.value = invite.url;
    const canvas = h('canvas', { className: 'invite-qr', attrs: { role: 'img', 'aria-label': 'QR code for the invite link' } });
    const qrOk = drawQrCode(canvas, invite.url);

    return h('div', { className: 'invite-created' },
        h('div', { className: 'invite-url-row' },
            urlInput,
            h('button', { className: 'btn btn-secondary btn-small', text: 'Copy', attrs: { type: 'button' }, on: { click: () => copyText(invite.url, urlInput) } })
        ),
        qrOk ? canvas : null,
        qrOk ? h('button', { className: 'btn btn-secondary btn-small', text: 'Download QR code', attrs: { type: 'button' }, on: { click: () => downloadCanvas(canvas, 'frichat-invite.png') } }) : null,
        h('p', { className: 'settings-note', text: 'Copy or share this link now. FriChat stores only a fingerprint of it, so the full link can\'t be shown again.' })
    );
}

function renderInviteItem(chatId, invite) {
    const uses = invite.maxUses ? `${invite.useCount} / ${invite.maxUses} uses` : `${invite.useCount} use${invite.useCount === 1 ? '' : 's'}`;
    const expires = invite.expiresAt
        ? `${invite.status === 'expired' ? 'Expired' : 'Expires'} ${new Date(invite.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Never expires';

    return h('li', { className: `invite-item invite-${invite.status}` },
        h('div', { className: 'invite-item-text' },
            h('div', { className: 'invite-item-title' },
                h('span', { text: `Link ${invite.tokenHint}…` }),
                h('span', { className: `invite-status invite-status-${invite.status}`, text: INVITE_STATUS_LABELS[invite.status] || invite.status })
            ),
            h('div', { className: 'invite-item-meta', text: `${uses} · ${expires}${invite.createdByUsername ? ` · by @${invite.createdByUsername}` : ''}` })
        ),
        invite.status === 'active'
            ? h('button', { className: 'btn btn-secondary btn-small', text: 'Revoke', attrs: { type: 'button' }, on: { click: () => revokeGroupInvite(chatId, invite.id) } })
            : null
    );
}

async function createGroupInvite(chatId, expiresIn, maxUses) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.GROUP_INVITES(chatId), {
            method: 'POST',
            body: JSON.stringify({ expiresIn, maxUses })
        });
        if (!response.success) {
            showNotification(firstErrorMessage(response, 'Failed to create the link'), 'error');
            return;
        }
        lastCreatedInvite = { chatId, url: response.data.url };
        await refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to create the link', 'error');
    }
}

async function revokeGroupInvite(chatId, inviteId) {
    if (!confirm('Revoke this link? Anyone who has it will no longer be able to join.')) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.GROUP_INVITE(chatId, inviteId), { method: 'DELETE' });
        if (!response.success) {
            showNotification(response.message || 'Failed to revoke the link', 'error');
        }
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to revoke the link', 'error');
    }
}

/**
 * Draw text as a QR code (vendor/qrcode-generator, served locally). Always dark on white so it scans in dark mode.
 */
function drawQrCode(canvas, text) {
    if (typeof qrcode !== 'function') return false;
    try {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const modules = qr.getModuleCount();
        const margin = 4;
        const scale = Math.max(3, Math.floor(240 / (modules + margin * 2)));
        const size = (modules + margin * 2) * scale;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000000';
        for (let row = 0; row < modules; row++) {
            for (let col = 0; col < modules; col++) {
                if (qr.isDark(row, col)) ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
            }
        }
        return true;
    } catch (error) {
        console.error('QR code error:', error);
        return false;
    }
}

function downloadCanvas(canvas, fileName) {
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function copyText(text, input) {
    try {
        await navigator.clipboard.writeText(text);
        showNotification('Link copied', 'info');
    } catch (error) {
        // Clipboard API unavailable (http, older browsers): select it for Ctrl+C
        if (input) {
            input.focus();
            input.select();
        }
        showNotification('Press Ctrl+C (Cmd+C) to copy the link', 'info');
    }
}

// --- join requests ---

function renderRequestsSection(chat, requests) {
    const list = requests.length
        ? h('ul', { className: 'join-request-list' }, ...requests.map(request => h('li', { className: 'join-request-item' },
            avatarNode(displayNameOf(request), request.avatarUrl, 'member-avatar'),
            h('div', { className: 'member-info' },
                h('div', { className: 'member-name', text: displayNameOf(request) }),
                h('div', { className: 'member-username', text: `@${request.username} · ${formatTime(request.createdAt)}` })
            ),
            h('div', { className: 'join-request-actions' },
                h('button', { className: 'btn btn-primary btn-small', text: 'Approve', attrs: { type: 'button' }, on: { click: (e) => decideJoinRequest(chat.id, request.id, 'approve', e.target) } }),
                h('button', { className: 'btn btn-secondary btn-small', text: 'Decline', attrs: { type: 'button' }, on: { click: (e) => decideJoinRequest(chat.id, request.id, 'decline', e.target) } })
            )
        )))
        : h('p', { className: 'settings-note', text: 'No pending requests.' });

    return section(`Join requests${requests.length ? ` (${requests.length})` : ''}`, list);
}

async function decideJoinRequest(chatId, requestId, decision, button) {
    if (button) button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.JOIN_REQUEST_DECISION(chatId, requestId, decision), { method: 'POST' });
        if (!response.success) {
            showNotification(response.message || 'Failed to update the request', 'error');
        }
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to update the request', 'error');
        if (button) button.disabled = false;
    }
}

// --- members ---

function renderMembersSection(chat, isAdmin) {
    const me = getCurrentUser().userId;
    const members = chat.participants || [];

    const items = members.map((member) => {
        const tagChip = member.member_tag ? h('span', { className: 'member-tag', text: member.member_tag }) : null;
        const nameRow = h('div', { className: 'member-name' },
            displayNameOf(member),
            member.id === me ? h('span', { className: 'member-you', text: ' (you)' }) : null,
            tagChip ? ' ' : null,
            tagChip
        );
        // Custom status and presence, only when the member shares them (privacy settings)
        const statusText = typeof directChatStatusText === 'function' ? directChatStatusText(member) : '';
        const info = h('div', { className: 'member-info profile-link', attrs: { 'data-profile-user-id': member.id, role: 'button', tabindex: 0, title: `View ${displayNameOf(member)}'s profile` } },
            nameRow,
            h('div', { className: 'member-username', text: `@${member.username}` }),
            statusText ? h('div', { className: 'member-custom-status', text: statusText }) : null
        );

        const memberAvatar = avatarNode(displayNameOf(member), member.avatar_url, 'member-avatar');
        memberAvatar.setAttribute('data-profile-user-id', member.id);
        const item = h('li', { className: 'member-item' },
            memberAvatar,
            info,
            member.role === 'admin' ? h('span', { className: 'member-role', text: 'Admin' }) : null,
            isAdmin
                ? h('button', { className: 'btn btn-secondary btn-small member-tag-btn', text: member.member_tag ? 'Edit tag' : 'Add tag', attrs: { type: 'button', 'aria-label': `Tag for ${displayNameOf(member)}` }, on: { click: () => showTagEditor(chat.id, member, item) } })
                : null,
            member.id !== me
                ? h('button', { className: 'btn btn-secondary btn-small member-options-btn', text: '⋯', attrs: { type: 'button', title: 'More options', 'aria-label': `Options for ${displayNameOf(member)}`, 'aria-expanded': 'false' }, on: { click: (e) => toggleMemberActions(chat, member, item, isAdmin, e.currentTarget) } })
                : null
        );
        return item;
    });

    return section(`Members (${members.length})`, h('ul', { className: 'members-list' }, ...items));
}

/**
 * Inline actions under a member: admin rights, remove, remove and ban (admins) and block (everyone)
 */
function toggleMemberActions(chat, member, item, isAdmin, toggle) {
    const existing = item.querySelector('.member-actions');
    if (existing) {
        existing.remove();
        toggle.setAttribute('aria-expanded', 'false');
        return;
    }

    const name = displayNameOf(member);
    const blocked = typeof isUserBlocked === 'function' && isUserBlocked(member.id);
    const row = h('div', { className: 'member-actions group-actions-row', attrs: { role: 'group', 'aria-label': `Options for ${name}` } },
        isAdmin
            ? h('button', { className: 'btn btn-secondary btn-small', text: member.role === 'admin' ? 'Remove admin' : 'Make admin', attrs: { type: 'button' }, on: { click: (e) => setMemberRole(chat.id, member, member.role === 'admin' ? 'member' : 'admin', e.target) } })
            : null,
        isAdmin
            ? h('button', { className: 'btn btn-secondary btn-small', text: 'Remove', attrs: { type: 'button' }, on: { click: (e) => removeGroupMember(chat.id, member, false, e.target) } })
            : null,
        isAdmin
            ? h('button', { className: 'btn btn-danger btn-small', text: 'Remove and ban', attrs: { type: 'button' }, on: { click: (e) => removeGroupMember(chat.id, member, true, e.target) } })
            : null,
        h('button', { className: 'btn btn-secondary btn-small', text: blocked ? 'Unblock' : 'Block', attrs: { type: 'button' }, on: { click: () => setUserBlocked(member.id, !blocked, name) } })
    );
    item.appendChild(row);
    toggle.setAttribute('aria-expanded', 'true');
}

async function setMemberRole(chatId, member, role, button) {
    if (button) button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MEMBER_ROLE(chatId, member.id), {
            method: 'PUT',
            body: JSON.stringify({ role })
        });
        if (!response.success) {
            showNotification(firstErrorMessage(response, 'Failed to change admin rights'), 'error');
            if (button) button.disabled = false;
            return;
        }
        showNotification(role === 'admin' ? `${displayNameOf(member)} is now an admin` : `${displayNameOf(member)} is no longer an admin`, 'info');
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to change admin rights', 'error');
        if (button) button.disabled = false;
    }
}

async function removeGroupMember(chatId, member, ban, button) {
    const name = displayNameOf(member);
    const question = ban
        ? `Remove ${name} and ban them? They can't rejoin by any invite link or be added again until an admin unbans them.`
        : `Remove ${name} from the group?`;
    if (!window.confirm(question)) return;

    if (button) button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.REMOVE_MEMBER(chatId, member.id, ban), { method: 'DELETE' });
        if (!response.success) {
            showNotification(firstErrorMessage(response, 'Failed to remove the member'), 'error');
            if (button) button.disabled = false;
            return;
        }
        showNotification(ban ? `${name} was removed and banned` : `${name} was removed`, 'info');
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to remove the member', 'error');
        if (button) button.disabled = false;
    }
}

// --- bans ---

function renderBansSection(chat, bans) {
    const list = h('ul', { className: 'members-list banned-list' }, ...bans.map(ban => h('li', { className: 'member-item' },
        avatarNode(displayNameOf(ban), ban.avatarUrl, 'member-avatar'),
        h('div', { className: 'member-info' },
            h('div', { className: 'member-name', text: displayNameOf(ban) }),
            h('div', { className: 'member-username', text: `@${ban.username}${ban.bannedBy ? ` · banned by @${ban.bannedBy}` : ''}` })
        ),
        h('button', { className: 'btn btn-secondary btn-small', text: 'Unban', attrs: { type: 'button', 'aria-label': `Unban ${displayNameOf(ban)}` }, on: { click: (e) => unbanGroupMember(chat.id, ban, e.target) } })
    )));
    return section(`Banned (${bans.length})`, list);
}

async function unbanGroupMember(chatId, ban, button) {
    if (button) button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.GROUP_BAN(chatId, ban.userId), { method: 'DELETE' });
        if (!response.success) {
            showNotification(firstErrorMessage(response, 'Failed to unban'), 'error');
            if (button) button.disabled = false;
            return;
        }
        showNotification(`${displayNameOf(ban)} can join again`, 'info');
        refreshGroupInfo();
    } catch (error) {
        showNotification('Failed to unban', 'error');
        if (button) button.disabled = false;
    }
}

function showTagEditor(chatId, member, item) {
    if (item.querySelector('.member-tag-form')) return;

    const input = h('input', { attrs: { type: 'text', maxlength: MEMBER_TAG_MAX, placeholder: 'e.g. Organizer', 'aria-label': `Tag for ${displayNameOf(member)}` } });
    input.value = member.member_tag || '';
    const save = async (tag) => {
        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.MEMBER_TAG(chatId, member.id), {
                method: 'PUT',
                body: JSON.stringify({ tag })
            });
            if (!response.success) {
                showNotification(firstErrorMessage(response, 'Failed to save the tag'), 'error');
                return;
            }
            refreshGroupInfo();
        } catch (error) {
            showNotification('Failed to save the tag', 'error');
        }
    };

    const form = h('form', { className: 'member-tag-form', on: { submit: (e) => { e.preventDefault(); save(input.value.trim() || null); } } },
        input,
        h('button', { className: 'btn btn-primary btn-small', text: 'Save', attrs: { type: 'submit' } }),
        member.member_tag ? h('button', { className: 'btn btn-secondary btn-small', text: 'Clear', attrs: { type: 'button' }, on: { click: () => save(null) } }) : null,
        h('button', { className: 'btn btn-secondary btn-small', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => form.remove() } })
    );
    item.appendChild(form);
    input.focus();
}

// --- leave ---

function renderLeaveSection(chat) {
    const me = getCurrentUser().userId;
    const others = (chat.participants || []).filter(p => p.id !== me);
    const otherAdmins = others.filter(p => p.role === 'admin');
    const mustPickAdmin = chat.my_role === 'admin' && otherAdmins.length === 0 && others.length > 0;

    const area = h('div', { className: 'group-leave' });
    const leaveButton = h('button', { className: 'btn btn-danger btn-small', text: 'Leave group', attrs: { type: 'button' }, on: { click: () => showLeaveConfirm() } });
    area.appendChild(leaveButton);

    function showLeaveConfirm() {
        leaveButton.hidden = true;
        // Participants come longest-standing first, so the first other member is the default
        const picker = mustPickAdmin
            ? h('select', { attrs: { 'aria-label': 'New admin' } }, ...others.map((p, i) => h('option', {
                text: `${displayNameOf(p)} (@${p.username})${i === 0 ? ' – longest in the group' : ''}`,
                attrs: { value: p.id }
            })))
            : null;

        const confirmBox = h('div', { className: 'group-leave-confirm', attrs: { role: 'group', 'aria-label': 'Confirm leaving' } },
            h('p', { text: mustPickAdmin
                ? 'You are the only admin. Pick who becomes admin when you leave:'
                : `Leave "${chat.chat_name || 'this group'}"? You'll stop getting its messages.` }),
            picker,
            h('div', { className: 'group-actions-row' },
                h('button', { className: 'btn btn-danger btn-small', text: mustPickAdmin ? 'Make admin and leave' : 'Leave', attrs: { type: 'button' }, on: {
                    click: (e) => {
                        e.target.disabled = true;
                        leaveCurrentGroup(chat, picker ? Number(picker.value) : null);
                    }
                } }),
                h('button', { className: 'btn btn-secondary btn-small', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => { confirmBox.remove(); leaveButton.hidden = false; } } })
            )
        );
        area.appendChild(confirmBox);
        if (picker) picker.focus();
    }

    return section('Leave', area);
}

async function leaveCurrentGroup(chat, newAdminId) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LEAVE_GROUP(chat.id), {
            method: 'POST',
            body: JSON.stringify(newAdminId ? { newAdminId } : {})
        });
        if (!response.success) {
            showNotification(response.message || 'Failed to leave the group', 'error');
            refreshGroupInfo();
            return;
        }

        closeGroupInfo();
        removeChatLocally(chat.id);
        const newAdmin = response.data.newAdmin;
        showNotification(newAdmin ? `You left the group. @${newAdmin.username} is now an admin.` : 'You left the group', 'info');
    } catch (error) {
        showNotification('Failed to leave the group', 'error');
    }
}

/**
 * Drop a chat the user is no longer in from the sidebar, and close it if it was open
 */
function removeChatLocally(chatId) {
    allChats = allChats.filter(c => c.id !== chatId);
    refreshChatList();

    if (currentChatId === chatId) {
        currentChatId = null;
        resetGroupState();
        try {
            localStorage.removeItem(CONFIG.STORAGE_KEYS.CURRENT_CHAT);
        } catch (e) {
            // Only a convenience
        }
        const activeChat = document.getElementById('activeChat');
        const welcome = document.querySelector('.chat-welcome');
        if (activeChat) activeChat.style.display = 'none';
        if (welcome) welcome.style.display = 'flex';
        const chatMain = document.querySelector('.chat-main');
        const chatSidebar = document.querySelector('.chat-sidebar');
        if (chatMain) chatMain.classList.remove('active');
        if (chatSidebar) chatSidebar.classList.remove('hidden');
    }
}

function firstErrorMessage(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors.length > 0 && response.errors[0].msg) {
        return response.errors[0].msg;
    }
    return (response && response.message) || fallback;
}

// ===== Live events =====

function handleGroupEvent(event, data) {
    if (!data || !data.chatId) return;
    const chatId = Number(data.chatId);

    if (event === 'group_updated') {
        const chat = allChats.find(c => c.id === chatId);
        if (chat) {
            chat.chat_name = data.chatName;
            refreshChatList();
        }
        if (chatId === currentChatId && currentChatDetails && currentChatDetails.id === chatId) {
            Object.assign(currentChatDetails, {
                chat_name: data.chatName,
                description: data.description,
                avatar_url: data.avatarUrl,
                approve_new_members: data.approveNewMembers,
                announcement_only: data.announcementOnly,
                can_post: !(data.announcementOnly && currentChatDetails.my_role !== 'admin')
            });
            const name = document.getElementById('chatName');
            const initial = document.getElementById('chatInitial');
            if (name) name.textContent = data.chatName || '';
            if (initial) initial.textContent = (data.chatName || 'C').charAt(0).toUpperCase();
            updateChatHeaderAvatar();
            updateComposerAccess();
        }
        if (groupInfoOpenFor === chatId && groupInfoModalOpen()) refreshGroupInfo();
        return;
    }

    if (event === 'group_members_updated') {
        if (groupInfoOpenFor === chatId && groupInfoModalOpen()) {
            refreshGroupInfo();
        } else if (chatId === currentChatId) {
            loadChatDetails(chatId);
        }
        return;
    }

    if (event === 'group_left') {
        if (groupInfoOpenFor === chatId) closeGroupInfo();
        removeChatLocally(chatId);
        return;
    }

    if (event === 'join_request_created') {
        const who = data.user ? (data.user.fullName || data.user.username) : 'Someone';
        showNotification(`${who} asked to join ${data.chatName || 'your group'}`, 'info');
        if (chatId === currentChatId) updateChatInfoBadge(data.pendingCount || 0);
        if (groupInfoOpenFor === chatId && groupInfoModalOpen()) refreshGroupInfo();
        return;
    }

    if (event === 'join_requests_updated') {
        if (chatId === currentChatId) updateChatInfoBadge(data.pendingCount || 0);
        return;
    }

    if (event === 'join_request_decided') {
        if (data.status === 'approved') {
            showNotification(`You've been accepted into ${data.chatName || 'the group'}`, 'info');
            loadChats();
        } else {
            showNotification(`Your request to join ${data.chatName || 'the group'} was declined`, 'error');
        }
    }
}

function initializeGroups() {
    const modal = document.getElementById('chatInfoModal');
    const close = document.getElementById('closeChatInfoModal');
    // ui.js hides the modal; this forgets which group it showed
    if (close) close.addEventListener('click', () => { groupInfoOpenFor = null; lastCreatedInvite = null; });
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) { groupInfoOpenFor = null; lastCreatedInvite = null; } });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && groupInfoModalOpen()) closeGroupInfo();
    });

    onGroupEvent(handleGroupEvent);
}

window.openGroupInfo = openGroupInfo;
