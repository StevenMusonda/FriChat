/**
 * Turn off 2FA for someone who lost both their authenticator and their recovery codes. There is no
 * API for this on purpose: check who is asking first, then run it on the server. All of their
 * sessions end, the change goes in the audit log, and they are told by email.
 *
 *   node scripts/reset-2fa.js <username or email>
 */

require('dotenv').config();
const { queryOne } = require('../config/database');
const twoFactor = require('../utils/twoFactor');
const sessions = require('../utils/sessions');
const auditLog = require('../utils/auditLog');
const { sendSecurityEmail } = require('../utils/mailer');

async function main() {
    const identifier = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    if (!identifier) {
        console.error('Usage: node scripts/reset-2fa.js <username or email>');
        return 1;
    }

    const user = await queryOne(
        'SELECT id, username, email, totp_enabled_at FROM users WHERE (username = ? OR email = ?) AND deleted_at IS NULL',
        [identifier, identifier]
    );
    if (!user) {
        console.error(`No user "${identifier}"`);
        return 1;
    }
    if (!user.totp_enabled_at) {
        console.error(`${user.username} doesn't have two-factor authentication on`);
        return 1;
    }

    await twoFactor.disable(user.id);
    await sessions.revokeUserSessions(null, user.id, '2fa');
    await auditLog.record('2fa_reset_by_operator', { targetType: 'user', targetId: user.id, metadata: { via: 'cli' } });
    await sendSecurityEmail(user.email, user.username, 'Two-factor authentication is off', [
        'An administrator turned off two-factor authentication for your account, and every device was signed out.',
        'If you didn\'t ask for this, contact your administrator and change your password now.'
    ]);

    console.log(`Two-factor authentication is off for ${user.username}, and every device was signed out.`);
    return 0;
}

main()
    .then(code => process.exit(code))
    .catch((error) => {
        console.error('Failed:', error.message);
        process.exit(1);
    });
