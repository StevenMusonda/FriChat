/**
 * Phase 13 frontend rules, read from the real files: reported content and admin data never go
 * through innerHTML, the report menu only shows on other people's messages, the console page and
 * scripts are wired up, and the console link hangs on the server's flag.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

describe('phase 13 frontend', () => {
    test('moderation.js and admin.js never use innerHTML or document.write', () => {
        for (const file of ['js/moderation.js', 'js/admin.js']) {
            const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
            assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), file);
        }
    });

    test('the Report item is only for other people\'s messages, never chat notices', () => {
        const code = read('js/messageActions.js');
        assert.match(code, /\$\{!isSent && message\.message_type !== 'system' \? `\s*<div class="message-action-item danger" onclick="reportMessage\(\$\{messageId\}\)">/);
    });

    test('the report dialog offers every reason and the block', () => {
        const code = read('js/moderation.js');
        for (const reason of ['spam', 'harassment', 'inappropriate', 'other']) assert.ok(code.includes(`value: '${reason}'`));
        assert.match(code, /block: block\.checked/);
    });

    test('chat.html loads moderation.js and starts it; the console link starts hidden', () => {
        const page = read('chat.html');
        assert.ok(page.includes('<script src="js/moderation.js"></script>'));
        assert.ok(page.includes("FriChat.initializeModeration()"));
        assert.match(page, /id="adminConsoleSection"[^>]*\shidden/);
    });

    test('admin.html has the three tabs, starts hidden and has no inline script', () => {
        const page = read('admin.html');
        for (const tab of ['reports', 'users', 'audit']) {
            assert.ok(page.includes(`data-admin-tab="${tab}"`));
            assert.ok(page.includes(`data-admin-panel="${tab}"`));
        }
        assert.match(page, /id="adminConsole" hidden/);
        assert.ok(!/<script>/.test(page));
        assert.match(page, /noindex/);
    });

    test('the console is only opened by the server\'s answer, not by the stored flag', () => {
        const code = read('js/admin.js');
        assert.ok(!code.includes('getCurrentUser'), 'admin.js must not trust the local copy of the flag');
        assert.match(code, /ADMIN_CONFIG/);
    });

    test('the service worker caches the new script and the shell version moved', () => {
        const worker = read('sw.js');
        assert.ok(worker.includes("'js/moderation.js'"));
        assert.ok(!worker.includes("'js/admin.js'"), 'the console is not an offline page');
    });

    test('suspension reaches the login page', () => {
        assert.match(read('js/websocket.js'), /'suspended'/);
        assert.match(read('login.html'), /suspended: 'This account has been suspended\.'/);
    });
});
