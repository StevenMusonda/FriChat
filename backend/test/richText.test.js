/**
 * Phase 4 formatting, loaded from the real frontend files: the whitelist formatter
 * (frontend/js/formatter.js) never lets user HTML through, keeps its own tags balanced and only
 * links http(s); the message renderer shows mentions, highlights and preview cards safely; and the
 * @mention autocomplete helpers (frontend/js/mentions.js) find the right query and members.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const { formatMessageText, safeHttpUrl } = require(path.join(FRONTEND, 'formatter.js'));
const { findMentionQuery, matchMentionMembers } = require(path.join(FRONTEND, 'mentions.js'));

const ALLOWED_TAG = /^<\/?(strong|em|del|code|pre|span|div|a|button)\b/;

// Every tag in the output is one the formatter makes, and each opened tag is closed in order
function assertSafeAndBalanced(html, input) {
    const stack = [];
    for (const match of html.matchAll(/<\/?([a-z]+)\b[^>]*>/g)) {
        const [tag, name] = match;
        assert.match(tag, ALLOWED_TAG, `unexpected tag ${tag} for ${JSON.stringify(input)}`);
        assert.ok(!/\son[a-z]+=/i.test(tag), `event handler attribute in ${tag}`);
        if (tag.startsWith('</')) {
            assert.equal(stack.pop(), name, `misnested ${tag} for ${JSON.stringify(input)}: ${html}`);
        } else {
            stack.push(name);
        }
    }
    assert.deepEqual(stack, [], `unclosed tags for ${JSON.stringify(input)}: ${html}`);
    assert.ok(!/href="(?!https?:)/i.test(html), `non-http link in ${html}`);
}

describe('formatter: user HTML is always text', () => {
    const payloads = [
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(\'xss\')">',
        '<b>bold?</b> <a href="javascript:alert(1)">x</a>',
        '**<script>alert(1)</script>**',
        '`<script>alert(1)</script>`',
        '```html\n<script>alert(1)</script>\n```',
        '_<svg onload=alert(1)>_',
        'https://example.com/"><script>alert(1)</script>',
        'https://example.com/<img src=x onerror=alert(1)>',
        '@bob<script>alert(1)</script>'
    ];

    for (const payload of payloads) {
        test(`renders ${JSON.stringify(payload)} as plain text`, () => {
            const html = formatMessageText(payload, { mentions: [{ user_id: 2, username: 'bob' }] });
            assert.ok(!/<script/i.test(html), html);
            assert.ok(!/<img/i.test(html), html);
            assert.ok(!/<svg/i.test(html), html);
            assert.ok(!/<a href="javascript/i.test(html), html);
            assertSafeAndBalanced(html, payload);
        });
    }

    test('random markup soup never produces unbalanced or foreign tags', () => {
        const pieces = ['**', '_', '~', '`', '```', '\n', ' ', 'a', 'b_c', '<', '>', '"', "'", '&', '@bob', 'https://x.io/a_b', '(', ')', '.', 'ä'];
        let seed = 42;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let run = 0; run < 3000; run++) {
            let input = '';
            const length = 1 + Math.floor(random() * 25);
            for (let i = 0; i < length; i++) input += pieces[Math.floor(random() * pieces.length)];
            const html = formatMessageText(input, { mentions: [{ user_id: 2, username: 'bob' }], currentUserId: 2 });
            assertSafeAndBalanced(html, input);
            // Nothing the user typed survives as a raw '<'
            assert.ok(!/<(?![a-z/])/.test(html), `raw < in ${html}`);
        }
    });
});

describe('formatter: supported syntax', () => {
    test('bold, italic, strike and inline code', () => {
        assert.equal(formatMessageText('**b** _i_ ~s~ `c`'), '<strong>b</strong> <em>i</em> <del>s</del> <code class="inline-code">c</code>');
    });

    test('markers can nest; crossed or unclosed markers stay literal', () => {
        assert.equal(formatMessageText('_**x**_'), '<em><strong>x</strong></em>');
        assert.equal(formatMessageText('**a _b** c_'), '<strong>a _b</strong> c_');
        assert.equal(formatMessageText('**open'), '**open');
        assert.equal(formatMessageText('** spaced **'), '** spaced **');
    });

    test('underscores and tildes inside words are not formatting', () => {
        assert.equal(formatMessageText('snake_case_name file_name.txt'), 'snake_case_name file_name.txt');
        assert.equal(formatMessageText('about ~5 to ~10'), 'about ~5 to ~10');
    });

    test('emphasis does not cross lines and line breaks are kept', () => {
        assert.equal(formatMessageText('**a\nb**'), '**a\nb**');
    });

    test('code spans are not formatted inside', () => {
        assert.equal(formatMessageText('`**not bold** https://x.io`'), '<code class="inline-code">**not bold** https://x.io</code>');
    });

    test('fenced code blocks get a language label and a copy button, with the code escaped', () => {
        const html = formatMessageText('before\n```js\nconst a = "<b>";\n```\nafter');
        assert.equal(html,
            'before<div class="code-block"><div class="code-block-header"><span class="code-block-lang">js</span>'
            + '<button type="button" class="code-copy-btn" data-copy-code aria-label="Copy code">Copy</button></div>'
            + '<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre></div>after');
    });

    test('a block with no language and an empty fence', () => {
        assert.match(formatMessageText('```x = 1```'), /code-block-lang">code<\/span>.*<code>x = 1<\/code>/);
        assert.equal(formatMessageText('``````'), '``````');
    });

    test('http(s) URLs become safe links; trailing punctuation stays outside', () => {
        assert.equal(
            formatMessageText('see https://example.com/a_b?x=1&y=2.'),
            'see <a href="https://example.com/a_b?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow ugc">https://example.com/a_b?x=1&amp;y=2</a>.'
        );
        assert.match(formatMessageText('(https://en.wikipedia.org/wiki/Foo_(bar))'), /href="https:\/\/en.wikipedia.org\/wiki\/Foo_\(bar\)"/);
        assert.equal(formatMessageText('javascript:alert(1) ftp://x.io'), 'javascript:alert(1) ftp://x.io');
        assert.match(formatMessageText('**https://x.io**'), /^<strong><a href="https:\/\/x.io\/"/);
    });

    test('only stored mentions are highlighted, your own one stands out', () => {
        const mentions = [{ user_id: 2, username: 'Bob' }, { user_id: 3, username: 'carol' }];
        const html = formatMessageText('@bob @carol @nobody mail@bob.com', { mentions, currentUserId: 2 });
        assert.equal(html, '<span class="mention mention-me">@bob</span> <span class="mention">@carol</span> @nobody mail@bob.com');
    });

    test('safeHttpUrl accepts only http and https', () => {
        assert.equal(safeHttpUrl('https://x.io/a'), 'https://x.io/a');
        assert.equal(safeHttpUrl('javascript:alert(1)'), null);
        assert.equal(safeHttpUrl('data:text/html,hi'), null);
        assert.equal(safeHttpUrl(''), null);
        assert.equal(safeHttpUrl(null), null);
    });
});

/**
 * messages.js rendering with the real formatter and escapeHtml
 */
