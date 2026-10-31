/**
 * Settings > Security: two-factor authentication, security activity, data export and account deletion,
 * and the change-email form under Settings > Profile.
 * Everything from the server goes in with textContent, never innerHTML. Recovery codes live only in
 * this page's DOM while they are on screen; nothing here stores them.
 */

(function (FriChat) {

const QR_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

// Filled by loadAccountSettings; the forms ask for a code only when it's on
let twoFactorEnabled = false;
let activityCursor = null;

const ACTIVITY_LABELS = {
    login: 'Signed in',
    login_failed: 'Failed sign-in (wrong password)',
    password_changed: 'Password changed',
    password_reset: 'Password reset by email',
    session_revoked: 'A device was signed out',
    email_changed: 'Email address changed',
    '2fa_enabled': 'Two-factor authentication turned on',
    '2fa_disabled': 'Two-factor authentication turned off',
    '2fa_login_failed': 'Failed sign-in (wrong code)',
    '2fa_locked': 'Sign-in locked after too many wrong codes',
    '2fa_recovery_used': 'Recovery code used',
    '2fa_recovery_regenerated': 'New recovery codes generated',
    '2fa_reset_by_operator': 'Two-factor authentication turned off by an administrator',
    data_export_requested: 'Data export requested',
    data_export_downloaded: 'Data export downloaded',
    account_deletion_requested: 'Account deletion requested',
    account_deletion_cancelled: 'Account deletion cancelled'
};

const EXPORT_STATUS_LABELS = {
    pending: 'Waiting to start…',
    running: 'Being prepared…',
    failed: 'This export failed. You can ask for a new one.',
    expired: 'Expired'
};

const byId = (id) => document.getElementById(id);

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function button(label, className, onClick) {
    const node = el('button', `btn ${className} btn-small`, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function setStatus(id, text, isError = false) {
    const node = byId(id);
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
}

function responseMessage(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors[0] && response.errors[0].msg) return response.errors[0].msg;
    return (response && response.message) || fallback;
}

function field(labelText, attrs) {
    const label = el('label', null, labelText);
    const input = document.createElement('input');
    Object.assign(input, attrs);
    label.appendChild(input);
    return { label, input };
}

const passwordField = () => field('Password', { type: 'password', autocomplete: 'current-password', required: true });
const codeField = () => field('Code from your authenticator app, or a recovery code', { type: 'text', autocomplete: 'one-time-code', inputMode: 'text', maxLength: 32, required: true });

function panelForm(onSubmit, ...children) {
    const form = el('form', 'settings-form');
    form.noValidate = true;
    form.append(...children);
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        onSubmit();
    });
    return form;
}

function submitRow(label, className = 'btn-primary') {
    const row = el('div', 'settings-button-row');
    const submit = el('button', `btn ${className} btn-small`, label);
    submit.type = 'submit';
    row.append(submit, button('Cancel', 'btn-secondary', closeTwoFactorPanel));
    return { row, submit };
}

// ===== Two-factor authentication =====

function twoFactorPanel() {
    return byId('twoFactorPanel');
}

function showTwoFactorPanel(...children) {
    const panel = twoFactorPanel();
    panel.replaceChildren(...children);
    panel.hidden = false;
    const input = panel.querySelector('input');
    if (input) input.focus();
}

function closeTwoFactorPanel() {
    const panel = twoFactorPanel();
    panel.replaceChildren(); // recovery codes and the setup key leave the page here
    panel.hidden = true;
    setStatus('twoFactorStatus', '');
}

function renderTwoFactorState(status) {
    twoFactorEnabled = !!status.enabled;
    byId('twoFactorState').textContent = status.enabled ? 'On' : 'Off';

    const user = getCurrentUser() || {};
    let hint = 'A code from an app on your phone, on top of your password, each time you sign in.';
    if (status.enabled) hint = `Recovery codes left: ${status.recoveryCodesLeft}.`;
    else if (user.isAdmin) hint = 'The admin console needs this.';
    if (!status.enabled && !status.available) hint = 'This server isn\'t set up for it yet.';
    byId('twoFactorHint').textContent = hint;

    byId('twoFactorStartBtn').hidden = status.enabled || !status.available;
    byId('twoFactorManage').hidden = !status.enabled;
    updateCodeFields();
}

async function loadTwoFactorStatus() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.TWO_FACTOR);
        if (response.success) renderTwoFactorState(response.data);
        else setStatus('twoFactorStatus', responseMessage(response, 'Could not load this'), true);
    } catch (error) {
        setStatus('twoFactorStatus', 'Could not load this', true);
    }
}

