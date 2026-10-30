/**
 * Profile Module
 * Settings tabs, your profile (photo, display name, bio, custom status), privacy settings,
 * profile cards for other people, avatars and status in the chat list / header, and message requests.
 *
 * What other people's data shows is decided by the server (privacy settings are enforced there);
 * this file only renders what the API sends. Everything user-written goes in with textContent.
 */

(function (FriChat) {

// Mirrors backend/config/profile.js (the server enforces them)
const PROFILE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_BIO_MAX = 160;
const USER_AVATAR_PATTERN = /^uploads\/avatars\/[a-f0-9]{32}\.webp$/;

const STATUS_PRESETS = [
    { emoji: '📅', text: 'In a meeting', duration: '1h' },
    { emoji: '🚌', text: 'Commuting', duration: '30m' },
    { emoji: '🤒', text: 'Out sick', duration: '1d' },
    { emoji: '🌴', text: 'On vacation', duration: 'never' },
    { emoji: '🏠', text: 'Working remotely', duration: '1d' }
];

// Privacy control id -> API field
const PRIVACY_CONTROLS = {
    privacyLastSeen: 'lastSeen',
    privacyPhoto: 'photo',
    privacyBio: 'bio',
    privacyGroups: 'groups',
    privacyReadReceipts: 'readReceipts',
    privacyTyping: 'typingIndicators'
};

// GET /api/users/me (your own profile with privacy settings)
let myProfile = null;
// Profile card currently open
let profileCardUserId = null;
// Whether the sidebar's Requests section is open
let requestsExpanded = false;

// ===== Small helpers =====

/**
 * URL of a profile photo the server stored; anything else is ignored
 */
function userAvatarSrc(avatarUrl) {
    if (typeof avatarUrl !== 'string' || !USER_AVATAR_PATTERN.test(avatarUrl)) return null;
    const base = CONFIG.SOCKET_URL || CONFIG.API_BASE_URL.replace(/\/api$/, '');
    return `${base}/${avatarUrl}`;
}

/**
 * Put a photo (or the first letter of the name) into an avatar container
 */
function fillAvatar(container, name, src) {
    if (!container) return;
    container.replaceChildren(src
        ? FriChat.h('img', { attrs: { src, alt: '', loading: 'lazy' } })
        : FriChat.h('span', { text: (name || '?').charAt(0).toUpperCase() }));
}

/**
 * Avatar markup for the template-string chat list: the src is a server path checked by the
 * pattern above (and escaped); the initial is escaped
 */
function avatarInnerHtml(name, src) {
    return src
        ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">`
        : escapeHtml((name || '?').charAt(0).toUpperCase());
}

/**
 * "🎉 In a meeting" while the status is set and hasn't expired, else ''
 */
function customStatusLabel(customStatus) {
    if (!customStatus || (!customStatus.text && !customStatus.emoji)) return '';
    if (customStatus.expiresAt && new Date(customStatus.expiresAt) <= new Date()) return '';
    return [customStatus.emoji, customStatus.text].filter(Boolean).join(' ');
}

/**
 * 'online', 'last seen …' or '' when the person doesn't share it
 */
function presenceLabel(status, lastSeen) {
    if (status === 'online') return 'online';
    if (lastSeen) {
        const date = new Date(lastSeen);
        if (!isNaN(date)) {
            const sameDay = date.toDateString() === new Date().toDateString();
            const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return sameDay ? `last seen today at ${time}` : `last seen ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
        }
    }
    if (status === 'offline' || status === 'away') return 'offline';
    return '';
}

/**
 * Header line for a direct chat: presence and custom status, whatever the person shares
 */
function directChatStatusText(person) {
    if (!person) return '';
    const presence = presenceLabel(person.status, person.last_seen || person.lastSeen);
    const custom = customStatusLabel(person.custom_status || person.customStatus);
    return [custom, presence].filter(Boolean).join(' · ');
}

function parseParticipants(chat) {
    try {
        return typeof chat.participants === 'string' ? JSON.parse(chat.participants) : (chat.participants || []);
    } catch (e) {
        return [];
    }
}

function setFieldStatus(id, text, isError = false) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
}

function firstMessage(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors.length > 0) return response.errors[0].msg;
    return (response && response.message) || fallback;
}

// ===== Settings tabs =====

function selectSettingsTab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach(tab => {
        const selected = tab.dataset.settingsTab === name;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-settings-panel]').forEach(panel => {
        panel.hidden = panel.dataset.settingsPanel !== name;
    });
}

/**
 * Open Settings on one tab ('profile' | 'privacy' | 'notifications' | 'devices' | 'appearance')
 */
function openSettingsTab(name) {
    document.getElementById('settingsBtn').click();
    selectSettingsTab(name);
}

function initializeSettingsTabs() {
    const tabs = [...document.querySelectorAll('[data-settings-tab]')];
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
        // Arrow keys move between tabs (WAI-ARIA tabs pattern)
        tab.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
            else if (e.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
            else if (e.key === 'Home') next = tabs[0];
            else if (e.key === 'End') next = tabs[tabs.length - 1];
            if (!next) return;
            e.preventDefault();
            selectSettingsTab(next.dataset.settingsTab);
            next.focus();
        });
    });
}

// ===== Your profile =====

async function loadMyProfile() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.ME);
        if (response.success) applyMyProfile(response.data);
    } catch (error) {
        console.error('Load profile error:', error);
    }
}

/**
 * Show your profile in the sidebar and the Profile and Privacy tabs
 */
function applyMyProfile(profile) {
    if (!profile) return;
    myProfile = { ...(myProfile || {}), ...profile };

    // Sidebar
    const name = myProfile.fullName || myProfile.username;
    const avatar = document.getElementById('userAvatar');
    if (avatar) fillAvatar(avatar, name, userAvatarSrc(myProfile.avatarUrl));
    const nameNode = document.getElementById('userName');
    if (nameNode) nameNode.textContent = name;
    const statusNode = document.getElementById('userStatus');
    if (statusNode) statusNode.textContent = customStatusLabel(myProfile.customStatus) || 'Online';

    // Remembered for the logout dialog and other modules
    try {
        const stored = getCurrentUser();
        if (stored) {
            stored.fullName = myProfile.fullName;
            stored.avatarUrl = myProfile.avatarUrl;
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(stored));
        }
    } catch (e) {
        // Only a convenience
    }

    // Profile tab
    fillAvatar(document.getElementById('profilePhotoPreview'), name, userAvatarSrc(myProfile.avatarUrl));
    const removeBtn = document.getElementById('profilePhotoRemoveBtn');
    if (removeBtn) removeBtn.hidden = !myProfile.avatarUrl;
    const photoBtn = document.getElementById('profilePhotoBtn');
    if (photoBtn) photoBtn.textContent = myProfile.avatarUrl ? 'Change photo' : 'Upload photo';

    const nameInput = document.getElementById('profileDisplayName');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = myProfile.fullName || '';
    const bioInput = document.getElementById('profileBio');
    if (bioInput && document.activeElement !== bioInput) {
        bioInput.value = myProfile.bio || '';
        updateBioCount();
    }

    const current = customStatusLabel(myProfile.customStatus);
    const currentNode = document.getElementById('customStatusCurrent');
    if (currentNode) {
        currentNode.textContent = current
            ? `Current: ${current}${myProfile.customStatus.expiresAt ? ` (until ${new Date(myProfile.customStatus.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })})` : ''}`
            : 'No status set.';
    }
    const clearBtn = document.getElementById('customStatusClearBtn');
    if (clearBtn) clearBtn.hidden = !current;

    if (myProfile.privacy) applyPrivacySettings(myProfile.privacy);
}

function updateBioCount() {
    const bio = document.getElementById('profileBio');
    const count = document.getElementById('profileBioCount');
    if (bio && count) count.textContent = String(bio.value.length);
}

async function saveProfile(event) {
    event.preventDefault();
    const nameInput = document.getElementById('profileDisplayName');
    const bioInput = document.getElementById('profileBio');
    const displayName = nameInput.value.trim();
    if (!displayName) {
        setFieldStatus('profileStatus', 'Enter a display name', true);
        nameInput.focus();
        return;
    }

    const button = document.getElementById('profileSaveBtn');
    button.disabled = true;
    setFieldStatus('profileStatus', 'Saving…');
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MY_PROFILE, {
            method: 'PUT',
            body: JSON.stringify({ displayName, bio: bioInput.value.trim().slice(0, PROFILE_BIO_MAX) })
        });
        if (response.success) {
            applyMyProfile(response.data);
            setFieldStatus('profileStatus', 'Saved');
        } else {
            setFieldStatus('profileStatus', firstMessage(response, 'Failed to save your profile'), true);
        }
    } catch (error) {
        setFieldStatus('profileStatus', 'Failed to save your profile', true);
    } finally {
        button.disabled = false;
    }
}

async function uploadProfilePhoto(file) {
    const input = document.getElementById('profilePhotoInput');
    if (input) input.value = '';
    if (!file) return;

    if (!PROFILE_PHOTO_TYPES.includes(file.type)) {
        setFieldStatus('profilePhotoStatus', 'Choose a JPEG, PNG or WebP image', true);
        return;
    }
    if (file.size > PROFILE_PHOTO_MAX_BYTES) {
        setFieldStatus('profilePhotoStatus', 'The photo must be at most 5 MB', true);
        return;
    }

    setFieldStatus('profilePhotoStatus', 'Uploading…');
    const formData = new FormData();
    formData.append('avatar', file);
    try {
        const token = await getAccessToken();
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.MY_AVATAR}`, {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });
        const data = await response.json();
        if (!data.success) {
            setFieldStatus('profilePhotoStatus', data.message || 'Failed to update your photo', true);
            return;
        }
        applyMyProfile(data.data);
        setFieldStatus('profilePhotoStatus', 'Photo updated');
    } catch (error) {
        setFieldStatus('profilePhotoStatus', 'Failed to update your photo', true);
    }
}

async function removeProfilePhoto() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MY_AVATAR, { method: 'DELETE' });
        if (response.success) {
            applyMyProfile(response.data);
            setFieldStatus('profilePhotoStatus', 'Photo removed');
        } else {
            setFieldStatus('profilePhotoStatus', response.message || 'Failed to remove your photo', true);
        }
    } catch (error) {
        setFieldStatus('profilePhotoStatus', 'Failed to remove your photo', true);
    }
}

