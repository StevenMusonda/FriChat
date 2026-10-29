/**
 * Phase 7 on both databases: search terms can't inject FULLTEXT/tsquery syntax, every search
 * is limited to the user's chats and leaves out deleted messages, snippets and highlights,
 * the shared media panel, jumping to a message (around/after pages) and input validation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { setupFakeDb, fakeRes, stubModule } = require('./helpers/fakeDb');

const ME = 1;
const OTHER = 2;
const MY_CHAT = 5;
const FOREIGN_CHAT = 9;

describe('search helpers', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { parseSearchTerms, buildTextCondition, buildSnippet, extractUrls } = load('utils/messageSearch.js');

    test('terms are lower-cased words only: no operators reach the full-text engine', () => {
        assert.deepEqual(parseSearchTerms('Hello +world* -"x" (a|b) & c:* \\ @x'), ['hello', 'world', 'x', 'a', 'b', 'c']);
        assert.deepEqual(parseSearchTerms("Grüße ünïcödé 2026"), ['grüße', 'ünïcödé', '2026']);
        assert.deepEqual(parseSearchTerms('dup Dup DUP'), ['dup']);
        assert.equal(parseSearchTerms('a b c d e f g h i j k').length, 8);
        assert.deepEqual(parseSearchTerms('!!! ???'), []);
        assert.deepEqual(parseSearchTerms(null), []);
        assert.deepEqual(parseSearchTerms({ $gt: '' }), []);
    });

    test('PostgreSQL: one tsquery parameter, every term as a prefix', () => {
        const condition = buildTextCondition(['deploy', 'fr'], 'postgresql');
        assert.equal(condition.sql, "m.search_vector @@ to_tsquery('simple', ?)");
        assert.deepEqual(condition.params, ['deploy:* & fr:*']);
        assert.equal(buildTextCondition([], 'postgresql'), null);
    });

    test('MySQL: FULLTEXT for indexed words, LIKE for short words and stopwords', () => {
        const condition = buildTextCondition(['deploy', 'friday', 'at', 'the'], 'mysql');
        assert.equal(condition.sql, 'MATCH(m.content) AGAINST (? IN BOOLEAN MODE) AND LOWER(m.content) LIKE ? AND LOWER(m.content) LIKE ?');
        assert.deepEqual(condition.params, ['+deploy* +friday*', '%at%', '%the%']);

        const shortOnly = buildTextCondition(['ok'], 'mysql');
        assert.equal(shortOnly.sql, 'LOWER(m.content) LIKE ?');
    });

    test('snippet: window around the first match with highlight offsets', () => {
        const long = `${'lorem '.repeat(40)}we deploy on Friday and deployment notes follow ${'ipsum '.repeat(40)}`;
        const snippet = buildSnippet(long, ['deploy', 'friday']);
        assert.ok(snippet.text.startsWith('…'));
        assert.ok(snippet.text.endsWith('…'));
        assert.ok(snippet.text.length <= 162);
        const marked = snippet.highlights.map(([s, e]) => snippet.text.slice(s, e));
        assert.deepEqual(marked, ['deploy', 'Friday', 'deploy']);

        const short = buildSnippet('Line one\n\nline   two', ['two']);
        assert.equal(short.text, 'Line one line two');
        assert.deepEqual(short.highlights, [[14, 17]]);

        // Word prefixes only, unless the term only appears inside a word (MySQL LIKE)
        assert.deepEqual(buildSnippet('catalog cat', ['cat']).highlights, [[0, 3], [8, 11]]);
        assert.deepEqual(buildSnippet('concatenate', ['cat']).highlights, [[3, 6]]);
        assert.equal(buildSnippet(null, ['x']), null);
    });

    test('links: http(s) only, outside code, trailing punctuation dropped', () => {
        assert.deepEqual(
            extractUrls('see https://example.com/a?b=1. and (http://x.org/y) `https://code.example` javascript:alert(1)'),
            ['https://example.com/a?b=1', 'http://x.org/y']
        );
        assert.deepEqual(extractUrls('```\nhttps://block.example\n```'), []);
        assert.deepEqual(extractUrls(null), []);
    });
});

/**
 * Fake database: membership for MY_CHAT only; search and media queries return `rows`
 */
