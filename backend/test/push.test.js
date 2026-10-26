/**
 * Web Push and do-not-disturb: quiet-hours math, notification previews, who gets a push
 * (mute, DND, visible tabs), cleanup of expired subscriptions, input validation,
 * settings storage on both databases and the `presence` socket event.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setupFakeDb, fakeRes, fakeIo, stubModule } = require('./helpers/fakeDb');

const CHAT_ID = 5;
const SENDER_ID = 1;

const VALID_SUBSCRIPTION = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123:def456',
    keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg'
    }
};

// "HH:MM" in UTC, `offsetMinutes` from now
function utcTime(offsetMinutes) {
    const date = new Date(Date.now() + offsetMinutes * 60 * 1000);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

describe('quiet hours', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { isInQuietHours, isDndActive } = load('utils/notificationSettings.js');
    const at = (iso) => new Date(iso);
    const window = (start, end, timezone = 'UTC') => ({ quietHoursEnabled: true, quietStart: start, quietEnd: end, timezone });

    test('same-day window includes start, excludes end', () => {
        const w = window('09:00', '17:00');
        assert.equal(isInQuietHours(w, at('2026-10-26T09:00:00Z')), true);
        assert.equal(isInQuietHours(w, at('2026-10-26T16:59:00Z')), true);
        assert.equal(isInQuietHours(w, at('2026-10-26T17:00:00Z')), false);
        assert.equal(isInQuietHours(w, at('2026-10-26T08:59:00Z')), false);
    });

    test('overnight window wraps past midnight', () => {
        const w = window('22:00', '07:00');
        assert.equal(isInQuietHours(w, at('2026-10-26T23:30:00Z')), true);
        assert.equal(isInQuietHours(w, at('2026-10-26T03:00:00Z')), true);
        assert.equal(isInQuietHours(w, at('2026-10-26T07:00:00Z')), false);
        assert.equal(isInQuietHours(w, at('2026-10-26T12:00:00Z')), false);
    });

    test('times are read in the user timezone', () => {
        // 21:30 UTC is 06:30 next day in Tokyo (UTC+9), inside 22:00-07:00 there
        assert.equal(isInQuietHours(window('22:00', '07:00', 'Asia/Tokyo'), at('2026-10-26T21:30:00Z')), true);
        assert.equal(isInQuietHours(window('22:00', '07:00', 'UTC'), at('2026-10-26T21:30:00Z')), false);
    });

    test('disabled, incomplete or empty windows never apply', () => {
        assert.equal(isInQuietHours({ ...window('00:00', '23:59'), quietHoursEnabled: false }, at('2026-10-26T12:00:00Z')), false);
        assert.equal(isInQuietHours(window('09:00', null), at('2026-10-26T12:00:00Z')), false);
        assert.equal(isInQuietHours(window('09:00', '09:00'), at('2026-10-26T09:00:00Z')), false);
    });

    test('manual DND wins regardless of time', () => {
        assert.equal(isDndActive({ dndEnabled: true }), true);
        assert.equal(isDndActive({ dndEnabled: false }), false);
        assert.equal(isDndActive(null), false);
    });
});

describe('notification preview', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { buildPreview } = load('utils/push.js');

    test('media gets generic text, never the file name', () => {
        assert.equal(buildPreview({ message_type: 'image', content: null, file_name: 'secret.png' }), '📷 Photo');
        assert.equal(buildPreview({ message_type: 'video' }), '🎥 Video');
        assert.equal(buildPreview({ message_type: 'file' }), '📎 File');
    });

    test('text is unescaped, collapsed and truncated', () => {
        assert.equal(buildPreview({ message_type: 'text', content: 'Tom &amp; Jerry &lt;3' }), 'Tom & Jerry <3');
        assert.equal(buildPreview({ message_type: 'text', content: 'a\n\n  b' }), 'a b');
        const long = buildPreview({ message_type: 'text', content: 'x'.repeat(500) });
        assert.equal(long.length, 120);
        assert.ok(long.endsWith('…'));
        assert.equal(buildPreview({ message_type: 'text', content: '   ' }), 'New message');
    });
});

for (const dbType of ['mysql', 'postgresql']) {
    describe(`notifyNewMessage (${dbType})`, () => {
        // Members as the recipients query returns them (muted / deleted chats are filtered in SQL)
        const MEMBER_ROWS = [
            { user_id: 2 },                                                     // no settings row: notify
            { user_id: 3, dnd_enabled: dbType === 'mysql' ? 1 : true },         // manual DND
            { user_id: 4, quiet_hours_enabled: true, quiet_start: utcTime(-60), quiet_end: utcTime(60), timezone: 'UTC' },
            { user_id: 5 },                                                     // has a visible tab on the chat
            { user_id: 6 }                                                      // has a tab, but it's hidden
        ];
        const SUBSCRIPTIONS = [
            { id: 10, user_id: 2, endpoint: 'https://push.example/ok', p256dh: 'k', auth: 'a' },
            { id: 11, user_id: 2, endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a' },
            { id: 12, user_id: 6, endpoint: 'https://push.example/hidden', p256dh: 'k', auth: 'a' }
        ];

        function setup() {
            const fake = setupFakeDb(dbType, (sql, params) => {
                if (/FROM group_members gm LEFT JOIN notification_settings ns/.test(sql)) return MEMBER_ROWS.map(r => ({ ...r }));
                if (/^SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN/.test(sql)) {
                    return SUBSCRIPTIONS.filter(s => params.includes(s.user_id)).map(s => ({ ...s }));
                }
                if (/^SELECT gm.user_id, COUNT\(m.id\) AS unread/.test(sql)) return [{ user_id: 2, unread: '4' }];
                if (/^SELECT chat_type, chat_name FROM chats WHERE id = /.test(sql)) return [{ chat_type: 'group', chat_name: 'Team &amp; Co' }];
                if (/^DELETE FROM push_subscriptions WHERE id = /.test(sql)) return dbType === 'mysql' ? { affectedRows: 1 } : [];
                throw new Error(`Unexpected query: ${sql}`);
            });

            const sent = [];
            stubModule('web-push', {
                setVapidDetails() {},
                async sendNotification(subscription, payload, options) {
                    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
                    if (subscription.endpoint.endsWith('/gone')) {
                        const error = new Error('Gone');
                        error.statusCode = 410;
                        throw error;
                    }
                }
            });
            process.env.VAPID_PUBLIC_KEY = 'test-public';
            process.env.VAPID_PRIVATE_KEY = 'test-private';

            const sockets = {
                user_5: [{ rooms: new Set(['user_5', `chat_${CHAT_ID}`]), data: { visible: true } }],
                user_6: [{ rooms: new Set(['user_6', `chat_${CHAT_ID}`]), data: { visible: false } }]
            };
            const io = { in: (room) => ({ fetchSockets: async () => sockets[room] || [] }) };

            return { ...fake, sent, io, push: fake.load('utils/push.js') };
        }

        const MESSAGE = { id: 99, chat_id: CHAT_ID, sender_id: SENDER_ID, username: 'alice', full_name: 'Alice', message_type: 'text', content: 'hi &amp; bye' };

        test('pushes only to members who are not muted, not in DND and not watching', async () => {
            const { sent, io, push, calls } = setup();

            const result = await push.notifyNewMessage(io, MESSAGE);

            assert.deepEqual(sent.map(s => s.endpoint).sort(), [
                'https://push.example/gone', 'https://push.example/hidden', 'https://push.example/ok'
            ]);
            assert.deepEqual(result, { sent: 2, removed: 1, failed: 0 });

            // Recipient query excludes the sender, muted members and deleted chats
            const recipientsQuery = calls.find(c => /LEFT JOIN notification_settings/.test(c.sql));
            assert.deepEqual(recipientsQuery.params, [CHAT_ID, SENDER_ID]);
            assert.match(recipientsQuery.sql, /gm.muted_until IS NULL OR gm.muted_until <= CURRENT_TIMESTAMP/);
            assert.match(recipientsQuery.sql, /dc.id IS NULL/);

            // Subscriptions are only looked up for users 2 and 6
            const subsQuery = calls.find(c => /FROM push_subscriptions WHERE user_id IN/.test(c.sql));
            assert.deepEqual(subsQuery.params, [2, 6]);
        });

        test('payload has sender, plain-text preview, chat id and badge count', async () => {
            const { sent, io, push } = setup();
            await push.notifyNewMessage(io, MESSAGE);

            const payload = sent.find(s => s.endpoint.endsWith('/ok')).payload;
            assert.equal(payload.chatId, CHAT_ID);
            assert.equal(payload.senderName, 'Alice');
            assert.equal(payload.title, 'Team & Co');
            assert.equal(payload.body, 'Alice: hi & bye');
            assert.equal(payload.url, `chat.html?chat=${CHAT_ID}`);
            assert.equal(payload.badge, 4);
            assert.equal(sent[0].options.topic, `chat-${CHAT_ID}`);
        });

        test('subscriptions answering 404/410 are deleted', async () => {
            const { io, push, calls } = setup();
            await push.notifyNewMessage(io, MESSAGE);

            const deletes = calls.filter(c => /^DELETE FROM push_subscriptions WHERE id = /.test(c.sql));
            assert.deepEqual(deletes.map(c => c.params), [[11]]);
        });

        test('does nothing without VAPID keys', async () => {
            const { io, push, calls, sent } = setup();
            process.env.VAPID_PUBLIC_KEY = ''; // read on first use

            const result = await push.notifyNewMessage(io, MESSAGE);
            assert.deepEqual(result, { sent: 0, removed: 0, failed: 0 });
            assert.equal(calls.length, 0);
            assert.equal(sent.length, 0);
        });

        test('settings are upserted for the current user and synced to their tabs', async () => {
            const fake = setupFakeDb(dbType, (sql) => {
                if (/^SELECT dnd_enabled/.test(sql)) return [];
                if (/^INSERT INTO notification_settings/.test(sql)) return dbType === 'mysql' ? { affectedRows: 1 } : [];
                throw new Error(`Unexpected query: ${sql}`);
            });
            const { updateSettings } = fake.load('controllers/notificationController.js');
            const io = fakeIo();
            const res = fakeRes();

            await updateSettings({
                user: { id: 7 },
                body: { quietHoursEnabled: true, quietStart: '22:00', quietEnd: '07:00', timezone: 'Europe/Berlin' },
                io
            }, res);

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.data.quietStart, '22:00');
            assert.equal(res.body.data.dndEnabled, false);
            assert.equal(typeof res.body.data.dndActive, 'boolean');

            const insert = fake.calls.find(c => /^INSERT INTO notification_settings/.test(c.sql));
            assert.deepEqual(insert.params, [7, false, true, '22:00', '07:00', 'Europe/Berlin']);
            assert.match(insert.sql, dbType === 'postgresql' ? /ON CONFLICT \(user_id\)/ : /ON DUPLICATE KEY UPDATE/);

            assert.deepEqual(io.emitted.map(e => [e.room, e.event]), [['user_7', 'notification_settings_updated']]);
        });

        test('unsubscribe only deletes the caller\'s own row', async () => {
            const fake = setupFakeDb(dbType, () => dbType === 'mysql' ? { affectedRows: 1 } : []);
            const { unsubscribe } = fake.load('controllers/notificationController.js');
            const { hashEndpoint } = fake.load('utils/push.js');
            const res = fakeRes();

            await unsubscribe({ user: { id: 7 }, body: { endpoint: VALID_SUBSCRIPTION.endpoint } }, res);

            assert.equal(res.statusCode, 200);
            assert.match(fake.calls[0].sql, /^DELETE FROM push_subscriptions WHERE endpoint_hash = (\?|\$1) AND user_id = (\?|\$2)$/);
            assert.deepEqual(fake.calls[0].params, [hashEndpoint(VALID_SUBSCRIPTION.endpoint), 7]);
        });
    });
}

describe('validation', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { validatePushSubscription, validateNotificationSettings } = load('utils/validation.js');
    const { validationResult } = require('express-validator');

    async function errorsFor(rules, body) {
        const req = { body };
        for (const rule of rules) await rule.run(req);
        return [...new Set(validationResult(req).array().map(e => e.path))];
    }

    test('accepts a real subscription', async () => {
        assert.deepEqual(await errorsFor(validatePushSubscription, VALID_SUBSCRIPTION), []);
    });

    test('rejects endpoints the server should never POST to', async () => {
        for (const endpoint of [
            'http://fcm.googleapis.com/fcm/send/x',
            'https://localhost:3000/api/x',
            'https://127.0.0.1/x',
            'https://[::1]/x',
            'javascript:alert(1)',
            'not a url'
        ]) {
            assert.deepEqual(await errorsFor(validatePushSubscription, { ...VALID_SUBSCRIPTION, endpoint }), ['endpoint'], endpoint);
        }
    });

    test('rejects missing or malformed keys', async () => {
        assert.ok((await errorsFor(validatePushSubscription, { endpoint: VALID_SUBSCRIPTION.endpoint })).includes('keys.p256dh'));
        assert.ok((await errorsFor(validatePushSubscription, {
            ...VALID_SUBSCRIPTION, keys: { p256dh: '<script>alert(1)</script>', auth: 'tBHItJI5svbpez7KI4CCXg' }
        })).includes('keys.p256dh'));
    });

    test('settings: times, booleans and timezone are checked', async () => {
        assert.deepEqual(await errorsFor(validateNotificationSettings, {
            dndEnabled: true, quietHoursEnabled: false, quietStart: '22:00', quietEnd: '07:30', timezone: 'America/New_York'
        }), []);
        assert.deepEqual(await errorsFor(validateNotificationSettings, { quietStart: null }), []);
        assert.deepEqual(await errorsFor(validateNotificationSettings, { quietStart: '24:00' }), ['quietStart']);
        assert.deepEqual(await errorsFor(validateNotificationSettings, { quietEnd: '7:00' }), ['quietEnd']);
        assert.deepEqual(await errorsFor(validateNotificationSettings, { dndEnabled: 'yes' }), ['dndEnabled']);
        assert.deepEqual(await errorsFor(validateNotificationSettings, { timezone: 'Mars/Olympus' }), ['timezone']);
    });
});

describe('presence socket event', () => {
    test('marks only this socket hidden or visible', async () => {
        setupFakeDb('mysql', () => []);
        process.env.PORT = '0';
        stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });

        const log = console.log;
        console.log = () => {};
        const { io } = require(path.join(__dirname, '..', 'server.js'));

        const handlers = {};
        const socket = { id: 's1', userId: 1, data: {}, join() {}, on(event, fn) { handlers[event] = fn; }, emit() {} };

        try {
            io.sockets.listeners('connection')[0](socket);
            assert.equal(socket.data.visible, true); // visible until told otherwise

            handlers.presence({ visible: false });
            assert.equal(socket.data.visible, false);

            handlers.presence({ visible: true });
            assert.equal(socket.data.visible, true);

            handlers.presence(null);
            assert.equal(socket.data.visible, true);
        } finally {
            await new Promise(resolve => io.close(() => resolve()));
            console.log = log;
        }
    });
});
