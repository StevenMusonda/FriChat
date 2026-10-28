/**
 * GET /api/chats: participants and last messages are fetched with one query each,
 * no matter how many chats the user has, and the response keeps its shape.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupFakeDb, fakeRes } = require('./helpers/fakeDb');

const USER_ID = 1;

const CHAT_ROWS = [
    { id: 3, chat_type: 'group', chat_name: 'Team', unread_count: '2', is_muted: 0, archived_at: null },
    { id: 2, chat_type: 'direct', chat_name: null, unread_count: '0', is_muted: 1, archived_at: null },
    { id: 9, chat_type: 'direct', chat_name: null, unread_count: null, is_muted: '0', archived_at: null }
];

const PARTICIPANT_ROWS = [
    { chat_id: 2, userId: 1, username: 'me', fullName: 'Me', avatarUrl: null, status: 'online', role: 'member' },
    { chat_id: 2, userId: 4, username: 'bob', fullName: 'Bob', avatarUrl: null, status: 'offline', role: 'member' },
    { chat_id: 3, userId: 4, username: 'bob', fullName: 'Bob', avatarUrl: null, status: 'offline', role: 'admin' },
    { chat_id: 3, userId: 1, username: 'me', fullName: 'Me', avatarUrl: null, status: 'online', role: 'member' }
];

const LAST_MESSAGE_ROWS = [
    { chat_id: 3, id: 30, content: 'hi team', messageType: 'text', senderId: 4, senderName: 'bob', status: 'sent', createdAt: '2026-10-20T10:00:00.000Z', fileName: null },
    { chat_id: 2, id: 20, content: null, messageType: 'file', senderId: 1, senderName: 'me', status: 'read', createdAt: '2026-10-19T10:00:00.000Z', fileName: 'a.pdf' }
];

function chatListHandler(chatRows) {
    return (sql) => {
        if (/FROM chats c JOIN group_members gm ON c.id = gm.chat_id AND gm.user_id/.test(sql)) return chatRows.map(r => ({ ...r }));
        if (/FROM group_members gm JOIN users u/.test(sql)) return PARTICIPANT_ROWS.map(r => ({ ...r }));
        if (/FROM chats c JOIN messages m ON m.id = \(/.test(sql)) return LAST_MESSAGE_ROWS.map(r => ({ ...r }));
        // Phase 6 block checks: nobody is blocked in these tests
        if (/user_blocks/.test(sql)) return [];
        throw new Error(`Unexpected query: ${sql}`);
    };
}

async function getChats(dbType, chatRows = CHAT_ROWS) {
    const fake = setupFakeDb(dbType, chatListHandler(chatRows));
    const { getUserChats } = fake.load('controllers/chatController.js');
    const res = fakeRes();
    const log = console.log;
    console.log = () => {};
    try {
        await getUserChats({ user: { id: USER_ID } }, res);
    } finally {
        console.log = log;
    }
    return { res, calls: fake.calls };
}

for (const dbType of ['mysql', 'postgresql']) {
    test(`chat list uses four queries in total (${dbType})`, async () => {
        const { res, calls } = await getChats(dbType);

        assert.equal(res.statusCode, 200);
        assert.equal(calls.length, 4);

        // Both batched queries bind every chat id once, in list order
        assert.deepEqual(calls[1].params, [3, 2, 9]);
        assert.deepEqual(calls[3].params, [3, 2, 9]);

        // One lookup of who blocked this user (their status is shown as offline)
        assert.match(calls[2].sql, /^SELECT blocker_id FROM user_blocks WHERE blocked_id = (\?|\$1)$/);
    });

    test(`chat list keeps its response shape (${dbType})`, async () => {
        const { res } = await getChats(dbType);
        const [team, direct, empty] = res.body.data;

        assert.deepEqual(res.body.data.map(c => c.id), [3, 2, 9]);

        assert.equal(team.unread_count, 2);
        assert.equal(team.is_muted, false);
        assert.equal(direct.is_muted, true);
        assert.equal(empty.unread_count, 0);

        // Participants: JSON string, grouping key stripped, original column order
        assert.equal(team.participants, JSON.stringify([
            { userId: 4, username: 'bob', fullName: 'Bob', avatarUrl: null, status: 'offline', role: 'admin' },
            { userId: 1, username: 'me', fullName: 'Me', avatarUrl: null, status: 'online', role: 'member' }
        ]));
        assert.equal(empty.participants, '[]');

        // Last message: JSON string without chat_id, or null when the chat has none
        assert.equal(direct.lastMessage, JSON.stringify({
            id: 20, content: null, messageType: 'file', senderId: 1, senderName: 'me', status: 'read', createdAt: '2026-10-19T10:00:00.000Z', fileName: 'a.pdf'
        }));
        assert.equal(JSON.parse(team.lastMessage).id, 30);
        assert.equal(empty.lastMessage, null);
    });
}

test('chat list with no chats skips the batched queries', async () => {
    const { res, calls } = await getChats('mysql', []);

    assert.equal(calls.length, 1);
    assert.deepEqual(res.body.data, []);
});