function searchWorld(dbType, rows = []) {
    return setupFakeDb(dbType, (rawSql, params) => {
        const sql = rawSql.replace(/\$\d+/g, '?');
        if (/^SELECT id FROM group_members WHERE chat_id = \? AND user_id = \?/.test(sql)) {
            return Number(params[0]) === MY_CHAT && Number(params[1]) === ME ? [{ id: 1 }] : [];
        }
        if (/FROM messages m/.test(sql)) return rows;
        throw new Error(`unexpected query: ${sql}`);
    });
}

for (const dbType of ['mysql', 'postgresql']) {
    describe(`message search (${dbType})`, () => {
        test('a chat the user is not in is refused before anything is searched', async () => {
            const { load, calls } = searchWorld(dbType);
            const { searchMessages } = load('controllers/searchController.js');
            const res = fakeRes();
            await searchMessages({ user: { id: ME }, query: { q: 'secret', chatId: FOREIGN_CHAT } }, res);
            assert.equal(res.statusCode, 403);
            assert.ok(!calls.some(call => /FROM messages m/.test(call.sql)));
        });

        test('nothing to search for is a 400', async () => {
            const { load } = searchWorld(dbType);
            const { searchMessages } = load('controllers/searchController.js');
            const res = fakeRes();
            await searchMessages({ user: { id: ME }, query: { q: '  ?? ' } }, res);
            assert.equal(res.statusCode, 400);
        });

        test('global search: only member chats, not hidden chats, no deleted messages', async () => {
            const { load, calls } = searchWorld(dbType);
            const { searchMessages } = load('controllers/searchController.js');
            const res = fakeRes();
            await searchMessages({ user: { id: ME }, query: { q: 'needle' } }, res);
            assert.equal(res.statusCode, 200);

            const call = calls.find(c => /FROM messages m/.test(c.sql));
            assert.match(call.sql, /JOIN group_members gm ON gm\.chat_id = m\.chat_id AND gm\.user_id = (\?|\$1) /);
            assert.match(call.sql, /LEFT JOIN deleted_messages dm ON dm\.message_id = m\.id AND dm\.user_id = (\?|\$2) /);
            assert.match(call.sql, /LEFT JOIN deleted_chats dc ON dc\.chat_id = m\.chat_id AND dc\.user_id = (\?|\$3) /);
            assert.match(call.sql, /dm\.id IS NULL AND \(m\.deleted_for_everyone IS NULL OR m\.deleted_for_everyone = FALSE\)/);
            assert.match(call.sql, /AND dc\.id IS NULL/);
            assert.deepEqual(call.params.slice(0, 3), [ME, ME, ME]);
            assert.match(call.sql, dbType === 'postgresql' ? /search_vector @@ to_tsquery/ : /MATCH\(m\.content\) AGAINST/);
            assert.match(call.sql, /ORDER BY m\.id DESC LIMIT 21$/);
        });

        test('in-chat search with every filter binds each value as a parameter', async () => {
            const { load, calls } = searchWorld(dbType);
            const { searchMessages } = load('controllers/searchController.js');
            const from = new Date('2026-01-01T00:00:00Z');
            const to = new Date('2026-02-01T00:00:00Z');
            const res = fakeRes();
            await searchMessages({
                user: { id: ME },
                query: { q: "x' OR 1=1 --", chatId: MY_CHAT, senderId: OTHER, from, to, has: 'link', before: 500, limit: 10 }
            }, res);
            assert.equal(res.statusCode, 200);

            const call = calls.find(c => /FROM messages m/.test(c.sql));
            assert.ok(!call.sql.includes("x'"), 'search text never reaches the SQL text');
            assert.ok(!/deleted_chats/.test(call.sql), 'an open chat is searched even if hidden from the list');
            assert.match(call.sql, /AND m\.chat_id = (\?|\$3) /);
            assert.match(call.sql, /AND m\.sender_id = /);
            assert.match(call.sql, /AND m\.created_at >= .* AND m\.created_at < /);
            assert.match(call.sql, /LIKE '%https:\/\/%'/);
            assert.match(call.sql, /AND m\.id < /);
            assert.match(call.sql, /LIMIT 11$/);
            assert.equal(call.params[2], MY_CHAT);
            assert.ok(call.params.includes(OTHER) && call.params.includes(from) && call.params.includes(to) && call.params.includes(500));
        });

        test('results: snippet with highlights, chat name, next cursor', async () => {
            const rows = [3, 2, 1].map(id => ({
                id, chat_id: MY_CHAT, sender_id: OTHER, username: 'bob', full_name: 'Bob B',
                message_type: id === 1 ? 'image' : 'text', content: id === 1 ? null : `ship the needle ${id}`,
                created_at: new Date(), file_name: id === 1 ? 'a.png' : null,
                chat_type: 'direct', chat_name: null, direct_partner_name: 'Bob B'
            }));
            const { load } = searchWorld(dbType, rows);
            const { searchMessages } = load('controllers/searchController.js');
            const res = fakeRes();
            await searchMessages({ user: { id: ME }, query: { q: 'needle', limit: 2 } }, res);

            assert.equal(res.body.data.length, 2);
            assert.deepEqual(res.body.pagination, { hasMore: true, nextCursor: 2 });
            assert.deepEqual(res.body.terms, ['needle']);
            const first = res.body.data[0];
            assert.equal(first.chat_display_name, 'Bob B');
            assert.equal(first.sender_name, 'Bob B');
            assert.equal(first.snippet.text, 'ship the needle 3');
            assert.deepEqual(first.snippet.highlights, [[9, 15]]);
            assert.ok(!('content' in first), 'only the snippet goes out');
        });
    });

    describe(`shared media (${dbType})`, () => {
        test('non-members get 403 and no query runs', async () => {
            const { load, calls } = searchWorld(dbType);
            const { getSharedMedia } = load('controllers/searchController.js');
            const res = fakeRes();
            await getSharedMedia({ user: { id: ME }, params: { chatId: FOREIGN_CHAT }, query: { type: 'media' } }, res);
            assert.equal(res.statusCode, 403);
            assert.ok(!calls.some(call => /FROM messages m/.test(call.sql)));
        });

        test('media tab: images and videos newest first, visible to the user only', async () => {
            const rows = [{ id: 40, chat_id: MY_CHAT, sender_id: OTHER, username: 'bob', message_type: 'image',
                file_name: 'a.png', file_size: 10, mime_type: 'image/png', upload_path: 'uploads/images/a.png', created_at: new Date() }];
            const { load, calls } = searchWorld(dbType, rows);
            const { getSharedMedia } = load('controllers/searchController.js');
            const res = fakeRes();
            await getSharedMedia({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { type: 'media', before: 50 } }, res);

            const call = calls.find(c => /FROM messages m/.test(c.sql));
            assert.match(call.sql, /JOIN group_members gm ON gm\.chat_id = m\.chat_id AND gm\.user_id = /);
            assert.match(call.sql, /dm\.id IS NULL AND \(m\.deleted_for_everyone IS NULL OR m\.deleted_for_everyone = FALSE\)/);
            assert.match(call.sql, /m\.message_type IN \('image', 'video'\)/);
            assert.match(call.sql, /AND m\.id < .* ORDER BY m\.id DESC LIMIT 31$/);
            assert.deepEqual(call.params, [ME, ME, MY_CHAT, 50]);
            assert.equal(res.body.data[0].message_id, 40);
            assert.equal(res.body.data[0].upload_path, 'uploads/images/a.png');
        });

        test('after cursor pages oldest first (lightbox walking forward)', async () => {
            const { load, calls } = searchWorld(dbType, []);
            const { getSharedMedia } = load('controllers/searchController.js');
            await getSharedMedia({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { after: 7 } }, fakeRes());
            assert.match(calls.find(c => /FROM messages m/.test(c.sql)).sql, /AND m\.id > .* ORDER BY m\.id ASC/);
        });

        test('links tab: URLs extracted, code-only links skipped, cursor from the raw page', async () => {
            const rows = [
                { id: 9, chat_id: MY_CHAT, sender_id: OTHER, username: 'bob', message_type: 'text', content: 'read https://a.example/x.', created_at: new Date() },
                { id: 8, chat_id: MY_CHAT, sender_id: OTHER, username: 'bob', message_type: 'text', content: '`https://code.example`', created_at: new Date() },
                { id: 7, chat_id: MY_CHAT, sender_id: OTHER, username: 'bob', message_type: 'text', content: 'https://b.example', created_at: new Date() }
            ];
            const { load } = searchWorld(dbType, rows);
            const { getSharedMedia } = load('controllers/searchController.js');
            const res = fakeRes();
            await getSharedMedia({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { type: 'links', limit: 2 } }, res);
            assert.deepEqual(res.body.data.map(item => item.urls), [['https://a.example/x']]);
            assert.deepEqual(res.body.pagination, { hasMore: true, nextCursor: 8 });
            assert.ok(!('upload_path' in res.body.data[0]));
        });
    });

    describe(`jump to a message: around/after pages (${dbType})`, () => {
        // Messages 1..100 in MY_CHAT
        function pageWorld() {
            return setupFakeDb(dbType, (rawSql, params) => {
                const sql = rawSql.replace(/\$\d+/g, '?');
                if (/^SELECT id, last_read_message_id FROM group_members/.test(sql)) {
                    return Number(params[0]) === MY_CHAT ? [{ id: 1, last_read_message_id: 100 }] : [];
                }
                if (/FROM message_reactions/.test(sql)) return [];
                const match = sql.match(/WHERE m\.chat_id = \? (?:AND m\.id (<=|<|>) \? )?AND .* ORDER BY m\.id (ASC|DESC) LIMIT (\d+)$/);
                if (!match) throw new Error(`unexpected query: ${sql}`);
                const [, op, order, limit] = match;
                const cursor = params[3];
                let ids = Array.from({ length: 100 }, (_, i) => i + 1).filter(id =>
                    !op || (op === '<=' ? id <= cursor : op === '<' ? id < cursor : id > cursor));
                if (order === 'DESC') ids.reverse();
                return ids.slice(0, Number(limit)).map(id => ({
                    id, chat_id: MY_CHAT, sender_id: OTHER, username: 'bob', message_type: 'text', content: `m${id}`,
                    created_at: new Date(), is_forwarded: 0
                }));
            });
        }

        test('around: the message in the middle, both directions flagged', async () => {
            const { load } = pageWorld();
            const { getMessages } = load('controllers/messageController.js');
            const res = fakeRes();
            await getMessages({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { around: 50, limit: 10 } }, res);
            assert.deepEqual(res.body.data.map(m => m.id), [46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
            assert.deepEqual(res.body.pagination, { hasMore: true, nextCursor: 46, hasNewer: true, newerCursor: 55 });
        });

        test('around near the end: no newer page', async () => {
            const { load } = pageWorld();
            const { getMessages } = load('controllers/messageController.js');
            const res = fakeRes();
            await getMessages({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { around: 98, limit: 10 } }, res);
            assert.deepEqual(res.body.data.map(m => m.id), [94, 95, 96, 97, 98, 99, 100]);
            assert.equal(res.body.pagination.hasNewer, false);
        });

        test('after: the next newer page, oldest first', async () => {
            const { load } = pageWorld();
            const { getMessages } = load('controllers/messageController.js');
            const res = fakeRes();
            await getMessages({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { after: 90, limit: 5 } }, res);
            assert.deepEqual(res.body.data.map(m => m.id), [91, 92, 93, 94, 95]);
            assert.deepEqual(res.body.pagination, { hasMore: false, nextCursor: null, hasNewer: true, newerCursor: 95 });
        });

        test('default and before pages are unchanged', async () => {
            const { load } = pageWorld();
            const { getMessages } = load('controllers/messageController.js');
            const latest = fakeRes();
            await getMessages({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { limit: 5 } }, latest);
            assert.deepEqual(latest.body.data.map(m => m.id), [96, 97, 98, 99, 100]);
            assert.deepEqual(latest.body.pagination, { hasMore: true, nextCursor: 96, hasNewer: false, newerCursor: null });

            const older = fakeRes();
            await getMessages({ user: { id: ME }, params: { chatId: MY_CHAT }, query: { before: 3, limit: 5 } }, older);
            assert.deepEqual(older.body.data.map(m => m.id), [1, 2]);
            assert.equal(older.body.pagination.hasMore, false);
        });

        test('around in a chat the user is not in is refused', async () => {
            const { load } = pageWorld();
            const { getMessages } = load('controllers/messageController.js');
            const res = fakeRes();
            await getMessages({ user: { id: ME }, params: { chatId: FOREIGN_CHAT }, query: { around: 50 } }, res);
            assert.equal(res.statusCode, 403);
        });
    });
}

describe('phase 7 validation', () => {
    const { load } = setupFakeDb('mysql', () => []);
    const { validateSearchQuery, validateSharedMediaQuery, validateMessagesQuery } = load('utils/validation.js');
    const { validationResult } = require('express-validator');

    async function errorsFor(rules, req) {
        const full = { body: {}, params: {}, query: {}, ...req };
        for (const rule of rules) await rule.run(full);
        return [...new Set(validationResult(full).array().map(e => e.path))];
    }

    test('search query', async () => {
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { q: 'hello', chatId: '5', senderId: '2', from: '2026-01-01', to: '2026-02-01', has: 'link', before: '99', limit: '20' } }), []);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { q: 'x'.repeat(201) } }), ['q']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { q: ['a', 'b'] } }), ['q']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { chatId: 'abc' } }), ['chatId']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { has: 'audio' } }), ['has']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { from: 'yesterday' } }), ['from']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { from: '2026-02-01', to: '2026-01-01' } }), ['to']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { limit: '51' } }), ['limit']);
        assert.deepEqual(await errorsFor(validateSearchQuery, { query: { before: '0' } }), ['before']);
    });

    test('shared media query', async () => {
        assert.deepEqual(await errorsFor(validateSharedMediaQuery, { params: { chatId: '5' }, query: { type: 'links', after: '3' } }), []);
        assert.deepEqual(await errorsFor(validateSharedMediaQuery, { params: { chatId: '5' }, query: { type: 'audio' } }), ['type']);
        assert.deepEqual(await errorsFor(validateSharedMediaQuery, { params: { chatId: 'x' }, query: {} }), ['chatId']);
        assert.deepEqual(await errorsFor(validateSharedMediaQuery, { params: { chatId: '5' }, query: { before: '3', after: '4' } }), ['after']);
    });

    test('message page query: one cursor at most', async () => {
        assert.deepEqual(await errorsFor(validateMessagesQuery, { params: { chatId: '5' }, query: { limit: '30', before: '10' } }), []);
        assert.deepEqual(await errorsFor(validateMessagesQuery, { params: { chatId: '5' }, query: { around: '10' } }), []);
        assert.deepEqual(await errorsFor(validateMessagesQuery, { params: { chatId: '5' }, query: { around: '10', after: '3' } }), ['around']);
        assert.deepEqual(await errorsFor(validateMessagesQuery, { params: { chatId: '5' }, query: { around: 'x' } }), ['around']);
        assert.deepEqual(await errorsFor(validateMessagesQuery, { params: { chatId: '5' }, query: { limit: '500' } }), ['limit']);
    });
});

describe('phase 7 routes', () => {
    test('search, media and upload limits are behind authentication', async () => {
        const fake = setupFakeDb('mysql', () => { throw new Error('no database expected'); });
        process.env.PORT = '0';
        stubModule(path.join(__dirname, '..', 'utils', 'scheduler.js'), { startScheduler() {} });
        const log = console.log;
        console.log = () => {};
        const { app, io } = fake.load('server.js');
        const server = http.createServer(app).listen(0);
        const get = (urlPath) => new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            }).on('error', reject);
        });

        try {
            assert.equal(await get('/api/messages/search?q=hello'), 401);
            assert.equal(await get('/api/chats/5/media?type=media'), 401);
            assert.equal(await get('/api/messages/upload-limits'), 401);
            assert.equal(await get('/api/messages/chat/5?around=10'), 401);
        } finally {
            await new Promise(resolve => server.close(resolve));
            await new Promise(resolve => io.close(() => resolve()));
            console.log = log;
        }
    });
});
