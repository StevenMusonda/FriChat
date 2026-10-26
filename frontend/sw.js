/**
 * FriChat service worker: app shell cache, offline fallback, Web Push
 *
 * Bump CACHE_VERSION whenever HTML/CSS/JS change, so installed apps pick up the new shell.
 * API responses are never cached.
 */

const CACHE_VERSION = 'frichat-shell-v3';

const APP_SHELL = [
    'chat.html',
    'login.html',
    'signup.html',
    'forgot-password.html',
    'reset-password.html',
    'offline.html',
    'manifest.webmanifest',
    'css/style.css',
    'js/config.js',
    'js/auth.js',
    'js/websocket.js',
    'js/chat.js',
    'js/messages.js',
    'js/messageActions.js',
    'js/ui.js',
    'js/pwa.js',
    'js/notifications.js',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/badge-96.png',
    'icons/favicon-32.png'
];

const OFFLINE_PAGE = 'offline.html';

// Resolve against the worker's folder, so the app works under any path (e.g. /FriChat/frontend/)
const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then(cache => cache.addAll(APP_SHELL.map(path => new Request(scoped(path), { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith('frichat-') && key !== CACHE_VERSION)
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // API (any origin): network first, never cached; answer with JSON when offline
    if (url.pathname.includes('/api/')) {
        event.respondWith(fetch(request).catch(() => new Response(
            JSON.stringify({ success: false, message: 'You are offline' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
        )));
        return;
    }

    // Socket.IO, uploads, CDNs: leave to the browser
    if (url.origin !== self.location.origin || request.headers.has('Authorization')) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirstPage(request));
        return;
    }

    event.respondWith(staleWhileRevalidate(request));
});

/**
 * Pages: fresh from the network when online, cached copy (or the offline page) otherwise
 */
async function networkFirstPage(request) {
    const cache = await caches.open(CACHE_VERSION);
    try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
            // Stored without the query string (chat.html?chat=5 -> chat.html)
            const url = new URL(request.url);
            cache.put(url.origin + url.pathname, response.clone());
        }
        return response;
    } catch (error) {
        return (await cache.match(request, { ignoreSearch: true }))
            || (await cache.match(scoped(OFFLINE_PAGE)))
            || Response.error();
    }
}

/**
 * Static files: cached copy right away, refreshed in the background
 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    const network = fetch(request)
        .then(response => {
            if (response.ok && response.type === 'basic') {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => cached || Response.error());

    return cached || network;
}

/**
 * Web Push: payload comes from backend/utils/push.js
 */
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { body: event.data ? event.data.text() : '' };
    }

    const chatId = data.chatId || null;
    const notification = self.registration.showNotification(data.title || 'FriChat', {
        body: data.body || 'New message',
        icon: scoped('icons/icon-192.png'),
        badge: scoped('icons/badge-96.png'),
        // One notification per chat; a newer message replaces it and alerts again
        tag: chatId ? `chat-${chatId}` : 'frichat',
        renotify: true,
        timestamp: Date.now(),
        data: { chatId: chatId, url: data.url || 'chat.html' }
    });

    event.waitUntil(Promise.all([notification, setBadge(data.badge)]));
});

async function setBadge(count) {
    if (typeof count !== 'number' || !self.navigator.setAppBadge) return;
    try {
        if (count > 0) {
            await self.navigator.setAppBadge(count);
        } else {
            await self.navigator.clearAppBadge();
        }
    } catch (e) {
        // Badging is best effort
    }
}

/**
 * Focus an open FriChat window and switch it to the chat, or open a new one
 */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const { chatId, url } = event.notification.data || {};

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const chatWindow = windows.find(client => new URL(client.url).pathname.endsWith('/chat.html'));

        if (chatWindow) {
            chatWindow.postMessage({ type: 'open-chat', chatId: chatId });
            return chatWindow.focus();
        }
        return self.clients.openWindow(scoped(url || 'chat.html'));
    })());
});