async function saveCustomStatus(event) {
    event.preventDefault();
    const emoji = document.getElementById('customStatusEmoji').value.trim();
    const text = document.getElementById('customStatusText').value.trim();
    const duration = document.getElementById('customStatusDuration').value;
    if (!emoji && !text) {
        setFieldStatus('customStatusStatus', 'Add a status text or an emoji', true);
        return;
    }

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MY_STATUS, {
            method: 'PUT',
            body: JSON.stringify({ emoji: emoji || null, text: text || null, duration })
        });
        if (response.success) {
            applyMyProfile(response.data);
            setFieldStatus('customStatusStatus', 'Status set');
        } else {
            setFieldStatus('customStatusStatus', firstMessage(response, 'Failed to set your status'), true);
        }
    } catch (error) {
        setFieldStatus('customStatusStatus', 'Failed to set your status', true);
    }
}

async function clearCustomStatus() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MY_STATUS, { method: 'DELETE' });
        if (response.success) {
            applyMyProfile(response.data);
            document.getElementById('customStatusEmoji').value = '';
            document.getElementById('customStatusText').value = '';
            setFieldStatus('customStatusStatus', 'Status cleared');
        } else {
            setFieldStatus('customStatusStatus', response.message || 'Failed to clear your status', true);
        }
    } catch (error) {
        setFieldStatus('customStatusStatus', 'Failed to clear your status', true);
    }
}

