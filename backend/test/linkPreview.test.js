/**
 * Phase 4 link previews: SSRF protection of the server-side fetch (schemes, private/loopback/
 * link-local addresses, DNS answers and redirects, timeout, size cap), Open Graph parsing,
 * the cache, attaching to messages on both databases, and the sender-only dismiss endpoint.
 *
 * Only local test servers are contacted. They listen on 127.0.0.1, which the real policy
 * refuses, so the tests that need a working fetch pass a policy that also allows 127.0.0.1.
 * DNS is stubbed for *.test names.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const dns = require('dns');
const { setupFakeDb, fakeRes, fakeIo } = require('./helpers/fakeDb');

const { load } = setupFakeDb('mysql', () => []);
const lp = load('utils/linkPreview.js');

const allowLoopback = (ip) => ip === '127.0.0.1' || lp.isPublicAddress(ip);

// Fake DNS for *.test names; everything else goes to the real resolver
const FAKE_DNS = {
    'site.test': [{ address: '127.0.0.1', family: 4 }],
    'internal.test': [{ address: '10.1.2.3', family: 4 }],
    'metadata.test': [{ address: '169.254.169.254', family: 4 }],
    'mixed.test': [{ address: '127.0.0.1', family: 4 }, { address: '192.168.1.10', family: 4 }],
    'v6loop.test': [{ address: '::1', family: 6 }]
};
const realLookup = dns.lookup;
before(() => {
    dns.lookup = (hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        if (FAKE_DNS[hostname]) {
            const answers = FAKE_DNS[hostname];
            return process.nextTick(() => options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family));
        }
        return realLookup(hostname, options, callback);
    };
});
after(() => { dns.lookup = realLookup; });

/**
 * A local server whose routes are (req, res) handlers; counts every request it gets
 */
async function startServer(routes) {
    const server = http.createServer((req, res) => {
        server.hits.push(req.url);
        const route = routes[req.url.split('?')[0]];
        if (route) return route(req, res);
        res.writeHead(404).end();
    });
    server.hits = [];
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    server.base = `http://127.0.0.1:${server.address().port}`;
    server.port = server.address().port;
    return server;
}

const PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Fallback title</title>
<meta property="og:title" content="Tom &amp; Jerry &#8211; the &quot;movie&quot;">
<meta property="og:description" content="  A cat\nand a   mouse.  ">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="Cartoons">
</head><body>hello</body></html>`;

const html = (body, extra = {}) => (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra });
    res.end(body);
};
const redirect = (location, code = 302) => (req, res) => {
    res.writeHead(code, { Location: location }).end();
};

describe('isPublicAddress', () => {
    const blocked = [
        '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '169.254.0.1',
        '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '240.0.0.1',
        '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1',
        '2002:7f00:1::', '2001:db8::1', '2001::1', 'ff02::1', 'fec0::1', 'not-an-ip'
    ];
    for (const ip of blocked) {
        test(`blocks ${ip}`, () => assert.equal(lp.isPublicAddress(ip), false));
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
        test(`allows ${ip}`, () => assert.equal(lp.isPublicAddress(ip), true));
    }
});

describe('URL rules', () => {
    test('only http(s) without credentials or localhost names', () => {
        assert.equal(lp.normalizeUrl('https://example.com/a#frag'), 'https://example.com/a');
        for (const bad of ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x/', 'http://user:pass@example.com/',
            'http://localhost/', 'http://LOCALHOST./', 'http://app.localhost/', `http://x.com/${'a'.repeat(2100)}`, '']) {
            assert.equal(lp.normalizeUrl(bad), null, bad);
        }
    });

    test('first URL in the text, skipping code and trailing punctuation', () => {
        assert.equal(lp.extractFirstUrl('see https://a.example/x.'), 'https://a.example/x');
        assert.equal(lp.extractFirstUrl('`https://code.example` then (https://b.example/p)'), 'https://b.example/p');
        assert.equal(lp.extractFirstUrl('```\nhttps://code.example\n```'), null);
        assert.equal(lp.extractFirstUrl('no links, javascript:alert(1)'), null);
    });
});

