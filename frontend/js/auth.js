/**
 * Authentication Module
 * Handles user registration, login, logout, and token management
 */

/**
 * Make API request with authentication
 */
async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
    
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
        }
    };
    
    const mergedOptions = {
        ...defaultOptions,
        ...options,
        headers: {
            ...defaultOptions.headers,
            ...options.headers
        }
    };
    
    try {
        const response = await fetch(`${CONFIG.API_BASE_URL}${endpoint}`, mergedOptions);
        const data = await response.json();
        
        // Handle unauthorized
        if (response.status === 401 || response.status === 403) {
            logout();
            window.location.href = 'login.html';
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
            body: JSON.stringify({
                username,
                email,
                password,
                fullName
            })
        });
        
        if (response.success && response.data.token) {
            // Store token and user data
            localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN, response.data.token);
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify({
                userId: response.data.userId,
                username: response.data.username,
                email: response.data.email,
                fullName: response.data.fullName
            }));
        }
        
        return response;
    } catch (error) {
        console.error('Registration error:', error);
        return { success: false, message: 'Registration failed' };
    }
}

/**
 * Login user
 */
async function login(username, password) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LOGIN, {
            method: 'POST',
            body: JSON.stringify({
                username,
                password
            })
        });
        
        if (response.success && response.data.token) {
            // Store token and user data
            localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN, response.data.token);
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify({
                userId: response.data.userId,
                username: response.data.username,
                email: response.data.email,
                fullName: response.data.fullName,
                avatarUrl: response.data.avatarUrl
            }));
        }
        
        return response;
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, message: 'Login failed' };
    }
}

/**
 * Logout user
 */
async function logout() {
    try {
        await apiRequest(CONFIG.ENDPOINTS.LOGOUT, {
            method: 'POST'
        });
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        // Clear local storage
        localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.USER_DATA);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.CURRENT_CHAT);
        
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
    const userData = localStorage.getItem(CONFIG.STORAGE_KEYS.USER_DATA);
    return userData ? JSON.parse(userData) : null;
}

/**
 * Check if user is authenticated
 */
function isAuthenticated() {
    return !!localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
}

/**
 * Get user profile from server
 */
async function getProfile() {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.PROFILE);
        
        if (response.success) {
            // Update stored user data
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(response.data));
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
async function updateProfile(fullName, avatarUrl) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.PROFILE, {
            method: 'PUT',
            body: JSON.stringify({
                fullName,
                avatarUrl
            })
        });
        
        if (response.success) {
            // Update stored user data
            const currentUser = getCurrentUser();
            currentUser.fullName = fullName;
            currentUser.avatarUrl = avatarUrl;
            localStorage.setItem(CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(currentUser));
        }
        
        return response;
    } catch (error) {
        console.error('Update profile error:', error);
        return { success: false, message: 'Failed to update profile' };
    }
}
