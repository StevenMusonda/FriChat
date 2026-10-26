/**
 * Notifications Module
 * Push subscription toggle, do-not-disturb / quiet hours, unread badge and title,
 * and opening a chat from a clicked notification
 */

const BASE_TITLE = document.title;
const DEFAULT_QUIET_START = '22:00';
const DEFAULT_QUIET_END = '07:00';
const PERMISSION_DENIED_MESSAGE = 'Notifications are blocked for this site. Click the lock or site info icon next to the address bar, '
    + 'open Site settings, set Notifications to Allow, then reload the page and try again.';

let pushConfig = null;
let notificationSettings = null;

/**
 * Browser can do Web Push at all (iOS only inside the installed app)
 */
function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function browserTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
        return 'UTC';
    }
}

/**
 * VAPID public key -> the byte array pushManager.subscribe expects
 */
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function isBraveBrowser() {
    try {
        return !!(navigator.brave && await navigator.brave.isBrave());
    } catch (e) {
        return false;
    }
}

/**
 * pushManager.subscribe() AbortError ("Registration failed - push service error") -> a message the user can act on
 */
async function pushServiceErrorMessage() {
    return await isBraveBrowser()
        ? 'Your browser blocked the push service. In Brave, open brave://settings/privacy and turn on '
            + "'Use Google Services for Push Messaging', then restart the browser and try again."
        : 'Your browser could not register for push notifications. Check that notifications and push services '
            + 'are allowed in the browser settings.';
}

async function loadPushConfig() {
    if (pushConfig) return pushConfig;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.PUSH_CONFIG);
        pushConfig = response.success ? response.data : { enabled: false, publicKey: null };
    } catch (error) {
        return { enabled: false, publicKey: null }; // Not cached, so a later attempt can retry
    }
    return pushConfig;
}

async function getServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.getRegistration() || await registerServiceWorker();
    if (!registration) return null;
    await navigator.serviceWorker.ready;
    return registration;
}

/**
 * Send this browser's subscription to the server (also re-links it after another account used this browser)
 */
async function saveSubscriptionOnServer(subscription) {
    const { endpoint, keys } = subscription.toJSON();
    const response = await apiRequest(CONFIG.ENDPOINTS.PUSH_SUBSCRIPTIONS, {
        method: 'POST',
        body: JSON.stringify({ endpoint, keys })
    });
    if (!response.success) {
        throw new Error(response.message || 'Could not save the subscription');
    }
}

/**
 * Same VAPID key the subscription was made with? (a server key change makes old subscriptions useless)
 */
function subscriptionMatchesKey(subscription, publicKey) {
    const current = subscription.options && subscription.options.applicationServerKey;
    if (!current || !publicKey) return true;
    const expected = urlBase64ToUint8Array(publicKey);
    const actual = new Uint8Array(current);
    return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}

/**
 * Turn push on. Must start from a click: the permission prompt is requested first,
 * before anything else is awaited, so the browser still sees the user gesture.
 */
async function enablePushNotifications() {
    if (!isPushSupported()) {
        throw new Error(isIosDevice() && !isRunningStandalone()
            ? 'On iPhone and iPad, install FriChat to your Home Screen first, then enable notifications there.'
            : 'This browser does not support push notifications.');
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error(permission === 'denied'
            ? PERMISSION_DENIED_MESSAGE
            : 'Notification permission was not granted.');
    }

    const config = await loadPushConfig();
    if (!config.enabled) {
        throw new Error('Notifications are not set up on this server yet.');
    }

    const registration = await getServiceWorkerRegistration();
    if (!registration) {
        throw new Error('Could not start the background service. Reload the page and try again.');
    }

    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !subscriptionMatchesKey(subscription, config.publicKey)) {
        await subscription.unsubscribe();
        subscription = null;
    }
    if (!subscription) {
        try {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(config.publicKey)
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                console.error('Push subscribe error:', error);
                throw new Error(await pushServiceErrorMessage());
            }
            if (Notification.permission === 'denied') {
                throw new Error(PERMISSION_DENIED_MESSAGE);
            }
            throw error;
        }
    }

    await saveSubscriptionOnServer(subscription);
}

/**
 * Turn push off for this browser
 */