describe('fetchPage refuses internal targets (SSRF)', () => {
    let server;
    before(async () => { server = await startServer({ '/': html(PAGE) }); });
    after(() => server.close());

    const refused = [
        ['http://localhost', 'http://localhost/'],
        ['http://localhost with port', 'http://localhost:3000/api/health'],
        ['169.254.169.254 (cloud metadata)', 'http://169.254.169.254/latest/meta-data/'],
        ['169.254.x.x', 'http://169.254.10.20/'],
        ['10.x private', 'http://10.0.0.1/'],
        ['192.168.x private', 'https://192.168.0.1/'],
        ['IPv6 loopback', 'http://[::1]/'],
        ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
        ['decimal-encoded 127.0.0.1', 'http://2130706433/'],
        ['hex-encoded 127.0.0.1', 'http://0x7f.0.0.1/'],
        ['0.0.0.0', 'http://0.0.0.0/'],
        ['a name that resolves to a private address', 'http://internal.test/'],
        ['a name that resolves to the metadata address', 'http://metadata.test/'],
        ['a name with one private answer among others', 'http://mixed.test/'],
        ['a name that resolves to ::1', 'http://v6loop.test/'],
        ['file://', 'file:///etc/passwd'],
        ['ftp://', 'ftp://example.com/']
    ];
    for (const [label, url] of refused) {
        test(`refuses ${label}`, async () => {
            await assert.rejects(lp.fetchPage(url), (error) => error.code === 'EBLOCKED' || /not a public address|cannot be previewed|Only public/.test(error.message));
        });
    }

    test('the real policy never even connects to the loopback test server', async () => {
        await assert.rejects(lp.fetchPage(`${server.base}/`), { code: 'EBLOCKED' });
        await assert.rejects(lp.fetchPage(`http://site.test:${server.port}/`), { code: 'EBLOCKED' });
        assert.deepEqual(server.hits, []);
    });
});

describe('fetchPage with a policy that allows the test server', () => {
    let server;
    before(async () => {
        server = await startServer({
            '/': html(PAGE),
            '/to-metadata': redirect('http://169.254.169.254/latest/meta-data/'),
            '/to-localhost': redirect('http://localhost/'),
            '/to-v6': redirect('http://[::1]:80/'),
            '/to-internal': redirect('http://internal.test/'),
            '/to-file': redirect('file:///etc/passwd'),
            '/relative': redirect('/'),
            '/loop1': redirect('/loop2'),
            '/loop2': redirect('/loop3'),
            '/loop3': redirect('/loop4'),
            '/loop4': redirect('/'),
            '/hang': () => { /* never answers */ },
            '/huge': (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.write('<html><head><meta property="og:title" content="Big"></head><body>');
                const chunk = 'x'.repeat(64 * 1024);
                let sent = 0;
                const pump = () => {
                    while (sent < 4 * 1024 * 1024) {
                        sent += chunk.length;
                        if (!res.write(chunk)) return res.once('drain', pump);
                    }
                    res.end();
                };
                pump();
            },
            '/gzip-bomb': (req, res) => {
                const head = Buffer.from('<html><head><meta property="og:title" content="Zipped"></head>');
                const body = zlib.gzipSync(Buffer.concat([head, Buffer.alloc(20 * 1024 * 1024, 0x20)]));
                res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
                res.end(body);
            },
            '/image': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }).end('png'); }
        });
    });
    after(() => server.close());

    const opts = { isAddressAllowed: allowLoopback };

    test('fetches a page and parses its Open Graph tags', async () => {
        const data = await lp.fetchPreviewData(`${server.base}/`, opts);
        assert.deepEqual(data, {
            title: 'Tom & Jerry – the "movie"',
            description: 'A cat and a mouse.',
            // The relative image resolves to 127.0.0.1: viewers' browsers are never pointed at private addresses
            imageUrl: null,
            siteName: 'Cartoons'
        });
    });

    test('hostnames go through the guarded DNS lookup', async () => {
        const data = await lp.fetchPreviewData(`http://site.test:${server.port}/`, opts);
        assert.equal(data.title, 'Tom & Jerry – the "movie"');
    });

    for (const [route, label] of [
        ['/to-metadata', '169.254.169.254'], ['/to-localhost', 'localhost'], ['/to-v6', '[::1]'],
        ['/to-internal', 'a name resolving to 10.x'], ['/to-file', 'file://']
    ]) {
        test(`a redirect to ${label} is refused`, async () => {
            await assert.rejects(lp.fetchPage(`${server.base}${route}`, opts), { code: 'EBLOCKED' });
        });
    }

    test('relative redirects are followed, too many are not', async () => {
        const page = await lp.fetchPage(`${server.base}/relative`, opts);
        assert.equal(page.finalUrl, `${server.base}/`);
        await assert.rejects(lp.fetchPage(`${server.base}/loop1`, opts), /Too many redirects/);
        assert.equal(lp.MAX_REDIRECTS, 3);
    });

    test('times out (default 5 seconds; shortened here)', async () => {
        assert.equal(lp.TIMEOUT_MS, 5000);
        const started = Date.now();
        await assert.rejects(lp.fetchPage(`${server.base}/hang`, { ...opts, timeoutMs: 300 }), { code: 'ETIMEOUT' });
        assert.ok(Date.now() - started < 2000);
    });

    test('reads at most the size cap, also after decompression', async () => {
        assert.equal(lp.MAX_BYTES, 512 * 1024);
        const big = await lp.fetchPage(`${server.base}/huge`, { ...opts, maxBytes: 32 * 1024 });
        assert.ok(big.body.length <= 32 * 1024, `read ${big.body.length} bytes`);

        const zipped = await lp.fetchPage(`${server.base}/gzip-bomb`, { ...opts, maxBytes: 32 * 1024 });
        assert.ok(zipped.body.length <= 32 * 1024, `read ${zipped.body.length} bytes`);
        assert.equal((await lp.fetchPreviewData(`${server.base}/gzip-bomb`, opts)).title, 'Zipped');
    });

    test('non-HTML responses give no preview', async () => {
        await assert.rejects(lp.fetchPage(`${server.base}/image`, opts), /No HTML page/);
        await assert.rejects(lp.fetchPage(`${server.base}/missing`, opts), /No HTML page \(status 404\)/);
    });
});

