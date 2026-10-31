/**
 * Two-factor authentication (TOTP) and recovery codes.
 *
 * The secret is encrypted at rest with AES-256-GCM under TOTP_ENCRYPTION_KEY, and the user id is
 * authenticated with it, so a secret copied onto another row won't decrypt. Recovery codes carry 80
 * random bits and only their SHA-256 hash is stored.
 *
 * Wrong codes are counted on the users row, not in memory, so restarting the server or asking for a
 * new sign-in challenge doesn't reset them. The attempt is reserved before the code is checked, so
 * parallel guesses can't all slip past the limit. A valid code still fails during a lock, which keeps
 * the lock from telling an attacker anything. Each TOTP step is accepted once (users.totp_last_step)
 * and each recovery code once (a conditional UPDATE), so a code seen over someone's shoulder is spent.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { generateSecret, generateURI, verifySync } = require('otplib');
const { executeQuery, queryOne, updateAndCount } = require('../config/database');
const {
    RECOVERY_CODE_COUNT,
    TOTP_TOLERANCE_SECONDS,
    TOTP_SETUP_TTL_SECONDS,
    LOGIN_CHALLENGE_TTL_SECONDS,
    totpIssuer,
    twoFactorLimits
} = require('../config/accountSecurity');
const { plusSecondsSql, secondsUntilSql, minusSecondsSql } = require('./timeSql');
const sessions = require('./sessions');
const auditLog = require('./auditLog');

const CIPHER = 'aes-256-gcm';
const CIPHER_VERSION = 'v1';
const CHALLENGE_PURPOSE = '2fa_login';
// No 0/O or 1/I, so a code copied from paper stays readable
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_LENGTH = 16;

const NOT_CONFIGURED = {
    status: 503,
    code: 'TWO_FACTOR_UNAVAILABLE',
    message: 'Two-factor authentication is not set up on this server yet.'
};
const INVALID_CODE = { status: 400, code: 'INVALID_2FA_CODE', message: 'That code isn\'t right. Check your authenticator app and try again.' };

// --- the secret at rest ---

/**
 * @returns {Buffer|null} the 32-byte key (64 hex characters or base64 in TOTP_ENCRYPTION_KEY)
 */
