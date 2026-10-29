/**
 * Phase 7 acceptance check for message search.
 *
 * Seeds a group chat with 10,000 messages (plus a private chat the test user is NOT in, and
 * messages deleted for the user / for everyone), then times real searches through the search
 * controller and checks that no result comes from another chat or from a deleted message.
 *
 *   node scripts/seed-search-test.js            seed (once) and benchmark
 *   node scripts/seed-search-test.js --reset    delete the seed data and seed again
 *   node scripts/seed-search-test.js --clean    delete the seed data and stop
 *   node scripts/seed-search-test.js --count=50000
 *
 * Uses the database from .env (DB_TYPE, DB_NAME, ...); run add_message_search(_postgresql).sql first.
 * Seed accounts: search_seed_alice / search_seed_bob / search_seed_eve, password "SeedPass123".
 * Exit code 1 when a search leaks, misses expected results or takes 1 second or more.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { executeQuery, queryOne, insertAndGetId, db, dbType } = require('../config/database');
const { searchMessages } = require('../controllers/searchController');

const args = process.argv.slice(2);
const COUNT = parseInt((args.find(a => a.startsWith('--count=')) || '').split('=')[1]) || 10000;
const BIG_CHAT_NAME = 'Search seed: big chat';
const PRIVATE_CHAT_NAME = 'Search seed: private';
const USERNAMES = ['search_seed_alice', 'search_seed_bob', 'search_seed_eve'];
const BATCH = 500;
const LIMIT_MS = 1000;

const WORDS = ('the quick brown fox jumps over lazy dog meeting tomorrow lunch coffee report budget ' +
    'release deploy server database migration frontend backend weekend holiday project deadline ' +
    'invoice client design review sprint planning ticket bug fix test build pipeline').split(' ');

function randomSentence(rand) {
    const length = 5 + Math.floor(rand() * 15);
    const words = [];
    for (let i = 0; i < length; i++) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
    return words.join(' ');
}

// Deterministic, so every run seeds the same text
function seededRandom(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

async function cleanup() {
    const users = await executeQuery(
        `SELECT id FROM users WHERE username IN (${USERNAMES.map(() => '?').join(', ')})`, USERNAMES);
    await executeQuery('DELETE FROM chats WHERE chat_name IN (?, ?)', [BIG_CHAT_NAME, PRIVATE_CHAT_NAME]);
    if (users.length > 0) {
        const ids = users.map(u => u.id);
        await executeQuery(`DELETE FROM files WHERE uploaded_by IN (${ids.map(() => '?').join(', ')})`, ids);
        await executeQuery(`DELETE FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
    }
}

async function insertMessages(rows) {
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const params = [];
        for (const r of batch) {
            params.push(r.chatId, r.senderId, r.type, r.content, r.fileId || null, r.createdAt);
        }
        await executeQuery(
            `INSERT INTO messages (chat_id, sender_id, message_type, content, file_id, created_at) VALUES ${placeholders}`,
            params
        );
    }
}

async function seed() {
    const existing = await queryOne('SELECT id FROM chats WHERE chat_name = ?', [BIG_CHAT_NAME]);
    if (existing) {
        console.log('Seed data already present (use --reset to recreate it).');
        return loadSeed();
    }

    console.log(`Seeding ${COUNT} messages into "${BIG_CHAT_NAME}" (${dbType})...`);
    const passwordHash = await bcrypt.hash('SeedPass123', 10);
    const userIds = [];
    for (const username of USERNAMES) {
        userIds.push(await insertAndGetId(
            'INSERT INTO users (username, email, password_hash, full_name, email_verified_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [username, `${username}@example.invalid`, passwordHash, username.replace('search_seed_', 'Seed ')]
        ));
    }
    const [alice, bob, eve] = userIds;

    const bigChat = await insertAndGetId(
        "INSERT INTO chats (chat_type, chat_name, created_by) VALUES ('group', ?, ?)", [BIG_CHAT_NAME, alice]);
    const privateChat = await insertAndGetId(
        "INSERT INTO chats (chat_type, chat_name, created_by) VALUES ('group', ?, ?)", [PRIVATE_CHAT_NAME, bob]);
    await executeQuery(
        "INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, 'admin'), (?, ?, 'member'), (?, ?, 'admin'), (?, ?, 'member')",
        [bigChat, alice, bigChat, bob, privateChat, bob, privateChat, eve]);

    const imageFile = await insertAndGetId(
        "INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by, attached_at) VALUES ('seed.png', 'seed.png', '.png', 1024, 'image/png', 'uploads/images/seed.png', ?, CURRENT_TIMESTAMP)",
        [bob]);
    const docFile = await insertAndGetId(
        "INSERT INTO files (original_name, stored_name, file_type, file_size, mime_type, upload_path, uploaded_by, attached_at) VALUES ('seed-report.pdf', 'seed-report.pdf', '.pdf', 2048, 'application/pdf', 'uploads/files/seed-report.pdf', ?, CURRENT_TIMESTAMP)",
        [alice]);

    // Spread over the last 100 days, oldest first
    const rand = seededRandom(42);
    const start = Date.now() - 100 * 24 * 3600 * 1000;
    const step = (100 * 24 * 3600 * 1000) / COUNT;
    const rows = [];
    for (let i = 0; i < COUNT; i++) {
        const senderId = i % 3 === 0 ? bob : alice;
        const createdAt = new Date(start + i * step);
        if (i % 500 === 250) {
            rows.push({ chatId: bigChat, senderId: bob, type: 'image', content: null, fileId: imageFile, createdAt });
        } else if (i % 500 === 400) {
            rows.push({ chatId: bigChat, senderId: alice, type: 'file', content: null, fileId: docFile, createdAt });
        } else {
            let content = randomSentence(rand);
            if (i % 100 === 7) content += ' needle in the haystack';
            if (i % 250 === 9) content += ' see https://example.com/page' + i;
            rows.push({ chatId: bigChat, senderId, type: 'text', content, createdAt });
        }
    }
    await insertMessages(rows);

    // A chat alice is not in, full of the words she will search for
    const privateRows = [];
    for (let i = 0; i < 500; i++) {
        privateRows.push({ chatId: privateChat, senderId: i % 2 ? bob : eve, type: 'text',
            content: `needle secret plans ${randomSentence(rand)}`, createdAt: new Date() });
    }
    await insertMessages(privateRows);

    // One message deleted for alice only, one deleted for everyone
    const hiddenForMe = await insertAndGetId(
        "INSERT INTO messages (chat_id, sender_id, message_type, content) VALUES (?, ?, 'text', 'needle hiddenforme')",
        [bigChat, bob]);
    await executeQuery('INSERT INTO deleted_messages (message_id, user_id) VALUES (?, ?)', [hiddenForMe, alice]);
    await executeQuery(
        "INSERT INTO messages (chat_id, sender_id, message_type, content, deleted_for_everyone, deleted_at, deleted_by) VALUES (?, ?, 'text', 'needle deletedforall', TRUE, CURRENT_TIMESTAMP, ?)",
        [bigChat, bob, bob]);

    if (dbType === 'postgresql') await executeQuery('ANALYZE messages');
    console.log('Seeded.');
    return loadSeed();
}

async function loadSeed() {
    const alice = await queryOne('SELECT id FROM users WHERE username = ?', [USERNAMES[0]]);
    const bob = await queryOne('SELECT id FROM users WHERE username = ?', [USERNAMES[1]]);
    const bigChat = await queryOne('SELECT id FROM chats WHERE chat_name = ?', [BIG_CHAT_NAME]);
    const privateChat = await queryOne('SELECT id FROM chats WHERE chat_name = ?', [PRIVATE_CHAT_NAME]);
    const count = await queryOne('SELECT COUNT(*) as n FROM messages WHERE chat_id = ?', [bigChat.id]);
    return { alice: alice.id, bob: bob.id, bigChat: bigChat.id, privateChat: privateChat.id, count: parseInt(count.n) };
}

// Run the controller exactly as the route would (validated query values)
async function runSearch(userId, query) {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    const started = process.hrtime.bigint();
    await searchMessages({ user: { id: userId }, query }, res);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms, res };
}

async function benchmark(seedInfo) {
    const { alice, bob, bigChat, privateChat, count } = seedInfo;
    console.log(`\nBig chat ${bigChat}: ${count} messages. Searching as search_seed_alice (not in chat ${privateChat}).\n`);

    const day = 24 * 3600 * 1000;
    const cases = [
        { name: 'in chat: "needle"', query: { q: 'needle', chatId: bigChat }, expectResults: true },
        { name: 'in chat: prefix "deplo"', query: { q: 'deplo', chatId: bigChat }, expectResults: true },
        { name: 'in chat: "needle haystack" + sender', query: { q: 'needle haystack', chatId: bigChat, senderId: bob }, expectResults: true },
        { name: 'all chats: "needle"', query: { q: 'needle' }, expectResults: true },
        { name: 'all chats: "secret plans" (other chat only)', query: { q: 'secret plans' }, expectResults: false },
        { name: 'all chats: "the" (stopword / short)', query: { q: 'the' }, expectResults: true },
        { name: 'in chat: has=link', query: { chatId: bigChat, has: 'link' }, expectResults: true },
        { name: 'in chat: has=image', query: { chatId: bigChat, has: 'image' }, expectResults: true },
        { name: 'in chat: "budget" last 30 days', query: { q: 'budget', chatId: bigChat, from: new Date(Date.now() - 30 * day), to: new Date(Date.now() + day) }, expectResults: true },
        { name: 'all chats: "zzzznothing"', query: { q: 'zzzznothing' }, expectResults: false }
    ];

    let failed = false;
    const rows = [];
    for (const testCase of cases) {
        await runSearch(alice, testCase.query); // warm up
        const times = [];
        let last;
        for (let i = 0; i < 5; i++) {
            last = await runSearch(alice, testCase.query);
            times.push(last.ms);
        }
        times.sort((a, b) => a - b);
        const median = times[2];
        const body = last.res.body;
        const results = (body && body.data) || [];

        const problems = [];
        if (last.res.statusCode !== 200) problems.push(`HTTP ${last.res.statusCode}`);
        if (results.some(r => r.chat_id !== bigChat)) problems.push('LEAK: result from another chat');
        if (results.some(r => r.snippet && /hiddenforme|deletedforall/.test(r.snippet.text))) problems.push('LEAK: deleted message');
        if (testCase.expectResults && results.length === 0) problems.push('no results');
        if (!testCase.expectResults && results.length > 0) problems.push('unexpected results');
        if (median >= LIMIT_MS) problems.push(`slow (${median.toFixed(0)} ms)`);
        if (problems.length > 0) failed = true;

        rows.push({
            search: testCase.name,
            'median ms': median.toFixed(1),
            results: results.length + (body && body.pagination && body.pagination.hasMore ? '+' : ''),
            check: problems.length ? problems.join('; ') : 'ok'
        });
    }
    console.table(rows);

    // Paging through every "needle" result must also stay inside the chat
    let cursor = null;
    let total = 0;
    do {
        const { res } = await runSearch(alice, { q: 'needle', limit: 50, ...(cursor ? { before: cursor } : {}) });
        if (res.body.data.some(r => r.chat_id !== bigChat)) {
            console.log('LEAK while paging');
            failed = true;
        }
        total += res.body.data.length;
        cursor = res.body.pagination.nextCursor;
    } while (cursor);
    const expected = Math.floor((count - 2 + 92) / 100); // i % 100 === 7, minus the two deleted ones
    console.log(`Paged through ${total} "needle" results (about ${expected} expected).`);

    return failed;
}

async function main() {
    if (process.env.NODE_ENV === 'production' && !args.includes('--force')) {
        console.error('Refusing to seed a production database (pass --force to override).');
        return 1;
    }

    if (args.includes('--clean') || args.includes('--reset')) {
        await cleanup();
        console.log('Seed data removed.');
        if (args.includes('--clean')) return 0;
    }

    const seedInfo = await seed();
    const failed = await benchmark(seedInfo);
    console.log(failed ? '\nFAILED' : `\nPASSED: every search under ${LIMIT_MS} ms and nothing leaked.`);
    return failed ? 1 : 0;
}

main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => (db && db.end ? db.end() : null));