function startSetup() {
    const password = passwordField();
    const { row, submit } = submitRow('Continue');
    const form = panelForm(async () => {
        submit.disabled = true;
        setStatus('twoFactorStatus', '');
        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.TWO_FACTOR_SETUP, {
                method: 'POST',
                body: JSON.stringify({ password: password.input.value })
            });
            if (response.success) showSetupKey(response.data);
            else setStatus('twoFactorStatus', responseMessage(response, 'Could not start setup'), true);
        } catch (error) {
            setStatus('twoFactorStatus', 'Could not start setup', true);
        } finally {
            submit.disabled = false;
        }
    }, el('p', 'settings-row-hint', 'Enter your password to start.'), password.label, row);
    showTwoFactorPanel(form);
}

function showSetupKey(data) {
    const steps = el('p', 'settings-row-hint', 'Scan this with an authenticator app (Google Authenticator, Authy, 1Password…), then enter the code it shows.');

    const qr = document.createElement('img');
    qr.className = 'two-factor-qr';
    qr.alt = 'QR code for your authenticator app';
    if (QR_DATA_URL.test(data.qrCode)) qr.src = data.qrCode;

    const manual = el('p', 'settings-row-hint', 'Can\'t scan it? Enter this key by hand:');
    const key = el('code', 'two-factor-key', data.secret.match(/.{1,4}/g).join(' '));

    const code = field('6-digit code', { type: 'text', autocomplete: 'one-time-code', inputMode: 'numeric', maxLength: 6, required: true });
    const { row, submit } = submitRow('Turn on');
    const form = panelForm(async () => {
        submit.disabled = true;
        setStatus('twoFactorStatus', '');
        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.TWO_FACTOR_CONFIRM, {
                method: 'POST',
                body: JSON.stringify({ code: code.input.value })
            });
            if (response.success) {
                markTwoFactor(true);
                showRecoveryCodes(response.data.recoveryCodes, 'Two-factor authentication is on.');
                loadTwoFactorStatus();
                loadActivity();
            } else {
                setStatus('twoFactorStatus', responseMessage(response, 'That code didn\'t work'), true);
            }
        } catch (error) {
            setStatus('twoFactorStatus', 'That code didn\'t work', true);
        } finally {
            submit.disabled = false;
        }
    }, code.label, row);

    showTwoFactorPanel(steps, qr, manual, key, form);
}

