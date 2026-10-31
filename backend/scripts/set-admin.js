/**
 * Grant or remove the admin flag. This script and the database are the only ways to set it:
 * no API route writes users.is_admin. The change goes in the audit log.
 *
 *   node scripts/set-admin.js <username or email>            make this user an admin
 *   node scripts/set-admin.js <username or email> --revoke   remove the flag
 */

require('dotenv').config();
const { queryOne, updateAndCount } = require('../config/database');
const auditLog = require('../utils/auditLog');

async function main() {
    const args = process.argv.slice(2);
    const revoke = args.includes('--revoke');
    const identifier = args.find(arg => !arg.startsWith('--'));

    if (!identifier) {
        console.error('Usage: node scripts/set-admin.js <username or email> [--revoke]');
        return 1;
    }

    const user = await queryOne('SELECT id, username FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
    if (!user) {
        console.error(`No user "${identifier}"`);
        return 1;
    }

    await updateAndCount('UPDATE users SET is_admin = ? WHERE id = ?', [!revoke, user.id]);
    await auditLog.record('admin_flag_changed', {
        targetType: 'user',
        targetId: user.id,
        metadata: { granted: !revoke, via: 'cli' }
    });

    console.log(`${user.username} ${revoke ? 'is no longer an admin' : 'is now an admin'}. They see the console link after reloading the app.`);
    if (!revoke) console.log('The console also needs two-factor authentication: turn it on under Settings > Security.');
    return 0;
}

main()
    .then(code => process.exit(code))
    .catch((error) => {
        console.error('Failed:', error.message);
        process.exit(1);
    });
