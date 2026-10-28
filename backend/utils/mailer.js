/**
 * Email Utility
 * Sends mail over SMTP when configured; otherwise logs to the console
 * so password resets can still be tested in development
 */

const nodemailer = require('nodemailer');

let transporter = null;

if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
        } : undefined
    });
}

/**
 * Send an email
 * @param {Object} mail - { to, subject, text, html }
 */
async function sendMail({ to, subject, text, html }) {
    if (!transporter) {
        console.log(`
[mailer] SMTP not configured - email not sent.
  To: ${to}
  Subject: ${subject}
${text}
`);
        return;
    }

    await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to,
        subject,
        text,
        html
    });
}

/**
 * Send a password reset link
 */
async function sendPasswordResetEmail(to, username, resetUrl, expiresInMinutes) {
    const text = `Hi ${username},

We received a request to reset your FriChat password.
Open the link below to choose a new password:

${resetUrl}

This link expires in ${expiresInMinutes} minutes and can only be used once.
If you didn't request this, you can safely ignore this email.`;

    const html = `
        <p>Hi ${escapeHtml(username)},</p>
        <p>We received a request to reset your FriChat password.</p>
        <p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>
        <p>This link expires in ${expiresInMinutes} minutes and can only be used once.<br>
        If you didn't request this, you can safely ignore this email.</p>
    `;

    await sendMail({ to, subject: 'Reset your FriChat password', text, html });
}

/**
 * Send an email-verification link
 */
async function sendVerificationEmail(to, username, verifyUrl, expiresInHours) {
    const text = `Hi ${username},

Welcome to FriChat! Please confirm your email address by opening the link below:

${verifyUrl}

This link expires in ${expiresInHours} hours and can only be used once.
If you didn't create a FriChat account, you can ignore this email.`;

    const html = `
        <p>Hi ${escapeHtml(username)},</p>
        <p>Welcome to FriChat! Please confirm your email address.</p>
        <p><a href="${escapeHtml(verifyUrl)}">Verify your email</a></p>
        <p>This link expires in ${expiresInHours} hours and can only be used once.<br>
        If you didn't create a FriChat account, you can ignore this email.</p>
    `;

    await sendMail({ to, subject: 'Verify your FriChat email address', text, html });
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
    sendMail,
    sendPasswordResetEmail,
    sendVerificationEmail
};