function renderStatusPresets() {
    const container = document.getElementById('customStatusPresets');
    if (!container) return;
    container.replaceChildren(...STATUS_PRESETS.map(preset => FriChat.h('button', {
        className: 'planner-chip',
        text: `${preset.emoji} ${preset.text}`,
        attrs: { type: 'button' },
        on: {
            click: () => {
                document.getElementById('customStatusEmoji').value = preset.emoji;
                document.getElementById('customStatusText').value = preset.text;
                document.getElementById('customStatusDuration').value = preset.duration;
            }
        }
    })));
}

// ===== Privacy =====

function applyPrivacySettings(settings) {
    if (!settings) return;
    if (myProfile) myProfile.privacy = settings;
    for (const [id, field] of Object.entries(PRIVACY_CONTROLS)) {
        const control = document.getElementById(id);
        if (!control || settings[field] === undefined) continue;
        if (control.type === 'checkbox') control.checked = !!settings[field];
        else control.value = settings[field];
    }
}

async function savePrivacyControl(control) {
    const field = PRIVACY_CONTROLS[control.id];
    if (!field) return;
    const value = control.type === 'checkbox' ? control.checked : control.value;

    control.disabled = true;
    setFieldStatus('privacyStatus', 'Saving…');
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MY_PRIVACY, {
            method: 'PUT',
            body: JSON.stringify({ [field]: value })
        });
        if (response.success) {
            applyPrivacySettings(response.data);
            setFieldStatus('privacyStatus', 'Saved');
        } else {
            setFieldStatus('privacyStatus', firstMessage(response, 'Failed to save'), true);
            if (myProfile && myProfile.privacy) applyPrivacySettings(myProfile.privacy);
        }
    } catch (error) {
        setFieldStatus('privacyStatus', 'Failed to save', true);
        if (myProfile && myProfile.privacy) applyPrivacySettings(myProfile.privacy);
    } finally {
        control.disabled = false;
    }
}

