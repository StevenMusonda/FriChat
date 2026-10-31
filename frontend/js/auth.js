/**
 * Authentication Module
 * Handles user registration, login, logout, and token management.
 *
 * Tokens: the access token (a 15-minute JWT) lives only in this page's memory, never in
 * localStorage, so injected script can't read a long-lived credential out of storage. The refresh
 * token is an HttpOnly cookie the browser sends to /api/auth only. Each page load gets a fresh
 * access token from POST /auth/refresh, and it is renewed shortly before it expires.
 * localStorage keeps only non-secret profile data (userData) as a "signed in on this browser" hint.
 */

// Invite codes: 22 base64url characters (128 bits), see backend/utils/invites.js
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// Renew this long before the access token expires
const REFRESH_EARLY_MS = 60 * 1000;
// The server answers 409 when two tabs refresh at once; the browser then has the newer cookie
const REFRESH_RACE_RETRIES = 3;

let accessToken = null;
let accessTokenExpiresAt = 0;
let refreshInFlight = null;
let refreshTimer = null;
let sessionEnded = false;

// Tokens from before phase 6 were kept in localStorage; they are no longer accepted, so drop them
try {
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
} catch (e) {
    // Storage unavailable
}

/**
 * Remember an invite link across sign-in/sign-up (this tab only)
 */
function rememberPendingInvite(code) {
    try {
        if (INVITE_CODE_PATTERN.test(code)) sessionStorage.setItem(CONFIG.STORAGE_KEYS.PENDING_INVITE, code);
    } catch (e) {
        // Storage unavailable: the user can open the link again
    }
}

/**
 * Read and forget the remembered invite code (null if none or not a valid code)
 */
function takePendingInvite() {
    try {
        const code = sessionStorage.getItem(CONFIG.STORAGE_KEYS.PENDING_INVITE);
        sessionStorage.removeItem(CONFIG.STORAGE_KEYS.PENDING_INVITE);
        return code && INVITE_CODE_PATTERN.test(code) ? code : null;
    } catch (e) {
        return null;
    }
}

/**
 * ?next= target after login. Only an invite page is accepted, so the parameter can't
 * send anyone to another site (no open redirect).
 */
function getSafeNextUrl(search = window.location.search) {
    const next = new URLSearchParams(search).get('next');
    const match = next && /^join\.html\?code=([A-Za-z0-9_-]{22})$/.exec(next);
    return match ? `join.html?code=${match[1]}` : null;
}

// ===== Session tokens =====

function setAccessToken(token, expiresInSeconds) {
    accessToken = token;
    accessTokenExpiresAt = Date.now() + (Number(expiresInSeconds) || 0) * 1000;

    clearTimeout(refreshTimer);
    const delay = Math.max(accessTokenExpiresAt - Date.now() - REFRESH_EARLY_MS, 5000);
    refreshTimer = setTimeout(() => { refreshAccessToken(); }, delay);
}

function clearAccessToken() {
    accessToken = null;
    accessTokenExpiresAt = 0;
    clearTimeout(refreshTimer);
}

/**
 * Store the non-secret profile fields an auth response returns
 */
function storeUserData(data) {
    localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify({
        userId: data.userId,
        username: data.username,
        email: data.email,
        fullName: data.fullName,
        avatarUrl: data.avatarUrl,
        emailVerified: !!data.emailVerified,
        isAdmin: !!data.isAdmin, // only shows the console link; the server checks every admin call
        twoFactorEnabled: !!data.twoFactorEnabled
    }));
}

/**
 * What a completed sign-in has to tell the user, shown by account.js once the app opens
 */
function rememberAccountNotice(data) {
    let notice = null;
    if (data.deletionCancelled) notice = 'Welcome back. Your account will not be deleted.';
    else if (data.recoveryCodesLeft !== undefined) notice = `You signed in with a recovery code. ${data.recoveryCodesLeft} left.`;
    if (!notice) return;
    try {
        sessionStorage.setItem(CONFIG.STORAGE_KEYS.ACCOUNT_NOTICE, notice);
    } catch (e) {
        // Storage unavailable: only a courtesy
    }
}

/**
 * Forget everything about the signed-in user in this browser
 */
function clearLocalSession() {
    clearAccessToken();
    try {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.USER_DATA);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.CURRENT_CHAT);
    } catch (e) {
        // Storage unavailable
    }
}

/**
 * The session is over (revoked from another device, password changed, token reuse, expired):
 * clear local state and go to the login page once
 */