describe('parseOpenGraph', () => {
    test('falls back to <title> and meta description', () => {
        const data = lp.parseOpenGraph('<head><title>Plain</title><meta name="description" content="Desc"></head>', 'https://www.example.com/a');
        assert.deepEqual(data, { title: 'Plain', description: 'Desc', imageUrl: null, siteName: 'example.com' });
    });

    test('drops images that point at private addresses or non-http schemes', () => {
        const page = (src) => `<head><meta property="og:title" content="T"><meta property="og:image" content="${src}"></head>`;
        assert.equal(lp.parseOpenGraph(page('http://169.254.169.254/x.png'), 'https://e.com/').imageUrl, null);
        assert.equal(lp.parseOpenGraph(page('http://localhost/x.png'), 'https://e.com/').imageUrl, null);
        assert.equal(lp.parseOpenGraph(page('javascript:alert(1)'), 'https://e.com/').imageUrl, null);
        assert.equal(lp.parseOpenGraph(page('https://cdn.e.com/x.png'), 'https://e.com/').imageUrl, 'https://cdn.e.com/x.png');
    });

    test('keeps HTML in titles as text (escaped later by the frontend) and caps lengths', () => {
        const data = lp.parseOpenGraph(`<head><meta property="og:title" content="&lt;script&gt;x&lt;/script&gt;"><meta property="og:description" content="${'d'.repeat(900)}"></head>`, 'https://e.com/');
        assert.equal(data.title, '<script>x</script>');
        assert.equal(data.description.length, 500);
    });

    test('nothing to show gives null', () => {
        assert.equal(lp.parseOpenGraph('<html><body>no head</body></html>', 'https://e.com/'), null);
    });
});