// ===== Profile card =====

async function openProfileCard(userId) {
    userId = Number(userId);
    if (!Number.isInteger(userId) || userId < 1) return;

    const modal = document.getElementById('profileCardModal');
    const body = document.getElementById('profileCardBody');
    if (!modal || !body) return;

    profileCardUserId = userId;
    body.replaceChildren(FriChat.h('p', { className: 'settings-note', text: 'Loading…' }));
    modal.style.display = 'flex';
    document.getElementById('closeProfileCard').focus();

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.USER_PROFILE(userId));
        if (profileCardUserId !== userId) return;
        if (!response.success) {
            body.replaceChildren(FriChat.h('p', { className: 'settings-status error', text: response.message || 'Could not load this profile' }));
            return;
        }
        renderProfileCard(response.data);
    } catch (error) {
        body.replaceChildren(FriChat.h('p', { className: 'settings-status error', text: 'Could not load this profile' }));
    }
}

function renderProfileCard(profile) {
    const body = document.getElementById('profileCardBody');
    const name = profile.fullName || profile.username;
    const avatar = FriChat.h('div', { className: 'profile-card-avatar' });
    fillAvatar(avatar, name, userAvatarSrc(profile.avatarUrl));

    const custom = customStatusLabel(profile.customStatus);
    const presence = presenceLabel(profile.status, profile.lastSeen);

    const actions = FriChat.h('div', { className: 'profile-card-actions' });
    if (profile.isSelf) {
        actions.appendChild(FriChat.h('button', { className: 'btn btn-primary btn-small', text: 'Edit profile', attrs: { type: 'button' }, on: { click: () => { closeProfileCard(); openSettingsTab('profile'); } } }));
    } else {
        actions.appendChild(FriChat.h('button', { className: 'btn btn-primary btn-small', text: 'Message', attrs: { type: 'button' }, on: { click: () => messageUser(profile.id) } }));
        actions.appendChild(FriChat.h('button', {
            className: profile.blockedByMe ? 'btn btn-secondary btn-small' : 'btn btn-danger btn-small',
            text: profile.blockedByMe ? 'Unblock' : 'Block',
            attrs: { type: 'button' },
            on: { click: async () => { await FriChat.setUserBlocked(profile.id, !profile.blockedByMe, name); openProfileCard(profile.id); } }
        }));
    }

    body.replaceChildren(
        FriChat.h('div', { className: 'profile-card' },
            avatar,
            FriChat.h('h4', { className: 'profile-card-name', text: name, attrs: { id: 'profileCardName' } }),
            FriChat.h('div', { className: 'profile-card-username', text: `@${profile.username}` }),
            custom ? FriChat.h('div', { className: 'profile-card-custom-status', text: custom }) : null,
            presence ? FriChat.h('div', { className: 'profile-card-presence', text: presence }) : null,
            profile.bio ? FriChat.h('div', { className: 'profile-card-section' },
                FriChat.h('div', { className: 'profile-card-label', text: 'Bio' }),
                FriChat.h('p', { className: 'profile-card-bio', text: profile.bio })
            ) : null,
            actions
        )
    );
}