function encryptionKey() {
    const raw = String(process.env.TOTP_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
}

function isConfigured() {
    return encryptionKey() !== null;
}

function encryptSecret(secret, userId) {
    const key = encryptionKey();
    if (!key) throw new Error('TOTP_ENCRYPTION_KEY is missing or not 32 bytes');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CIPHER, key, iv);
    cipher.setAAD(Buffer.from(`totp:${userId}`));
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [CIPHER_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * @throws when the key is wrong or the value was tampered with: sign-in then fails, it never skips the check
 */
function decryptSecret(stored, userId) {
    const key = encryptionKey();
    if (!key) throw new Error('TOTP_ENCRYPTION_KEY is missing or not 32 bytes');
    const [version, iv, tag, body] = String(stored).split('.');
    if (version !== CIPHER_VERSION || !iv || !tag || !body) throw new Error('Unreadable TOTP secret');
    const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`totp:${userId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

// --- codes ---

function normalizeCode(code) {
    return String(code === undefined || code === null ? '' : code).replace(/[\s-]/g, '').toUpperCase();
}

function isTotpShaped(code) {
    return /^\d{6}$/.test(code);
}

function hashRecoveryCode(code) {
    return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/**
 * 'ABCD-EFGH-JKLM-NPQR': 80 random bits, unbiased
 */
function generateRecoveryCode() {
    let code = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
        code += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    return code.match(/.{4}/g).join('-');
}

/**
 * The step a code belongs to, or null if it isn't valid for this secret right now
 */
function matchedTotpStep(secret, code) {
    if (!isTotpShaped(code)) return null;
    const result = verifySync({ secret, token: code, epochTolerance: TOTP_TOLERANCE_SECONDS });
    return result.valid ? result.timeStep : null;
}

/**
 * Throw away the user's recovery codes and make a new set
 * @returns {Promise<string[]>} the codes, the only time they exist in plain text
 */
async function replaceRecoveryCodes(userId) {
    await executeQuery('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    for (const code of codes) {
        await executeQuery('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, hashRecoveryCode(code)]);
    }
    return codes;
}

async function countRecoveryCodes(userId) {
    const row = await queryOne('SELECT COUNT(*) AS total FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
    return row ? Number(row.total) : 0;
}

// --- setup ---

/**
 * Start (or restart) setup: a new secret, kept aside until the first code confirms it
 * @returns {Promise<{ secret, otpauthUrl, qrCode } | { error }>}
 */
async function beginSetup(user) {
    if (!isConfigured()) return { error: NOT_CONFIGURED };

    const secret = generateSecret();
    const stored = await updateAndCount(
        'UPDATE users SET totp_pending_enc = ?, totp_pending_at = CURRENT_TIMESTAMP WHERE id = ? AND totp_enabled_at IS NULL',
        [encryptSecret(secret, user.id), user.id]
    );
    if (stored === 0) {
        return { error: { status: 409, code: 'TWO_FACTOR_ALREADY_ON', message: 'Two-factor authentication is already on.' } };
    }

    const otpauthUrl = generateURI({ issuer: totpIssuer(), label: user.username, secret });
    return { secret, otpauthUrl, qrCode: await QRCode.toDataURL(otpauthUrl, { margin: 2, width: 240 }) };
}

/**
 * Finish setup with the first code. The session that confirmed counts as verified; the caller signs
 * out every other device, since none of them has passed a second factor.
 * @returns {Promise<{ recoveryCodes: string[] } | { error }>}
 */
async function confirmSetup(userId, sessionId, code) {
    if (!isConfigured()) return { error: NOT_CONFIGURED };

    const row = await queryOne(`
        SELECT totp_pending_enc, totp_enabled_at
        FROM users
        WHERE id = ? AND totp_pending_at > ${minusSecondsSql(TOTP_SETUP_TTL_SECONDS)}
    `, [userId]);
    if (!row || !row.totp_pending_enc || row.totp_enabled_at) {
        return { error: { status: 400, code: 'TWO_FACTOR_NOT_STARTED', message: 'Setup expired. Start again.' } };
    }

    const step = matchedTotpStep(decryptSecret(row.totp_pending_enc, userId), normalizeCode(code));
    if (step === null) return { error: INVALID_CODE };

    // Codes and the verified session first: once the last UPDATE runs the account depends on both
    const recoveryCodes = await replaceRecoveryCodes(userId);
    await sessions.markMfaVerified(sessionId);

    const enabled = await updateAndCount(`
        UPDATE users
        SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_pending_at = NULL,
            totp_enabled_at = CURRENT_TIMESTAMP, totp_last_step = ?, totp_failed_attempts = 0, totp_locked_until = NULL
        WHERE id = ? AND totp_enabled_at IS NULL AND totp_pending_enc IS NOT NULL
    `, [step, userId]);
    if (enabled === 0) {
        return { error: { status: 409, code: 'TWO_FACTOR_ALREADY_ON', message: 'Two-factor authentication is already on.' } };
    }
    return { recoveryCodes };
}

async function disable(userId) {
    await executeQuery('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
    await executeQuery(`
        UPDATE users
        SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_pending_at = NULL, totp_enabled_at = NULL,
            totp_last_step = NULL, totp_failed_attempts = 0, totp_locked_until = NULL
        WHERE id = ?
    `, [userId]);
}

async function getStatus(userId) {
    const row = await queryOne('SELECT totp_enabled_at FROM users WHERE id = ?', [userId]);
    const enabled = !!(row && row.totp_enabled_at);
    return {
        available: isConfigured(),
        enabled,
        enabledAt: enabled ? row.totp_enabled_at : null,
        recoveryCodesLeft: enabled ? await countRecoveryCodes(userId) : 0
    };
}

// --- checking a code ---

async function lockedError(userId) {
    const { lockMinutes } = twoFactorLimits();
    await executeQuery(
        `UPDATE users SET totp_locked_until = ${plusSecondsSql()} WHERE id = ? AND totp_locked_until IS NULL`,
        [lockMinutes * 60, userId]
    );
    const row = await queryOne(`SELECT ${secondsUntilSql('totp_locked_until')} AS seconds_left FROM users WHERE id = ?`, [userId]);
    return {
        status: 429,
        code: 'TWO_FACTOR_LOCKED',
        message: 'Too many wrong codes. Wait a few minutes and try again.',
        retryAfter: Math.max(parseInt(row && row.seconds_left, 10) || lockMinutes * 60, 1)
    };
}

/**
 * Take one attempt from the allowance. False when the second factor is locked or used up.
 */
async function reserveAttempt(userId, maxAttempts) {
    await executeQuery(
        'UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = ? AND totp_locked_until <= CURRENT_TIMESTAMP',
        [userId]
    );
    const reserved = await updateAndCount(
        'UPDATE users SET totp_failed_attempts = totp_failed_attempts + 1 WHERE id = ? AND totp_locked_until IS NULL AND totp_failed_attempts < ?',
        [userId, maxAttempts]
    );
    return reserved === 1;
}

async function useTotpCode(user, code) {
    const step = matchedTotpStep(decryptSecret(user.totp_secret_enc, user.id), code);
    if (step === null) return false;
    const claimed = await updateAndCount(
        'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
        [step, user.id, step]
    );
    return claimed === 1;
}

async function useRecoveryCode(userId, code) {
    const claimed = await updateAndCount(
        'UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
        [userId, hashRecoveryCode(code)]
    );
    return claimed === 1;
}

/**
 * Check a TOTP code or recovery code for a user with 2FA on. Every caller, at sign-in and in
 * settings, shares one allowance of wrong codes.
 * @param {string|null} ip - goes in the audit entry when this attempt locks the account
 * @returns {Promise<{ ok: true, method: 'totp'|'recovery', recoveryCodesLeft? } | { error }>}
 */
async function verifySecondFactor(userId, rawCode, ip = null) {
    const { maxAttempts } = twoFactorLimits();
    const user = await queryOne('SELECT id, totp_secret_enc, totp_enabled_at FROM users WHERE id = ?', [userId]);
    if (!user || !user.totp_enabled_at) return { error: INVALID_CODE };

    if (!(await reserveAttempt(userId, maxAttempts))) {
        return { error: await lockedError(userId) };
    }

    const code = normalizeCode(rawCode);
    let method = null;
    if (isTotpShaped(code)) {
        if (await useTotpCode(user, code)) method = 'totp';
    } else if (code.length === RECOVERY_CODE_LENGTH && (await useRecoveryCode(userId, code))) {
        method = 'recovery';
    }

    if (method) {
        await executeQuery('UPDATE users SET totp_failed_attempts = 0 WHERE id = ?', [userId]);
        return method === 'recovery'
            ? { ok: true, method, recoveryCodesLeft: await countRecoveryCodes(userId) }
            : { ok: true, method };
    }

    const row = await queryOne('SELECT totp_failed_attempts FROM users WHERE id = ?', [userId]);
    if (row && Number(row.totp_failed_attempts) >= maxAttempts) {
        await auditLog.record('2fa_locked', { actorId: userId, targetType: 'user', targetId: userId, ip: sessions.normalizeIp(ip) });
        return { error: await lockedError(userId) };
    }
    return { error: INVALID_CODE };
}

/**
 * For sensitive actions: the password, plus a current code when 2FA is on. The password comes first,
 * so a wrong one doesn't use up a code attempt.
 * @returns {Promise<{ ok: true, twoFactorEnabled: boolean, method? } | { error }>}
 */
async function reauthenticate(userId, { password, code }, ip = null) {
    const row = await queryOne('SELECT password_hash, totp_enabled_at FROM users WHERE id = ?', [userId]);
    if (!row || !(await bcrypt.compare(String(password), row.password_hash))) {
        return { error: { status: 400, code: 'WRONG_PASSWORD', message: 'Your password is incorrect' } };
    }
    if (!row.totp_enabled_at) return { ok: true, twoFactorEnabled: false };

    if (!code) {
        return { error: { status: 400, code: 'TWO_FACTOR_CODE_REQUIRED', message: 'Enter a code from your authenticator app' } };
    }
    const result = await verifySecondFactor(userId, code, ip);
    return result.error ? result : { ok: true, twoFactorEnabled: true, method: result.method };
}

// --- the step between password and code at sign-in ---

/**
 * Changes with the password, so a challenge dies if the password changes before it's used
 */
function passwordFingerprint(passwordHash) {
    return crypto.createHash('sha256').update(String(passwordHash)).digest('base64url').slice(0, 16);
}

/**
 * Proof that the password was right, good only for POST /auth/login/2fa. It has no session id, so
 * verifyAccessToken refuses it everywhere else.
 * @returns {{ challengeToken: string, expiresIn: number }}
 */
function signLoginChallenge(user) {
    const challengeToken = jwt.sign(
        { purpose: CHALLENGE_PURPOSE, userId: user.id, pw: passwordFingerprint(user.password_hash) },
        process.env.JWT_SECRET,
        { expiresIn: LOGIN_CHALLENGE_TTL_SECONDS }
    );
    return { challengeToken, expiresIn: LOGIN_CHALLENGE_TTL_SECONDS };
}

/**
 * @returns {{ userId, pw } | null}
 */
function verifyLoginChallenge(token) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.purpose !== CHALLENGE_PURPOSE || !decoded.userId) return null;
        return { userId: decoded.userId, pw: decoded.pw };
    } catch (error) {
        return null;
    }
}

module.exports = {
    isConfigured,
    encryptSecret,
    decryptSecret,
    normalizeCode,
    hashRecoveryCode,
    generateRecoveryCode,
    replaceRecoveryCodes,
    countRecoveryCodes,
    beginSetup,
    confirmSetup,
    disable,
    getStatus,
    verifySecondFactor,
    reauthenticate,
    passwordFingerprint,
    signLoginChallenge,
    verifyLoginChallenge
};
