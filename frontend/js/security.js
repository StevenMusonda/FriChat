/**
 * Security Module
 * Email verification banner, Settings > Email / Change password / Devices / Blocked users,
 * Block/Unblock (used by the chat menu and the group members panel) and rate-limit notices.
 * Everything from the server is put into the page with textContent, never innerHTML.
 */

(function (FriChat) {

// Users this user has blocked (ids), for menus and the members panel
const blockedUserIds = new Set();

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function actionButton(label, className, onClick) {
    const node = el('button', `btn ${className} btn-small`, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function setStatus(id, text, isError = false) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
}

function responseMessage(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors[0] && response.errors[0].msg) return response.errors[0].msg;
    return (response && response.message) || fallback;
}

// ===== Email verification =====

function isEmailVerified() {
    const user = getCurrentUser();
    return !!(user && user.emailVerified);
}

function updateVerificationUi() {
    const user = getCurrentUser() || {};
    const verified = isEmailVerified();

    const banner = document.getElementById('verifyBanner');
    if (banner) banner.hidden = verified;

    const address = document.getElementById('emailAddress');
    if (address) address.textContent = user.email || '';
    setStatus('emailVerifyStatus', verified ? 'Verified' : 'Not verified yet - check your inbox for the link.', !verified);
    const resend = document.getElementById('resendVerificationBtn');
    if (resend) resend.hidden = verified;
}

async function resendVerificationEmail(button) {
    if (button) button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.RESEND_VERIFICATION, { method: 'POST' });
        if (response.code === 'ALREADY_VERIFIED') {
            markEmailVerified();
        }
        showNotification(responseMessage(response, 'Could not send the email'), response.success ? 'info' : 'error');
    } catch (error) {
        showNotification('Could not send the email', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

function markEmailVerified() {
    const user = getCurrentUser();
    if (user) {
        user.emailVerified = true;
        try {
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(user));
        } catch (e) {
            // Only a hint
        }
    }
    updateVerificationUi();
}

// ===== Change password =====

async function submitPasswordChange(event) {
    event.preventDefault();
    const current = document.getElementById('currentPassword');
    const next = document.getElementById('newPassword');
    const confirm = document.getElementById('confirmNewPassword');
    const button = document.getElementById('changePasswordBtn');

    if (!current.value) return setStatus('changePasswordStatus', 'Enter your current password.', true);
    if (next.value.length < 6) return setStatus('changePasswordStatus', 'The new password must be at least 6 characters.', true);
    if (next.value !== confirm.value) return setStatus('changePasswordStatus', 'The new passwords do not match.', true);

    button.disabled = true;
    setStatus('changePasswordStatus', 'Changing…');
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.CHANGE_PASSWORD, {
            method: 'PUT',
            body: JSON.stringify({ currentPassword: current.value, newPassword: next.value })
        });
        if (!response.success) {
            setStatus('changePasswordStatus', responseMessage(response, 'Could not change the password.'), true);
            return;
        }
        [current, next, confirm].forEach(input => { input.value = ''; });
        setStatus('changePasswordStatus', response.message || 'Password changed.');
        loadDevices();
    } catch (error) {
        setStatus('changePasswordStatus', 'Something went wrong. Please try again.', true);
    } finally {
        button.disabled = false;
    }
}

// ===== Devices =====

function renderDevice(session) {
    const item = el('li', `device-item${session.current ? ' current' : ''}`);
    const info = el('div', 'device-info');

    const title = el('div', 'device-name', session.device || 'Unknown device');
    if (session.current) title.appendChild(el('span', 'device-current', 'This device'));
    info.appendChild(title);

    const details = [];
    if (session.lastActiveAt) details.push(`Last active ${formatTime(session.lastActiveAt)}`);
    if (session.ipAddress) details.push(`IP ${session.ipAddress}`);
    info.appendChild(el('div', 'device-meta', details.join(' · ')));
    if (session.createdAt) {
        info.appendChild(el('div', 'device-meta', `Signed in ${new Date(session.createdAt).toLocaleDateString()}`));
    }
    item.appendChild(info);

    item.appendChild(actionButton(session.current ? 'Log out this device' : 'Log out', 'btn-secondary', async (e) => {
        if (session.current) {
            logout();
            return;
        }
        e.target.disabled = true;
        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.SESSION(session.id), { method: 'DELETE' });
            setStatus('devicesStatus', responseMessage(response, 'Could not sign the device out'), !response.success);
        } catch (error) {
            setStatus('devicesStatus', 'Could not sign the device out', true);
        }
        loadDevices();
    }));
    return item;
}

async function loadDevices() {
    const list = document.getElementById('deviceList');
    if (!list) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.SESSIONS);
        if (!response.success) {
            setStatus('devicesStatus', responseMessage(response, 'Could not load your devices'), true);
            return;
        }
        list.replaceChildren(...response.data.map(renderDevice));
        const others = response.data.filter(s => !s.current).length;
        const revokeOthers = document.getElementById('revokeOtherSessionsBtn');
        if (revokeOthers) revokeOthers.hidden = others === 0;
    } catch (error) {
        setStatus('devicesStatus', 'Could not load your devices', true);
    }
}

