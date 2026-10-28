/**
 * Join page (join.html?code=<invite code>)
 * Signed out: remember the code and go to login, which comes back here.
 * Signed in: show the group (name, photo, description, member count) and a Join button.
 * Everything from the server is put into the page with textContent.
 */

(function () {
    'use strict';

    const content = document.getElementById('joinContent');

    function h(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function button(label, className, onClick) {
        const node = h('button', `btn ${className}`, label);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
    }

    // Same rule as groups.js: only the server's own avatar paths are loaded
    function avatarSrc(avatarUrl) {
        if (typeof avatarUrl !== 'string' || !/^uploads\/group-avatars\/[a-f0-9]{32}\.(webp|jpg|png)$/.test(avatarUrl)) return null;
        const base = CONFIG.SOCKET_URL || CONFIG.API_BASE_URL.replace(/\/api$/, '');
        return `${base}/${avatarUrl}`;
    }

    function errorText(response, fallback) {
        if (response && Array.isArray(response.errors) && response.errors[0] && response.errors[0].msg) return response.errors[0].msg;
        return (response && response.message) || fallback;
    }

    function showMessage(title, text, isError) {
        const box = h('div', `join-message${isError ? ' join-error' : ''}`);
        box.setAttribute('role', isError ? 'alert' : 'status');
        box.appendChild(h('h2', 'join-message-title', title));
        if (text) box.appendChild(h('p', null, text));
        content.replaceChildren(box);
        return box;
    }

    function openChat(chatId) {
        window.location.href = `chat.html?chat=${encodeURIComponent(chatId)}`;
    }

    function renderPreview(code, group) {
        const card = h('div', 'join-preview');

        const avatar = h('div', 'join-avatar');
        const src = avatarSrc(group.avatarUrl);
        if (src) {
            const img = h('img');
            img.src = src;
            img.alt = '';
            avatar.appendChild(img);
        } else {
            avatar.appendChild(h('span', null, (group.chatName || '?').charAt(0).toUpperCase()));
        }
        card.appendChild(avatar);

        card.appendChild(h('h2', 'join-group-name', group.chatName || 'Unnamed group'));
        card.appendChild(h('p', 'join-member-count', `${group.memberCount} member${group.memberCount === 1 ? '' : 's'}`));
        if (group.description) card.appendChild(h('p', 'join-description', group.description));

        const status = h('p', 'join-status');
        status.setAttribute('role', 'status');
        const actions = h('div', 'join-actions');

        if (group.joinState === 'member') {
            status.textContent = 'You are already a member of this group.';
            actions.appendChild(button('Open chat', 'btn-primary', () => openChat(group.chatId)));
        } else if (group.joinState === 'pending') {
            status.textContent = 'Your request to join is waiting for an admin. You\'ll see the group in your chats once it\'s approved.';
        } else {
            if (group.joinState === 'declined') {
                status.textContent = 'An admin declined your earlier request. You can ask again.';
            } else if (group.approvalRequired) {
                status.textContent = 'An admin approves new members of this group.';
            }
            const join = button(group.approvalRequired ? 'Request to join' : 'Join group', 'btn-primary', () => joinGroup(code, join, status));
            actions.appendChild(join);
        }

        card.appendChild(status);
        card.appendChild(actions);
        content.replaceChildren(card);
    }

    async function joinGroup(code, joinButton, status) {
        joinButton.disabled = true;
        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.INVITE_JOIN(code), { method: 'POST' });
            if (!response.success) {
                showMessage('Can\'t join this group', errorText(response, 'This invite link can\'t be used.'), true);
                return;
            }
            if (response.data.status === 'pending') {
                status.textContent = 'Request sent. An admin will review it, and the group will appear in your chats once you\'re approved.';
                joinButton.remove();
                return;
            }
            openChat(response.data.chatId);
        } catch (error) {
            joinButton.disabled = false;
            status.textContent = 'Something went wrong. Please try again.';
        }
    }

    async function init() {
        try {
            if (localStorage.getItem(CONFIG.STORAGE_KEYS.THEME) === 'dark') document.body.classList.add('dark-theme');
        } catch (e) {
            // Default theme
        }

        const code = new URLSearchParams(window.location.search).get('code') || '';
        if (!INVITE_CODE_PATTERN.test(code)) {
            showMessage('Invalid invite link', 'This invite link is invalid. Check that you copied the whole link.', true);
            return;
        }

        // Kept until the preview loads, so an expired session (apiRequest sends 401s to login) comes back here too
        rememberPendingInvite(code);

        if (!isAuthenticated()) {
            window.location.href = `login.html?next=${encodeURIComponent(`join.html?code=${code}`)}`;
            return;
        }

        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.INVITE_PREVIEW(code));
            takePendingInvite();
            if (!response.success) {
                showMessage('Can\'t use this invite link', errorText(response, 'This invite link can\'t be used.'), true);
                return;
            }
            renderPreview(code, response.data);
        } catch (error) {
            showMessage('Connection error', 'Please check your connection and reload the page.', true);
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();
