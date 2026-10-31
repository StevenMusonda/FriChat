/**
 * Emails about what happened to an account. Sent in the background: a slow or broken mail server
 * must never delay or fail the sign-in or change that caused one. They carry no secrets and no links
 * that sign anyone in.
 */

const { sendSecurityEmail } = require('./mailer');
const { deletionGraceDays } = require('../config/accountSecurity');

function frontendBase() {
    return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
}

const NOT_YOU = 'If this wasn\'t you, change your password now and check Settings > Security.';

const TEMPLATES = {
    new_device: ({ device, ip }) => ({
        subject: 'New sign-in to your FriChat account',
        lines: [`Your account was just signed in from a new device: ${device || 'Unknown device'}${ip ? ` (IP ${ip})` : ''}.`, NOT_YOU]
    }),
    password_changed: () => ({
        subject: 'Your FriChat password was changed',
        lines: ['Your password was just changed.', NOT_YOU]
    }),
    password_reset: () => ({
        subject: 'Your FriChat password was reset',
        lines: ['Your password was just reset with a link sent to this address. Every device was signed out.', NOT_YOU]
    }),
    email_changed: ({ newEmail }) => ({
        subject: 'Your FriChat email address was changed',
        lines: [`The email address on your account was changed to ${newEmail}. This address will no longer be used.`, NOT_YOU]
    }),
    two_factor_enabled: () => ({
        subject: 'Two-factor authentication is on',
        lines: ['Two-factor authentication was turned on for your account. Every other device was signed out.', NOT_YOU]
    }),
    two_factor_disabled: () => ({
        subject: 'Two-factor authentication is off',
        lines: ['Two-factor authentication was turned off for your account.', NOT_YOU]
    }),
    recovery_regenerated: () => ({
        subject: 'New FriChat recovery codes',
        lines: ['New recovery codes were generated. The old ones no longer work.', NOT_YOU]
    }),
    recovery_used: ({ left }) => ({
        subject: 'A FriChat recovery code was used',
        lines: [`A recovery code was used to sign in. You have ${left} left.`, NOT_YOU]
    }),
    deletion_scheduled: ({ dueAt }) => ({
        subject: 'Your FriChat account will be deleted',
        lines: [
            `Your account is scheduled for deletion on ${new Date(dueAt).toUTCString()}.`,
            `Changed your mind? Sign in within ${deletionGraceDays()} days and the deletion is cancelled.`,
            NOT_YOU
        ]
    }),
    deletion_cancelled: () => ({
        subject: 'Your FriChat account will not be deleted',
        lines: ['You signed in, so the deletion of your account was cancelled.', NOT_YOU]
    }),
    account_deleted: () => ({
        subject: 'Your FriChat account was deleted',
        lines: ['Your account and personal data have been deleted, as you asked. This is the last email you will get from us.']
    }),
    export_ready: ({ expiresInHours }) => ({
        subject: 'Your FriChat data export is ready',
        lines: [
            `Your data export is ready. Sign in and download it from Settings > Security within ${expiresInHours} hours.`,
            `${frontendBase()}/chat.html?settings=security`
        ]
    })
};

/**
 * @param {{ email, username }} user
 * @param {string} kind - a key of TEMPLATES
 * @param {Object} details - what that template shows
 */
function notifySecurityEvent(user, kind, details = {}) {
    const template = TEMPLATES[kind];
    if (!template || !user || !user.email) return;
    (async () => {
        const { subject, lines } = template(details);
        await sendSecurityEmail(user.email, user.username, subject, lines);
    })().catch(error => console.error(`Security email "${kind}" error:`, error.message));
}

module.exports = { notifySecurityEvent };