async function revokeOtherSessions(button) {
    button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.REVOKE_OTHER_SESSIONS, { method: 'POST' });
        setStatus('devicesStatus', responseMessage(response, 'Could not sign out other devices'), !response.success);
    } catch (error) {
        setStatus('devicesStatus', 'Could not sign out other devices', true);
    } finally {
        button.disabled = false;
    }
    loadDevices();
}

// ===== Blocking =====

function isUserBlocked(userId) {
    return blockedUserIds.has(Number(userId));
}

function renderBlockedUser(user) {
    const item = el('li', 'blocked-item');
    const info = el('div', 'device-info');
    info.appendChild(el('div', 'device-name', user.fullName || user.username));
    info.appendChild(el('div', 'device-meta', `@${user.username}`));
    item.appendChild(info);
    item.appendChild(actionButton('Unblock', 'btn-secondary', () => setUserBlocked(user.id, false, user.fullName || user.username)));
    return item;
}

async function loadBlockedUsers() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.BLOCKS);
        if (!response.success) {
            setStatus('blockedStatus', responseMessage(response, 'Could not load blocked users'), true);
            return;
        }
        blockedUserIds.clear();
        response.data.forEach(user => blockedUserIds.add(Number(user.id)));

        const list = document.getElementById('blockedList');
        if (list) {
            list.replaceChildren(...response.data.map(renderBlockedUser));
            setStatus('blockedStatus', response.data.length ? '' : 'You haven\'t blocked anyone.');
        }
    } catch (error) {
        setStatus('blockedStatus', 'Could not load blocked users', true);
    }
}

/**
 * Block or unblock a user, then refresh everything that depends on it
 */
async function setUserBlocked(userId, block, displayName) {
    const name = displayName || 'this user';
    if (block && !window.confirm(`Block ${name}? They won't be able to message you or add you to groups, and won't see when you're online.`)) {
        return;
    }
    try {
        const response = block
            ? await apiRequest(CONFIG.ENDPOINTS.BLOCKS, { method: 'POST', body: JSON.stringify({ userId: Number(userId) }) })
            : await apiRequest(CONFIG.ENDPOINTS.BLOCK(userId), { method: 'DELETE' });
        if (!response.success) {
            showNotification(responseMessage(response, block ? 'Could not block the user' : 'Could not unblock the user'), 'error');
            return;
        }
        showNotification(block ? `${name} is blocked` : `${name} is unblocked`, 'info');
        await afterBlockChange();
    } catch (error) {
        showNotification(block ? 'Could not block the user' : 'Could not unblock the user', 'error');
    }
}

async function afterBlockChange() {
    await loadBlockedUsers();
    // The open chat's composer lock and the group panel's buttons depend on it
    if (typeof currentChatId !== 'undefined' && currentChatId) {
        if (typeof FriChat.groupInfoModalOpen === 'function' && FriChat.groupInfoModalOpen()) FriChat.refreshGroupInfo();
        if (typeof loadChatDetails === 'function') loadChatDetails(currentChatId);
    }
}

// ===== Settings modal and live events =====

function loadSecuritySettings() {
    updateVerificationUi();
    loadDevices();
    loadBlockedUsers();
    // The server knows best whether the email was verified meanwhile (e.g. in another browser)
    getProfile().then(updateVerificationUi);
}

const RATE_LIMIT_MESSAGES = {
    send_message: 'You\'re sending messages too fast. Please wait a moment.',
    add_reaction: 'Slow down with reactions for a moment.',
    remove_reaction: 'Slow down with reactions for a moment.'
};

function initializeSecurity() {
    updateVerificationUi();
    loadBlockedUsers();

    const bannerResend = document.getElementById('verifyBannerResend');
    if (bannerResend) bannerResend.addEventListener('click', () => resendVerificationEmail(bannerResend));
    const settingsResend = document.getElementById('resendVerificationBtn');
    if (settingsResend) settingsResend.addEventListener('click', () => resendVerificationEmail(settingsResend));

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', loadSecuritySettings);

    const passwordForm = document.getElementById('changePasswordForm');
    if (passwordForm) passwordForm.addEventListener('submit', submitPasswordChange);

    const revokeOthers = document.getElementById('revokeOtherSessionsBtn');
    if (revokeOthers) revokeOthers.addEventListener('click', () => revokeOtherSessions(revokeOthers));

    onAccountEvent((event) => {
        if (event === 'email_verified') {
            markEmailVerified();
            showNotification('Your email address is verified', 'info');
        } else if (event === 'block_updated') {
            afterBlockChange();
        }
    });

    onRateLimited((data) => {
        if (data.disconnected) {
            showNotification('Too many requests - reconnecting…', 'error');
            return;
        }
        const message = RATE_LIMIT_MESSAGES[data.event];
        if (message) showNotification(message, 'error');
    });
}

window.setUserBlocked = setUserBlocked;
window.isUserBlocked = isUserBlocked;

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    isUserBlocked,
    setUserBlocked,
    initializeSecurity
});
})(globalThis.FriChat = globalThis.FriChat || {});