async function disablePushNotifications() {
    const registration = await getServiceWorkerRegistration();
    const subscription = registration && await registration.pushManager.getSubscription();
    if (!subscription) return;

    await apiRequest(CONFIG.ENDPOINTS.PUSH_SUBSCRIPTIONS, {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    await subscription.unsubscribe();
}

async function isPushEnabledHere() {
    if (!isPushSupported() || Notification.permission !== 'granted') return false;
    const registration = await navigator.serviceWorker.getRegistration();
    return !!(registration && await registration.pushManager.getSubscription());
}

/**
 * On page load: if this browser is subscribed, make sure the server has it for the current user
 */
async function syncPushSubscription() {
    try {
        if (!(await isPushEnabledHere())) return;
        const config = await loadPushConfig();
        if (!config.enabled) return;

        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration.pushManager.getSubscription();
        if (subscriptionMatchesKey(subscription, config.publicKey)) {
            await saveSubscriptionOnServer(subscription);
        } else {
            // Server keys changed: the old subscription can't receive anything
            await subscription.unsubscribe();
        }
    } catch (error) {
        console.error('Push sync error:', error);
    }
}

/* ===== Do not disturb ===== */

async function loadNotificationSettings() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.NOTIFICATION_SETTINGS);
        if (response.success) {
            applyNotificationSettings(response.data);
        }
    } catch (error) {
        console.error('Load notification settings error:', error);
    }
}

/**
 * Save some fields; the browser's current timezone always goes along so quiet hours follow the user
 */
async function saveNotificationSettings(changes) {
    const previous = notificationSettings;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.NOTIFICATION_SETTINGS, {
            method: 'PUT',
            body: JSON.stringify({ ...changes, timezone: browserTimezone() })
        });
        if (!response.success) {
            throw new Error(response.message || 'Could not save');
        }
        applyNotificationSettings(response.data);
    } catch (error) {
        console.error('Save notification settings error:', error);
        if (previous) applyNotificationSettings(previous);
        setSettingsStatus('dndStatus', 'Could not save. Check your connection and try again.', true);
    }
}

/**
 * Server-confirmed DND state (from this tab or another one) -> quick toggle and settings panel
 */
function applyNotificationSettings(settings) {
    notificationSettings = settings;

    const quickToggle = document.getElementById('dndQuickToggle');
    if (quickToggle) {
        quickToggle.setAttribute('aria-pressed', settings.dndEnabled ? 'true' : 'false');
        quickToggle.classList.toggle('active', !!settings.dndActive);
        quickToggle.title = settings.dndEnabled
            ? 'Do not disturb is on'
            : settings.dndActive ? 'Quiet hours: notifications paused' : 'Do not disturb';
    }

    const dndToggle = document.getElementById('dndToggle');
    const quietToggle = document.getElementById('quietHoursToggle');
    const quietTimes = document.getElementById('quietHoursTimes');
    const quietStart = document.getElementById('quietStart');
    const quietEnd = document.getElementById('quietEnd');
    if (!dndToggle) return;

    dndToggle.checked = !!settings.dndEnabled;
    quietToggle.checked = !!settings.quietHoursEnabled;
    quietTimes.hidden = !settings.quietHoursEnabled;
    quietStart.value = settings.quietStart || DEFAULT_QUIET_START;
    quietEnd.value = settings.quietEnd || DEFAULT_QUIET_END;
    document.getElementById('quietHoursZone').textContent = settings.timezone || browserTimezone();

    let status = '';
    if (settings.dndEnabled) {
        status = 'Notifications are paused until you turn this off.';
    } else if (settings.dndActive) {
        status = 'Quiet hours are active right now.';
    }
    setSettingsStatus('dndStatus', status);
}

function toggleDndQuick() {
    const enabled = !(notificationSettings && notificationSettings.dndEnabled);
    saveNotificationSettings({ dndEnabled: enabled });
}

/* ===== Settings panel ===== */

function setSettingsStatus(id, text, isError = false) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('error', isError);
}

/**
 * Reflect whether this browser is subscribed, and why the toggle may be unavailable
 */
async function refreshPushToggle() {
    const toggle = document.getElementById('pushToggle');
    if (!toggle) return;

    if (!isPushSupported()) {
        toggle.checked = false;
        toggle.disabled = true;
        setSettingsStatus('pushStatus', isIosDevice() && !isRunningStandalone()
            ? 'On iPhone and iPad, notifications work after you add FriChat to your Home Screen.'
            : 'This browser does not support push notifications.');
        return;
    }

    const config = await loadPushConfig();
    if (!config.enabled) {
        toggle.checked = false;
        toggle.disabled = true;
        setSettingsStatus('pushStatus', 'Notifications are not set up on this server yet.');
        return;
    }

    toggle.disabled = false;
    toggle.checked = await isPushEnabledHere();

    if (Notification.permission === 'denied') {
        setSettingsStatus('pushStatus', PERMISSION_DENIED_MESSAGE, true);
    } else {
        setSettingsStatus('pushStatus', toggle.checked
            ? 'You will be notified about new messages when FriChat is closed or in the background.'
            : 'Get notified about new messages when FriChat is closed.');
    }
}