function handleSessionEnded(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    clearLocalSession();
    if (typeof disconnectWebSocket === 'function') disconnectWebSocket();
    if (!/login\.html$/.test(window.location.pathname)) {
        window.location.href = reason ? `login.html?signedOut=${encodeURIComponent(reason)}` : 'login.html';
    }
}

/**
 * One refresh at a time across all tabs of this browser (Web Locks), so tabs don't spend the
 * same refresh token twice; browsers without the API rely on the server's retry answer (409)
 */
function withRefreshLock(task) {
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        return navigator.locks.request('frichat-refresh', task);
    }
    return task();
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function requestNewAccessToken() {
    for (let attempt = 0; attempt <= REFRESH_RACE_RETRIES; attempt++) {
        let response;
        try {
            response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.REFRESH}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'X-FriChat-Refresh': '1' }
            });
        } catch (error) {
            return { ok: false, network: true };
        }

        if (response.status === 409) {
            await wait(250 * (attempt + 1));
            continue;
        }

        let data = {};
        try {
            data = await response.json();
        } catch (e) {
            // Not JSON
        }

        if (response.ok && data.success) {
            setAccessToken(data.data.accessToken, data.data.expiresIn);
            storeUserData(data.data);
            return { ok: true };
        }
        if (response.status >= 500 || response.status === 429) {
            return { ok: false, network: true };
        }
        return { ok: false, code: data.code || 'SESSION_EXPIRED', message: data.message };
    }
    return { ok: false, network: true };
}

/**
 * Get a new access token with the refresh cookie (concurrent callers share one request).
 * A definite "no" from the server ends the session; a network problem does not.
 * @returns {Promise<{ ok: boolean, network?: boolean, code?: string }>}
 */
function refreshAccessToken() {
    if (!refreshInFlight) {
        refreshInFlight = withRefreshLock(requestNewAccessToken)
            .then((result) => {
                if (!result.ok && !result.network) {
                    handleSessionEnded(result.code === 'TOKEN_REUSED' ? 'security' : 'expired');
                }
                return result;
            })
            .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
}

/**
 * A usable access token, refreshing first when it is missing or about to expire (null if signed out)
 */
async function getAccessToken() {
    if (accessToken && Date.now() < accessTokenExpiresAt - 5000) return accessToken;
    if (!getCurrentUser()) return null;
    const result = await refreshAccessToken();
    return result.ok ? accessToken : null;
}

/**
 * Start-of-page check for protected pages: turns the refresh cookie into an access token.
 * @returns {Promise<{ ok: boolean, network?: boolean }>}
 */
async function ensureSession() {
    if (accessToken && Date.now() < accessTokenExpiresAt - 5000) return { ok: true };
    return refreshAccessToken();
}

/**
 * Make API request with authentication.
 * options.skipAuth: for the sign-in pages (no token, and a 401 is just "wrong credentials").
 */
async function apiRequest(endpoint, options = {}, isRetry = false) {
    const { skipAuth, ...fetchOptions } = options;
    const token = skipAuth ? null : await getAccessToken();

    const defaultOptions = {
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
        }
    };

    const mergedOptions = {
        ...defaultOptions,
        ...fetchOptions,
        headers: {
            ...defaultOptions.headers,
            ...fetchOptions.headers
        }
    };

    try {
        const response = await fetch(`${CONFIG.API_BASE_URL}${endpoint}`, mergedOptions);
        const data = await response.json();

        // Only 401 means the token is missing, invalid, expired or its session was revoked:
        // refresh once and retry; if that fails the session has ended. 403 is "not allowed to do
        // this" (e.g. not a member of a chat) and is returned to the caller like any other error.
        // Without a token (login page) a 401 is just "wrong credentials".
        if (response.status === 401 && token) {
            if (!isRetry && data.code !== 'SESSION_REVOKED') {
                clearAccessToken();
                const refreshed = await refreshAccessToken();
                if (refreshed.ok) return apiRequest(endpoint, options, true);
            }
            handleSessionEnded(data.code === 'SESSION_REVOKED' ? 'revoked' : 'expired');
            throw new Error('Unauthorized');
        }

        return data;
    } catch (error) {
        console.error('API request error:', error);
        throw error;
    }
}

/**
 * Register a new user
 */
async function register(username, email, password, fullName = '') {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.REGISTER, {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({
                username,
                email,
                password,
                fullName
            })
        });

        if (response.success && response.data.accessToken) {
            sessionEnded = false;
            setAccessToken(response.data.accessToken, response.data.expiresIn);
            storeUserData(response.data);
        }

        return response;
    } catch (error) {
        console.error('Registration error:', error);
        return { success: false, message: 'Registration failed' };
    }
}