function closeProfileCard() {
    const modal = document.getElementById('profileCardModal');
    if (modal) modal.style.display = 'none';
    profileCardUserId = null;
}

/**
 * Open (or start) the direct chat with a user
 */
async function messageUser(userId) {
    closeProfileCard();
    // createChat (chat.js) says so when this became a message request
    const result = await createChat('direct', null, [userId]);
    if (!result.success) {
        showNotification(result.message || 'Could not open the chat', 'error');
    }
}

// ===== Live updates =====

/**
 * Another user's profile changed (as the server lets this user see it), or your own did
 */
function applyUserProfileUpdate(data) {
    if (!data || !data.id) return;
    const me = getCurrentUser();
    if (me && Number(me.userId) === Number(data.id)) {
        applyMyProfile(data);
    }

    for (const chat of allChats) {
        const participants = parseParticipants(chat);
        let changed = false;
        for (const p of participants) {
            if (Number(p.userId) !== Number(data.id)) continue;
            p.fullName = data.fullName;
            p.avatarUrl = data.avatarUrl;
            p.customStatus = data.customStatus;
            if (data.status !== undefined) p.status = data.status;
            changed = true;
        }
        if (changed) chat.participants = JSON.stringify(participants);
    }

    if (FriChat.currentChatDetails && Array.isArray(FriChat.currentChatDetails.participants)) {
        for (const p of FriChat.currentChatDetails.participants) {
            if (Number(p.id) !== Number(data.id)) continue;
            p.full_name = data.fullName;
            p.avatar_url = data.avatarUrl;
            p.custom_status = data.customStatus;
            if (data.status !== undefined) p.status = data.status;
        }
        refreshDirectChatHeader();
        FriChat.updateChatHeaderAvatar();
    }
    refreshChatList();

    if (profileCardUserId === Number(data.id)) openProfileCard(data.id);
}

/**
 * Presence changed (null = the person doesn't share it with you)
 */
function applyPresenceUpdate(data) {
    if (!data || !data.userId) return;
    for (const chat of allChats) {
        const participants = parseParticipants(chat);
        const person = participants.find(p => Number(p.userId) === Number(data.userId));
        if (!person) continue;
        person.status = data.status;
        chat.participants = JSON.stringify(participants);
    }
    if (FriChat.currentChatDetails && Array.isArray(FriChat.currentChatDetails.participants)) {
        const person = FriChat.currentChatDetails.participants.find(p => Number(p.id) === Number(data.userId));
        if (person) {
            person.status = data.status;
            if (data.status !== 'online' && data.status) person.last_seen = new Date().toISOString();
            if (!data.status) person.last_seen = null;
            refreshDirectChatHeader();
        }
    }
}

/**
 * The other person of the open direct chat (from GET /api/chats/:id), or null
 */
function currentDirectPartner() {
    if (!FriChat.currentChatDetails || FriChat.currentChatDetails.id !== currentChatId || FriChat.currentChatDetails.chat_type !== 'direct') return null;
    const me = getCurrentUser().userId;
    return (FriChat.currentChatDetails.participants || []).find(p => Number(p.id) !== Number(me)) || null;
}