function showRecoveryCodes(codes, heading) {
    const intro = el('p', 'settings-row-title', heading);
    const warning = el('p', 'settings-note', 'Save these recovery codes somewhere safe. Each works once if you lose your phone, and this is the only time you\'ll see them.');

    const list = el('ol', 'recovery-codes');
    codes.forEach(code => list.appendChild(el('li', null, code)));

    const text = () => codes.join('\n');
    const actions = el('div', 'settings-button-row');
    actions.append(
        button('Copy', 'btn-secondary', async () => {
            try {
                await navigator.clipboard.writeText(text());
                setStatus('twoFactorStatus', 'Copied.');
            } catch (error) {
                setStatus('twoFactorStatus', 'Could not copy. Select the codes instead.', true);
            }
        }),
        button('Download', 'btn-secondary', () => {
            const url = URL.createObjectURL(new Blob([`FriChat recovery codes\n\n${text()}\n`], { type: 'text/plain' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'frichat-recovery-codes.txt';
            link.click();
            URL.revokeObjectURL(url);
        }),
        button('I\'ve saved them', 'btn-primary', closeTwoFactorPanel)
    );
    showTwoFactorPanel(intro, warning, list, actions);
}

function reauthForm(buttonLabel, buttonClass, endpoint, onDone) {
    const password = passwordField();
    const code = codeField();
    const { row, submit } = submitRow(buttonLabel, buttonClass);
    return panelForm(async () => {
        submit.disabled = true;
        setStatus('twoFactorStatus', '');
        try {
            const response = await apiRequest(endpoint, {
                method: 'POST',
                body: JSON.stringify({ password: password.input.value, code: code.input.value })
            });
            if (response.success) await onDone(response);
            else setStatus('twoFactorStatus', responseMessage(response, 'That didn\'t work'), true);
        } catch (error) {
            setStatus('twoFactorStatus', 'That didn\'t work', true);
        } finally {
            submit.disabled = false;
        }
    }, password.label, code.label, row);
}

function startDisable() {
    showTwoFactorPanel(reauthForm('Turn off', 'btn-danger', CONFIG.ENDPOINTS.TWO_FACTOR_DISABLE, async (response) => {
        markTwoFactor(false);
        closeTwoFactorPanel();
        setStatus('twoFactorStatus', response.message);
        await loadTwoFactorStatus();
        loadActivity();
    }));
}

function startRegenerate() {
    showTwoFactorPanel(reauthForm('Generate new codes', 'btn-primary', CONFIG.ENDPOINTS.TWO_FACTOR_RECOVERY_CODES, async (response) => {
        showRecoveryCodes(response.data.recoveryCodes, 'Your old recovery codes no longer work.');
        await loadTwoFactorStatus();
        loadActivity();
    }));
}

function markTwoFactor(enabled) {
    twoFactorEnabled = enabled;
    const user = getCurrentUser();
    if (!user) return;
    user.twoFactorEnabled = enabled;
    try {
        localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(user));
    } catch (error) {
        // Only a hint
    }
}

// The change-email and delete forms ask for a code only when 2FA is on
function updateCodeFields() {
    document.querySelectorAll('[data-needs-2fa]').forEach((node) => {
        node.hidden = !twoFactorEnabled;
    });
}

// ===== Security activity =====

function renderActivity(entry) {
    const item = el('li', 'device-item');
    const info = el('div', 'device-info');
    info.appendChild(el('div', 'device-name', ACTIVITY_LABELS[entry.event] || 'Account activity'));
    const details = [formatTime(entry.createdAt)];
    if (entry.device) details.push(entry.device);
    if (entry.ipAddress) details.push(`IP ${entry.ipAddress}`);
    info.appendChild(el('div', 'device-meta', details.filter(Boolean).join(' · ')));
    item.appendChild(info);
    return item;
}

async function loadActivity({ more = false } = {}) {
    const list = byId('securityActivityList');
    if (!list) return;
    try {
        const query = more && activityCursor ? `?before=${encodeURIComponent(activityCursor)}` : '';
        const response = await apiRequest(`${CONFIG.ENDPOINTS.SECURITY_ACTIVITY}${query}`);
        if (!response.success) {
            setStatus('securityActivityStatus', responseMessage(response, 'Could not load your activity'), true);
            return;
        }
        const rows = response.data.entries.map(renderActivity);
        if (more) list.append(...rows);
        else list.replaceChildren(...rows);

        activityCursor = response.data.nextCursor;
        byId('securityActivityMore').hidden = !activityCursor;
        setStatus('securityActivityStatus', list.children.length ? '' : 'Nothing yet.');
    } catch (error) {
        setStatus('securityActivityStatus', 'Could not load your activity', true);
    }
}

// ===== Data export =====

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadExport(exportId, trigger) {
    trigger.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.ACCOUNT_EXPORT_LINK(exportId), { method: 'POST' });
        if (!response.success) {
            setStatus('exportStatus', responseMessage(response, 'Could not start the download'), true);
            return;
        }
        const link = document.createElement('a');
        link.href = `${CONFIG.API_BASE_URL}${response.data.path}`;
        link.rel = 'noopener';
        link.click();
    } catch (error) {
        setStatus('exportStatus', 'Could not start the download', true);
    } finally {
        trigger.disabled = false;
    }
}

function renderExport(item) {
    const row = el('li', 'device-item');
    const info = el('div', 'device-info');
    info.appendChild(el('div', 'device-name', `Requested ${formatTime(item.requestedAt)}`));

    if (item.status === 'ready') {
        const expires = item.expiresAt ? `Available until ${new Date(item.expiresAt).toLocaleString()}` : '';
        info.appendChild(el('div', 'device-meta', [formatBytes(item.fileSize), expires].filter(Boolean).join(' · ')));
        row.appendChild(info);
        row.appendChild(button('Download', 'btn-primary', (event) => downloadExport(item.id, event.target)));
    } else {
        info.appendChild(el('div', 'device-meta', EXPORT_STATUS_LABELS[item.status] || item.status));
        row.appendChild(info);
    }
    return row;
}

