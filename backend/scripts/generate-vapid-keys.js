/**
 * Print a fresh VAPID key pair for Web Push, ready to paste into backend/.env
 * Usage: npm run vapid:generate
 *
 * Generate once per deployment and keep the keys: changing them invalidates
 * every existing browser subscription.
 */

const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`# Web Push (generated ${new Date().toISOString()})
VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:admin@example.com`);