function refreshInstallSection() {
    const installBtn = document.getElementById('installAppBtn');
    const iosNote = document.getElementById('iosInstallNote');
    const hint = document.getElementById('installHint');
    if (!installBtn) return;

    const standalone = isRunningStandalone();
    const showIosNote = isIosDevice() && !standalone;

    installBtn.hidden = standalone || !canPromptInstall();
    iosNote.hidden = !showIosNote;

    if (standalone) {
        hint.textContent = 'FriChat is installed on this device.';
    } else if (canPromptInstall()) {
        hint.textContent = 'Open FriChat in its own window, like a native app.';
    } else if (showIosNote) {
        hint.textContent = 'Add FriChat to your Home Screen.';
    } else {
        hint.textContent = 'Use your browser menu to install FriChat, if it offers it.';
    }
}

function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    modal.style.display = 'flex';
    refreshPushToggle();
    refreshInstallSection();
    loadNotificationSettings();
    document.getElementById('closeSettingsModal').focus();
}

function closeSettingsModal() {
    document.getElementById('settingsModal').style.display = 'none';
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.focus();
}

function initializeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const settingsBtn = document.getElementById('settingsBtn');
    if (!modal || !settingsBtn) return;

    settingsBtn.addEventListener('click', openSettingsModal);
    document.getElementById('closeSettingsModal').addEventListener('click', closeSettingsModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeSettingsModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') closeSettingsModal();
    });

    // Enable notifications: permission is only ever requested from this click
    const pushToggle = document.getElementById('pushToggle');
    pushToggle.addEventListener('change', async () => {
        const wantEnabled = pushToggle.checked;
        pushToggle.disabled = true;
        setSettingsStatus('pushStatus', wantEnabled ? 'Turning on…' : 'Turning off…');
        try {
            if (wantEnabled) {
                await enablePushNotifications();
            } else {
                await disablePushNotifications();
            }
            await refreshPushToggle();
        } catch (error) {
            console.error('Push toggle error:', error);
            pushToggle.checked = !wantEnabled;
            pushToggle.disabled = false;
            setSettingsStatus('pushStatus', error.message || 'Something went wrong. Please try again.', true);
        }
    });

    document.getElementById('dndToggle').addEventListener('change', (e) => {
        saveNotificationSettings({ dndEnabled: e.target.checked });
    });

    document.getElementById('quietHoursToggle').addEventListener('change', (e) => {
        const quietStart = document.getElementById('quietStart').value || DEFAULT_QUIET_START;
        const quietEnd = document.getElementById('quietEnd').value || DEFAULT_QUIET_END;
        document.getElementById('quietHoursTimes').hidden = !e.target.checked;
        saveNotificationSettings({ quietHoursEnabled: e.target.checked, quietStart, quietEnd });
    });

    ['quietStart', 'quietEnd'].forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => {
            // Some browsers allow clearing a time input; keep the saved value then
            if (!/^\d{2}:\d{2}$/.test(e.target.value)) {
                if (notificationSettings) applyNotificationSettings(notificationSettings);
                return;
            }
            saveNotificationSettings({ [id]: e.target.value });
        });
    });

    document.getElementById('installAppBtn').addEventListener('click', async () => {
        await promptInstall();
        refreshInstallSection();
    });
    onInstallStateChange(refreshInstallSection);
}

/* ===== Unread badge and title ===== */

/**
 * Unread total (muted chats don't count) on the app icon and in the tab title
 */
function updateUnreadIndicators(chats) {
    const total = chats
        .filter(chat => !chat.is_muted)
        .reduce((sum, chat) => sum + (parseInt(chat.unread_count) || 0), 0);

    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${BASE_TITLE}` : BASE_TITLE;

    if ('setAppBadge' in navigator) {
        const update = total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge();
        update.catch(() => {
            // Badging is best effort (e.g. not installed)
        });
    }
}

/* ===== Notification clicks ===== */

/**
 * Open a chat by id, only if it's one of the user's chats
 */
async function openChatFromNotification(chatId) {
    if (!chatId) return;
    if (!allChats.some(chat => chat.id === chatId)) {
        await loadChats();
    }
    if (allChats.some(chat => chat.id === chatId)) {
        openChat(chatId);
    }
}

/**
 * chat.html?chat=12 (from a notification opening a new window): take the id and tidy the URL
 */
function takeRequestedChatId() {
    const params = new URLSearchParams(window.location.search);
    const chatId = parseInt(params.get('chat'));
    if (params.has('chat')) {
        params.delete('chat');
        const query = params.toString();
        history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    }
    return chatId > 0 ? chatId : null;
}

/**
 * Wire everything up (chat page)
 */
function initializeNotifications() {
    initializeSettingsModal();

    const quickToggle = document.getElementById('dndQuickToggle');
    if (quickToggle) {
        quickToggle.addEventListener('click', toggleDndQuick);
    }

    onNotificationSettings(applyNotificationSettings);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'open-chat') {
                openChatFromNotification(parseInt(event.data.chatId));
            }
        });
    }

    loadNotificationSettings();
    syncPushSubscription();
}