async function loadExports() {
    const list = byId('exportList');
    if (!list) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.ACCOUNT_EXPORTS);
        if (response.success) list.replaceChildren(...response.data.map(renderExport));
        else setStatus('exportStatus', responseMessage(response, 'Could not load your exports'), true);
    } catch (error) {
        setStatus('exportStatus', 'Could not load your exports', true);
    }
}

async function requestExport(trigger) {
    trigger.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.ACCOUNT_EXPORTS, { method: 'POST' });
        setStatus('exportStatus', responseMessage(response, 'Could not request an export'), !response.success);
        await loadExports();
    } catch (error) {
        setStatus('exportStatus', 'Could not request an export', true);
    } finally {
        trigger.disabled = false;
    }
}

// ===== Change email =====

async function submitEmailChange(event) {
    event.preventDefault();
    const newEmail = byId('changeEmailAddress');
    const password = byId('changeEmailPassword');
    const code = byId('changeEmailCode');
    const submit = byId('changeEmailBtn');

    submit.disabled = true;
    setStatus('changeEmailStatus', '');
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.CHANGE_EMAIL, {
            method: 'PUT',
            body: JSON.stringify({ newEmail: newEmail.value, password: password.value, code: code.value })
        });
        setStatus('changeEmailStatus', responseMessage(response, 'Could not change your email'), !response.success);
        if (response.success) {
            [newEmail, password, code].forEach((input) => { input.value = ''; });
            await getProfile();
            if (FriChat.refreshEmailUi) FriChat.refreshEmailUi();
        }
    } catch (error) {
        setStatus('changeEmailStatus', 'Could not change your email', true);
    } finally {
        submit.disabled = false;
    }
}

// ===== Delete account =====

async function submitDeletion(event) {
    event.preventDefault();
    const password = byId('deleteAccountPassword');
    const code = byId('deleteAccountCode');
    const submit = byId('deleteAccountBtn');

    if (!window.confirm('Delete your account? You\'ll be signed out everywhere. Sign in within 14 days to cancel.')) return;

    submit.disabled = true;
    setStatus('deleteAccountStatus', '');
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.ACCOUNT_DELETE, {
            method: 'POST',
            body: JSON.stringify({ password: password.value, code: code.value })
        });
        if (response.success) {
            handleSessionEnded('deletion');
            return;
        }
        setStatus('deleteAccountStatus', responseMessage(response, 'Could not delete your account'), true);
    } catch (error) {
        setStatus('deleteAccountStatus', 'Could not delete your account', true);
    } finally {
        submit.disabled = false;
    }
}

// ===== Start =====

function loadAccountSettings() {
    closeTwoFactorPanel();
    loadTwoFactorStatus();
    loadActivity();
    loadExports();
}

/**
 * Something login.html wants said once the app is open (see rememberAccountNotice in auth.js)
 */
function showPendingNotice() {
    try {
        const notice = sessionStorage.getItem(CONFIG.STORAGE_KEYS.ACCOUNT_NOTICE);
        sessionStorage.removeItem(CONFIG.STORAGE_KEYS.ACCOUNT_NOTICE);
        if (notice) showNotification(notice, 'info');
    } catch (error) {
        // Storage unavailable: only a courtesy
    }
}

/**
 * ?settings=security, the link in the "your export is ready" email
 */
function openFromLink() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('settings') !== 'security') return;
    window.history.replaceState(null, '', window.location.pathname);
    const settingsBtn = byId('settingsBtn');
    if (settingsBtn) settingsBtn.click();
    if (typeof window.openSettingsTab === 'function') window.openSettingsTab('security');
}

function initializeAccount() {
    const settingsBtn = byId('settingsBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', loadAccountSettings);

    byId('twoFactorStartBtn').addEventListener('click', startSetup);
    byId('twoFactorDisableBtn').addEventListener('click', startDisable);
    byId('twoFactorRegenerateBtn').addEventListener('click', startRegenerate);
    byId('securityActivityMore').addEventListener('click', () => loadActivity({ more: true }));

    const exportBtn = byId('requestExportBtn');
    exportBtn.addEventListener('click', () => requestExport(exportBtn));

    byId('changeEmailForm').addEventListener('submit', submitEmailChange);
    byId('deleteAccountForm').addEventListener('submit', submitDeletion);

    const user = getCurrentUser();
    twoFactorEnabled = !!(user && user.twoFactorEnabled);
    updateCodeFields();

    showPendingNotice();
    openFromLink();
}

Object.assign(FriChat, { initializeAccount });
})(globalThis.FriChat = globalThis.FriChat || {});