/**
 * Login user. With 2FA on, the result has data.twoFactorRequired and data.challengeToken and nothing
 * is signed in yet: finish with verifyTwoFactorLogin.
 */
async function login(username, password) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LOGIN, {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({
                username,
                password
            })
        });

        if (response.success && response.data.accessToken) {
            sessionEnded = false;
            setAccessToken(response.data.accessToken, response.data.expiresIn);
            storeUserData(response.data);
            rememberAccountNotice(response.data);
        }

        return response;
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, message: 'Login failed' };
    }
}

/**
 * Second step of a sign-in: a code from the authenticator app, or a recovery code
 */
async function verifyTwoFactorLogin(challengeToken, code) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LOGIN_2FA, {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({ challengeToken, code })
        });

        if (response.success && response.data.accessToken) {
            sessionEnded = false;
            setAccessToken(response.data.accessToken, response.data.expiresIn);
            storeUserData(response.data);
            rememberAccountNotice(response.data);
        }

        return response;
    } catch (error) {
        console.error('Two-factor login error:', error);
        return { success: false, message: 'Login failed' };
    }
}

/**
 * Request a password reset email
 */
async function requestPasswordReset(email) {
    try {
        return await apiRequest(CONFIG.ENDPOINTS.FORGOT_PASSWORD, {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({ email })
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        return { success: false, message: 'Failed to send reset link' };
    }
}

/**
 * Set a new password using a reset token
 */
async function resetPassword(token, password) {
    try {
        return await apiRequest(CONFIG.ENDPOINTS.RESET_PASSWORD, {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({ token, password })
        });
    } catch (error) {
        console.error('Reset password error:', error);
        return { success: false, message: 'Failed to reset password' };
    }
}

/**
 * Confirm an email address with the token from the verification email
 */
async function verifyEmailToken(token) {
    try {
        return await apiRequest(CONFIG.ENDPOINTS.VERIFY_EMAIL, {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({ token })
        });
    } catch (error) {
        console.error('Verify email error:', error);
        return { success: false, message: 'Failed to verify your email address' };
    }
}

/**
 * Logout user (ends this device's session on the server and clears the refresh cookie)
 */
async function logout() {
    // Stop pushes to this browser before the token goes away (pwa.js; absent on pages without it)
    if (typeof cleanupPushOnLogout === 'function') {
        await cleanupPushOnLogout();
    }

    try {
        await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.LOGOUT}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'X-FriChat-Refresh': '1',
                ...(accessToken && { 'Authorization': `Bearer ${accessToken}` })
            }
        });
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        sessionEnded = true;
        clearLocalSession();

        // Redirect to login
        if (window.location.pathname !== '/frontend/login.html') {
            window.location.href = 'login.html';
        }
    }
}

/**
 * Get current user data
 */
function getCurrentUser() {
    try {
        const userData = localStorage.getItem(CONFIG.STORAGE_KEYS.USER_DATA);
        return userData ? JSON.parse(userData) : null;
    } catch (e) {
        return null;
    }
}

/**
 * Signed in on this browser, as far as the page can tell without asking the server
 * (protected pages confirm it with ensureSession())
 */
function isAuthenticated() {
    return !!getCurrentUser();
}

/**
 * Get user profile from server
 */
async function getProfile() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.PROFILE);

        if (response.success) {
            // Update stored user data
            storeUserData(response.data);
        }

        return response;
    } catch (error) {
        console.error('Get profile error:', error);
        return { success: false, message: 'Failed to get profile' };
    }
}

/**
 * Update user profile
 */
async function updateProfile(fullName) {
    try {
        // Photos are uploaded (Settings > Profile), never set to a URL
        const response = await apiRequest(CONFIG.ENDPOINTS.PROFILE, {
            method: 'PUT',
            body: JSON.stringify({ fullName })
        });

        if (response.success) {
            // Update stored user data
            const currentUser = getCurrentUser();
            currentUser.fullName = fullName;
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(currentUser));
        }

        return response;
    } catch (error) {
        console.error('Update profile error:', error);
        return { success: false, message: 'Failed to update profile' };
    }
}

// Signed out in another tab: follow it
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
        if (event.key === CONFIG.STORAGE_KEYS.USER_DATA && !event.newValue && !sessionEnded) {
            handleSessionEnded();
        }
    });
}