function loadRenderer() {
    const chatJs = fs.readFileSync(path.join(FRONTEND, 'chat.js'), 'utf8');
    const sandbox = {
        URL,
        console: { log() {}, error() {} },
        getCurrentUser: () => ({ userId: 1 }),
        formatTime: () => '12:00',
        FORWARD_ICON_SVG: '',
        CONFIG: { SOCKET_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000/api' }
    };
    vm.createContext(sandbox);
    vm.runInContext(chatJs.match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/)[0], sandbox);
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'formatter.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'messages.js'), 'utf8'), sandbox);
    return sandbox;
}

describe('message rendering', () => {
    const base = { id: 7, chat_id: 5, sender_id: 2, username: 'bob', message_type: 'text', created_at: new Date().toISOString(), mentions: [] };

    test('a message mentioning me is highlighted', () => {
        const r = loadRenderer();
        const html = r.renderMessageHtml({ ...base, content: 'hey @meg', mentions: [{ user_id: 1, username: 'meg' }] });
        assert.match(html, /class="message received\s+mentioned"/);
        assert.match(html, /<span class="mention mention-me">@meg<\/span>/);
        assert.doesNotMatch(r.renderMessageHtml({ ...base, content: 'hey' }), /mentioned/);
    });

    test('preview card fields are escaped and only http(s) links/images are used', () => {
        const r = loadRenderer();
        const html = r.renderMessageHtml({
            ...base,
            content: 'https://x.io',
            link_preview: {
                url: 'https://x.io/',
                title: '<script>alert(1)</script>',
                description: '"><img src=x onerror=alert(1)>',
                image_url: 'javascript:alert(1)',
                site_name: 'X & Co'
            }
        });
        assert.ok(!/<script/i.test(html));
        assert.ok(!/<img[^>]*onerror=alert/i.test(html));
        assert.ok(!html.includes('javascript:'));
        assert.match(html, /link-preview-title">&lt;script&gt;/);
        assert.match(html, /X &amp; Co/);
        assert.doesNotMatch(html, /link-preview-dismiss/, 'only the sender can dismiss');
    });

    test('the sender gets a dismiss button, and a non-http preview URL renders no card', () => {
        const r = loadRenderer();
        const mine = r.renderMessageHtml({ ...base, sender_id: 1, content: 'x', link_preview: { url: 'https://x.io/', title: 'T' } });
        assert.match(mine, /data-dismiss-preview="7"/);

        const bad = r.renderMessageHtml({ ...base, content: 'x', link_preview: { url: 'javascript:alert(1)', title: 'T' } });
        assert.doesNotMatch(bad, /link-preview/);
    });
});

describe('mention autocomplete helpers', () => {
    test('finds the @query right before the caret', () => {
        assert.deepEqual(findMentionQuery('hi @bo', 6), { start: 3, query: 'bo' });
        assert.deepEqual(findMentionQuery('@', 1), { start: 0, query: '' });
        assert.equal(findMentionQuery('mail@bo', 7), null, 'e-mail addresses do not open the list');
        assert.equal(findMentionQuery('hi @bob there', 13), null);
        assert.deepEqual(findMentionQuery('hi @bob there', 7), { start: 3, query: 'bob' });
    });

    test('matches username prefixes first, then name words, then substrings, at most 6', () => {
        const members = [
            { id: 2, username: 'robert', full_name: 'Bob Stone' },
            { id: 3, username: 'bobby', full_name: 'Robert Small' },
            { id: 4, username: 'jimbo', full_name: 'Jim' },
            { id: 5, username: 'alice', full_name: 'Alice' }
        ];
        assert.deepEqual(matchMentionMembers(members, 'bo').map(m => m.username), ['bobby', 'robert', 'jimbo']);
        assert.deepEqual(matchMentionMembers(members, '').length, 4);
        const many = Array.from({ length: 10 }, (_, i) => ({ id: i, username: `user${i}` }));
        assert.equal(matchMentionMembers(many, 'user').length, 6);
    });
});