function refreshDirectChatHeader() {
    const partner = currentDirectPartner();
    if (!partner) return;
    const name = partner.full_name || partner.username;
    document.getElementById('chatName').textContent = name;
    document.getElementById('chatStatus').textContent = directChatStatusText(partner);
}

// ===== Message requests =====

function isIncomingRequest(chat) {
    return !!(chat && chat.message_request && chat.message_request.incoming && chat.message_request.status === 'pending');
}

/**
 * Sidebar section for incoming requests (rendered by chat.js above the chat list)
 */
function renderRequestsToggleHtml(count) {
    return `
        <button type="button" class="archived-toggle requests-toggle" id="requestsToggle" aria-expanded="${requestsExpanded}" aria-controls="requestChatList">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
            <span class="archived-toggle-label">Message requests</span>
            <span class="archived-toggle-count">${count}</span>
            <svg class="archived-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>`;
}

function bindRequestsToggle() {
    const toggle = document.getElementById('requestsToggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
        requestsExpanded = !requestsExpanded;
        toggle.setAttribute('aria-expanded', requestsExpanded);
        const list = document.getElementById('requestChatList');
        if (list) list.hidden = !requestsExpanded;
    });
}

function isRequestsExpanded() {
    return requestsExpanded;
}

function resetMessageRequestState() {
    const bar = document.getElementById('messageRequestBar');
    if (bar) bar.hidden = true;
}

/**
 * The bar above the composer for a message request (GET /api/chats/:id message_request)
 */
function applyMessageRequestState(chat) {
    const bar = document.getElementById('messageRequestBar');
    if (!bar || !chat || chat.id !== currentChatId) return;
    const request = chat.message_request;
    if (!request || chat.chat_type !== 'direct') {
        bar.hidden = true;
        return;
    }

    const partner = currentDirectPartner();
    const name = partner ? (partner.full_name || partner.username) : 'This person';
    const text = document.getElementById('messageRequestText');
    const actions = document.getElementById('messageRequestActions');
    if (request.incoming) {
        text.textContent = `${name} wants to send you a message. You don't share any chats. They won't know you've seen this until you accept.`;
        actions.hidden = false;
    } else {
        text.textContent = `Message request sent. ${name} will see your messages in their requests until they accept.`;
        actions.hidden = true;
    }
    bar.hidden = false;
}

async function decideMessageRequest(action) {
    const chatId = currentChatId;
    if (!chatId) return;
    const partner = currentDirectPartner();
    const name = partner ? (partner.full_name || partner.username) : 'this person';

    if (action === 'block' && !confirm(`Block ${name}? They won't be able to message you, and this request is removed.`)) return;
    if (action === 'delete' && !confirm('Delete this message request? The sender is not told.')) return;

    const buttons = document.querySelectorAll('#messageRequestActions button');
    buttons.forEach(b => { b.disabled = true; });
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.MESSAGE_REQUEST(chatId, action), { method: 'POST' });
        if (!response.success) {
            showNotification(response.message || 'Failed to update the request', 'error');
            return;
        }
        afterMessageRequestDecision(chatId, response.data.status);
    } catch (error) {
        showNotification('Failed to update the request', 'error');
    } finally {
        buttons.forEach(b => { b.disabled = false; });
    }
}

async function afterMessageRequestDecision(chatId, status) {
    if (status === 'accepted') {
        await loadChats();
        if (chatId === currentChatId) {
            await loadChatDetails(chatId);
        }
        return;
    }
    // Deleted or blocked: the chat leaves the list
    allChats = allChats.filter(chat => chat.id !== chatId);
    if (chatId === currentChatId) {
        // Desktop: close the chat; phones: back to the chat list
        const closeBtn = document.getElementById('closeChatBtn');
        if (closeBtn) closeBtn.click();
        const backBtn = document.getElementById('mobileBackBtn');
        if (backBtn && window.innerWidth <= 768) backBtn.click();
        document.getElementById('activeChat').style.display = 'none';
        document.querySelector('.chat-welcome').style.display = 'flex';
        currentChatId = null;
        localStorage.removeItem(CONFIG.STORAGE_KEYS.CURRENT_CHAT);
    }
    refreshChatList();
}