for (const dbType of ['mysql', 'postgresql']) {
    describe(`attachLinkPreview and the cache (${dbType})`, () => {
        function setup({ dismissed = false } = {}) {
            const pg = dbType === 'postgresql';
            const world = { cache: {}, nextPreviewId: 1, message: { id: 50, link_preview_id: null, dismissed }, cacheSql: null };
            const written = () => pg ? [] : { affectedRows: 1 };
            const fake = setupFakeDb(dbType, (rawSql, params) => {
                const sql = rawSql.replace(/\$\d+/g, '?');
                if (/FROM link_previews WHERE url_hash = \?/.test(sql)) {
                    world.cacheSql = sql;
                    const row = world.cache[params[0]];
                    return row ? [{ ...row }] : [];
                }
                if (/^INSERT INTO link_previews/.test(sql)) {
                    const [url_hash, url, status, title, description, image_url, site_name] = params;
                    const existing = world.cache[url_hash];
                    world.cache[url_hash] = { id: existing ? existing.id : world.nextPreviewId++, url, status, title, description, image_url, site_name, is_fresh: 1 };
                    return written();
                }
                if (/^UPDATE messages SET link_preview_id = \? WHERE id = \? AND link_preview_dismissed = FALSE/.test(sql)) {
                    if (!world.message.dismissed) world.message.link_preview_id = params[0];
                    return written();
                }
                if (/^SELECT link_preview_id FROM messages WHERE id = \?/.test(sql)) return [{ link_preview_id: world.message.link_preview_id }];
                if (/^UPDATE messages SET link_preview_id = NULL WHERE id = \?/.test(sql)) {
                    world.message.link_preview_id = null;
                    return written();
                }
                // Phase 6 block checks: nobody is blocked in these tests
                if (/user_blocks/.test(sql)) return [];
                throw new Error(`Unexpected query: ${sql}`);
            });
            const module = fake.load('utils/linkPreview.js');
            const fetched = [];
            module.setPreviewFetcher(async (url) => {
                fetched.push(url);
                if (url.includes('empty')) return null;
                return { title: 'Example', description: 'An example page', imageUrl: 'https://e.com/i.png', siteName: 'Example' };
            });
            return { world, lp: module, fetched };
        }
        const message = (content, extra = {}) => ({ id: 50, chat_id: 5, sender_id: 1, message_type: 'text', content, ...extra });

        test('fetches once, stores the preview with the message and tells the chat', async () => {
            const { world, lp: mod, fetched } = setup();
            const io = fakeIo();
            const preview = await mod.attachLinkPreview(io, message('look https://e.com/page'));

            assert.deepEqual(fetched, ['https://e.com/page']);
            assert.equal(world.message.link_preview_id, 1);
            assert.deepEqual(preview, { url: 'https://e.com/page', title: 'Example', description: 'An example page', image_url: 'https://e.com/i.png', site_name: 'Example' });
            assert.deepEqual(io.emitted, [{ room: 'chat_5', event: 'message_link_preview', data: { messageId: 50, chatId: 5, preview } }]);
            const expected = dbType === 'postgresql' ? "INTERVAL '24 hours'" : 'INTERVAL 24 HOUR';
            assert.ok(world.cacheSql.includes(expected), world.cacheSql);
        });

        test('a fresh cache entry is reused without fetching', async () => {
            const { lp: mod, fetched } = setup();
            await mod.attachLinkPreview(fakeIo(), message('https://e.com/page'));
            await mod.attachLinkPreview(fakeIo(), message('again https://e.com/page'));
            assert.equal(fetched.length, 1);
        });

        test('pages without a preview are cached as failed and show nothing', async () => {
            const { world, lp: mod, fetched } = setup();
            const io = fakeIo();
            assert.equal(await mod.attachLinkPreview(io, message('https://e.com/empty')), null);
            assert.equal(await mod.attachLinkPreview(io, message('https://e.com/empty')), null);
            assert.equal(fetched.length, 1);
            assert.equal(Object.values(world.cache)[0].status, 'failed');
            assert.equal(io.emitted.length, 0);
        });

        test('internal URLs are refused by the real fetcher and nothing is attached', async () => {
            const { world, lp: mod } = setup();
            mod.setPreviewFetcher(null); // back to the real, guarded fetch
            const warn = console.warn;
            console.warn = () => {};
            const io = fakeIo();
            try {
                assert.equal(await mod.attachLinkPreview(io, message('http://169.254.169.254/latest/meta-data/')), null);
                assert.equal(await mod.attachLinkPreview(io, message('http://localhost:3000/')), null);
            } finally {
                console.warn = warn;
            }
            assert.equal(world.message.link_preview_id, null);
            assert.equal(io.emitted.length, 0);
            assert.ok(Object.values(world.cache).every(row => row.status === 'failed'));
        });

        test('a dismissed message never gets a preview again', async () => {
            const { world, lp: mod } = setup({ dismissed: true });
            const io = fakeIo();
            assert.equal(await mod.attachLinkPreview(io, message('https://e.com/page')), null);
            assert.equal(world.message.link_preview_id, null);
            assert.equal(io.emitted.length, 0);
        });

        test('an edit that removes the link clears the old preview', async () => {
            const { world, lp: mod } = setup();
            world.message.link_preview_id = 9;
            const io = fakeIo();
            await mod.attachLinkPreview(io, message('no link now'), { hadPreview: true });
            assert.equal(world.message.link_preview_id, null);
            assert.equal(io.emitted[0].data.preview, null);
        });

        test('media messages, no URL and LINK_PREVIEWS_ENABLED=false do nothing', async () => {
            const { lp: mod, fetched } = setup();
            await mod.attachLinkPreview(fakeIo(), message('https://e.com/a', { message_type: 'image' }));
            await mod.attachLinkPreview(fakeIo(), message('plain text'));
            process.env.LINK_PREVIEWS_ENABLED = 'false';
            try {
                await mod.attachLinkPreview(fakeIo(), message('https://e.com/b'));
            } finally {
                delete process.env.LINK_PREVIEWS_ENABLED;
            }
            assert.deepEqual(fetched, []);
        });

        test('a sender gets at most 20 preview fetches a minute', async () => {
            const { lp: mod, fetched } = setup();
            for (let i = 0; i < 25; i++) {
                await mod.attachLinkPreview(fakeIo(), message(`https://e.com/p${i}`));
            }
            assert.equal(fetched.length, 20);
        });
    });

    describe(`dismiss link preview endpoint (${dbType})`, () => {
        function setup() {
            const world = { updates: [] };
            const fake = setupFakeDb(dbType, (rawSql, params) => {
                const sql = rawSql.replace(/\$\d+/g, '?');
                if (/^SELECT m.id, m.chat_id, m.sender_id FROM messages m JOIN group_members gm/.test(sql)) {
                    const [userId, messageId] = params;
                    const messages = { 60: { id: 60, chat_id: 5, sender_id: 1 }, 61: { id: 61, chat_id: 5, sender_id: 2 }, 62: { id: 62, chat_id: 9, sender_id: 2 } };
                    const m = messages[messageId];
                    return m && (m.chat_id === 5 || userId === 2) ? [m] : [];
                }
                if (/^UPDATE messages SET link_preview_id = NULL, link_preview_dismissed = TRUE WHERE id = \? AND sender_id = \?/.test(sql)) {
                    world.updates.push(params);
                    return dbType === 'mysql' ? { affectedRows: 1 } : [];
                }
                // Phase 6 block checks: nobody is blocked in these tests
                if (/user_blocks/.test(sql)) return [];
                throw new Error(`Unexpected query: ${sql}`);
            });
            return { world, controller: fake.load('controllers/messageController.js') };
        }

        async function dismiss(controller, messageId) {
            const res = fakeRes();
            const io = fakeIo();
            await controller.dismissLinkPreview({ user: { id: 1 }, params: { messageId }, io }, res);
            return { res, io };
        }

        test('the sender can remove the preview and the chat is told', async () => {
            const { world, controller } = setup();
            const { res, io } = await dismiss(controller, 60);
            assert.equal(res.statusCode, 200);
            assert.deepEqual(world.updates, [[60, 1]]);
            assert.deepEqual(io.emitted, [{ room: 'chat_5', event: 'message_link_preview', data: { messageId: 60, chatId: 5, preview: null } }]);
        });

        test('another member cannot (403) and a non-member gets 404', async () => {
            const { world, controller } = setup();
            assert.equal((await dismiss(controller, 61)).res.statusCode, 403);
            assert.equal((await dismiss(controller, 62)).res.statusCode, 404);
            assert.equal((await dismiss(controller, 999)).res.statusCode, 404);
            assert.deepEqual(world.updates, []);
        });
    });
}
