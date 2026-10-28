/**
 * PWA Module
 * Registers the service worker, keeps the browser theme color in step with the app theme,
 * and holds the "Install app" prompt for the settings panel
 */

let deferredInstallPrompt = null;
const installStateHandlers = [];

const THEME_COLORS = { light: '#667eea', dark: '#1a202c' };

/**
 * Register sw.js (same folder as the pages, so its scope covers the whole frontend)
 */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);

    return navigator.serviceWorker.register('sw.js').catch(error => {
        console.error('Service worker registration failed:', error);
        return null;
    });
}

/**
 * Installed app / added to home screen
 */
function isRunningStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

/**
 * iPhone/iPad (iPadOS reports itself as a Mac with touch)
 */
function isIosDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * True when the browser offered an install prompt we can show from a click
 */
function canPromptInstall() {
    return !!deferredInstallPrompt;
}

/**
 * Show the browser's install dialog. Resolves to 'accepted', 'dismissed' or 'unavailable'.
 */
async function promptInstall() {
    if (!deferredInstallPrompt) return 'unavailable';

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null; // Each prompt can only be used once
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    notifyInstallState();
    return outcome;
}

/**
 * Register a handler for "install prompt became available / was used"
 */
function onInstallStateChange(handler) {
    installStateHandlers.push(handler);
}

function notifyInstallState() {
    installStateHandlers.forEach(handler => handler());
}

/**
 * On logout: forget this browser's push subscription on the server and in the browser,
 * and clear the app badge. Uses fetch directly (not apiRequest) so a 401 can't loop back
 * into logout(). Gives up after a few seconds so logging out never hangs.
 */
async function cleanupPushOnLogout() {
    const cleanup = (async () => {
        if (!('serviceWorker' in navigator)) return;
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration && registration.pushManager
            ? await registration.pushManager.getSubscription()
            : null;

        if (subscription) {
            // In-memory access token (auth.js); refreshed if it has expired
            const token = typeof getAccessToken === 'function' ? await getAccessToken() : null;
            if (token) {
                await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.PUSH_SUBSCRIPTIONS}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ endpoint: subscription.endpoint })
                }).catch(() => {
                    // The server also drops it the first time the push service answers 410
                });
            }
            await subscription.unsubscribe();
        }

        if ('clearAppBadge' in navigator) {
            await navigator.clearAppBadge().catch(() => {});
        }
    })();

    const timeout = new Promise(resolve => setTimeout(resolve, 3000));
    await Promise.race([cleanup.catch(error => console.error('Push cleanup error:', error)), timeout]);
}

/**
 * Status bar / title bar color follows the in-app theme, not just the OS setting
 */
function syncThemeColor() {
    const color = document.body.classList.contains('dark-theme') ? THEME_COLORS.dark : THEME_COLORS.light;
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
        meta.setAttribute('content', color);
    });
}

window.addEventListener('beforeinstallprompt', (event) => {
    // Keep it for the "Install app" button instead of the browser's mini-infobar
    event.preventDefault();
    deferredInstallPrompt = event;
    notifyInstallState();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    notifyInstallState();
});

document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();

    // Pages that remember a dark theme set the class on load; the theme toggle flips it later
    syncThemeColor();
    new MutationObserver(syncThemeColor).observe(document.body, { attributes: true, attributeFilter: ['class'] });
});