// ===== Setup =====

function initializeProfile() {
    initializeSettingsTabs();
    renderStatusPresets();

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => {
        selectSettingsTab('profile');
        loadMyProfile();
    });
    const profileBtn = document.getElementById('userProfileBtn');
    if (profileBtn) profileBtn.addEventListener('click', () => openSettingsTab('profile'));

    // Profile tab
    document.getElementById('profileForm').addEventListener('submit', saveProfile);
    document.getElementById('profileBio').addEventListener('input', updateBioCount);
    document.getElementById('profilePhotoBtn').addEventListener('click', () => document.getElementById('profilePhotoInput').click());
    document.getElementById('profilePhotoInput').addEventListener('change', (e) => uploadProfilePhoto(e.target.files[0]));
    document.getElementById('profilePhotoRemoveBtn').addEventListener('click', removeProfilePhoto);
    document.getElementById('customStatusForm').addEventListener('submit', saveCustomStatus);
    document.getElementById('customStatusClearBtn').addEventListener('click', clearCustomStatus);

    // Privacy tab: each control saves on change
    document.querySelectorAll('[data-privacy-field]').forEach(control => {
        control.addEventListener('change', () => savePrivacyControl(control));
    });

    // Profile card: any element with data-profile-user-id opens it (names, avatars, header)
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-profile-user-id]');
        if (target) openProfileCard(target.dataset.profileUserId);
    });
    document.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-profile-user-id]')) {
            e.preventDefault();
            openProfileCard(e.target.dataset.profileUserId);
        }
        if (e.key === 'Escape' && document.getElementById('profileCardModal').style.display === 'flex') closeProfileCard();
    });
    document.getElementById('closeProfileCard').addEventListener('click', closeProfileCard);
    document.getElementById('profileCardModal').addEventListener('click', (e) => {
        if (e.target.id === 'profileCardModal') closeProfileCard();
    });

    // A direct chat's header opens the other person's card
    const headerInfo = document.getElementById('chatHeaderInfo');
    if (headerInfo) {
        headerInfo.addEventListener('click', () => {
            const partner = currentDirectPartner();
            if (partner) openProfileCard(partner.id);
        });
    }

    // Message request bar
    document.getElementById('requestAcceptBtn').addEventListener('click', () => decideMessageRequest('accept'));
    document.getElementById('requestDeleteBtn').addEventListener('click', () => decideMessageRequest('delete'));
    document.getElementById('requestBlockBtn').addEventListener('click', () => decideMessageRequest('block'));

    onAccountEvent((event, data) => {
        if (event === 'user_profile_updated') applyUserProfileUpdate(data);
        else if (event === 'privacy_settings_updated') applyPrivacySettings(data);
        else if (event === 'message_request_updated') afterMessageRequestDecision(Number(data.chatId), data.status);
    });

    // Custom statuses expire on their own: re-render now and then so expired ones disappear
    setInterval(() => {
        refreshChatList();
        refreshDirectChatHeader();
        if (myProfile) applyMyProfile({});
    }, 60 * 1000);

    loadMyProfile();
}

if (typeof window !== 'undefined') {
    window.openProfileCard = openProfileCard;
    window.openSettingsTab = openSettingsTab;
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    bindRequestsToggle,
    avatarInnerHtml,
    userAvatarSrc,
    customStatusLabel,
    isIncomingRequest,
    isRequestsExpanded,
    renderRequestsToggleHtml,
    resetMessageRequestState,
    applyMessageRequestState,
    directChatStatusText,
    applyPresenceUpdate,
    openProfileCard,
    currentDirectPartner,
    initializeProfile
});
})(globalThis.FriChat = globalThis.FriChat || {});
