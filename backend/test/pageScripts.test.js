/**
 * Page scripts: every page's scripts, loaded the way the browser loads them.
 *
 * Classic <script> files share one global scope, so two files declaring the same top-level
 * const/let/class is a SyntaxError that drops the second file entirely (phase 10: PLAY_ICON_SVG in
 * media.js and voice.js), and then chat.html's startup called a function that no longer existed.
 * For each HTML page this runs all of its scripts, in document order (deferred ones after the
 * rest), in ONE shared vm context with a stand-in DOM, and fails on:
 *   - any script that throws while loading (a redeclaration SyntaxError included)
 *   - any function the page calls (inline scripts and on* attributes) that isn't defined afterwards
 *   - any FriChat.<name> used by any of the page's scripts that no script provides
 *   - any on* handler built in a script's HTML strings that calls an undefined function
 * Startup itself (DOMContentLoaded) isn't run: it needs the server.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { isWrappedModule } = require('./helpers/frontendScripts');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const PAGES = fs.readdirSync(FRONTEND).filter(file => file.endsWith('.html')).sort();

// The feature scripts that keep their names to themselves (window.FriChat for what's shared)
const FEATURE_MODULES = ['formatter', 'mentions', 'groups', 'security', 'search', 'media', 'composer',
    'polls', 'planner', 'profile', 'disappearing', 'voice', 'calls'].map(name => `js/${name}.js`);

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'async',
    'await', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'super', 'import', 'yield']);

/** <script> tags of a page in execution order: { src } or { code } (inline) */
function pageScripts(html) {
    const scripts = [];
    const deferred = [];
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const match of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        const attrs = match[1];
        const src = (attrs.match(/\ssrc="([^"]+)"/) || [])[1];
        if (src) (/\sdefer\b/.test(attrs) ? deferred : scripts).push({ src });
        else scripts.push({ code: match[2] });
    }
    return scripts.concat(deferred);
}

/** Text of every on*="..." attribute in some HTML (or in a script's HTML strings) */
function inlineHandlers(text) {
    return [...text.matchAll(/\son[a-z]+="([^"]*)"/g)].map(match => match[1]);
}

/** Names a piece of code calls as plain functions, minus what it binds itself */
function calledNames(code) {
    const local = new Set();
    for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
        if (match[1]) local.add(match[1]);
        match[2].split(',').forEach(param => local.add(param.trim().split(/[\s=]/)[0]));
    }
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(match[1]);
    for (const match of code.matchAll(/\(([\w$\s,]*)\)\s*=>/g)) match[1].split(',').forEach(param => local.add(param.trim()));
    for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) local.add(match[1]);

    const names = new Set();
    const stripped = withoutComments(code).replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
    for (const match of stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!KEYWORDS.has(match[1]) && !local.has(match[1])) names.add(match[1]);
    }
    return names;
}

/** Comments out (block comments, and line comments that start a line) */
function withoutComments(code) {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
}

/** FriChat.<name> uses, strings included (on* handlers built in HTML strings call them too) */
function namespaceNames(code) {
    return new Set([...withoutComments(code).matchAll(/\bFriChat\.([A-Za-z_$][\w$]*)/g)].map(match => match[1]));
}

/** Something that stands in for any DOM object: every property and call gives another one */
function stub() {
    const store = new Map();
    const target = function () {};
    return new Proxy(target, {
        get(_, prop) {
            if (prop === Symbol.toPrimitive) return () => '';
            if (prop === 'then') return undefined; // not a promise
            if (typeof prop === 'symbol') return undefined;
            if (!store.has(prop)) store.set(prop, stub());
            return store.get(prop);
        },
        set(_, prop, value) {
            store.set(prop, value);
            return true;
        },
        has: () => true,
        apply: () => stub(),
        construct: () => stub()
    });
}

function memoryStorage() {
    const data = new Map();
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
        clear: () => data.clear()
    };
}

/** A browser-like global scope; timers and network never fire, so only load-time code runs */
function browserContext() {
    const context = {
        console: { log() {}, info() {}, warn() {}, debug() {}, error: console.error },
        document: stub(),
        navigator: stub(),
        location: stub(),
        history: stub(),
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
        setTimeout: () => 0,
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        requestAnimationFrame: () => 0,
        cancelAnimationFrame() {},
        fetch: () => new Promise(() => {}),
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => stub(),
        getComputedStyle: () => stub(),
        alert() {},
        confirm: () => false,
        prompt: () => null,
        URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, FormData,
        atob, btoa, structuredClone, queueMicrotask,
        io: () => stub(), // socket.io from its CDN
        Notification: stub(),
        Audio: function () { return stub(); },
        Image: function () { return stub(); },
        MediaRecorder: stub(),
        XMLHttpRequest: function () { return stub(); }
    };
    context.window = context;
    context.self = context;
    vm.createContext(context);
    return context;
}

/** Run a page's scripts; returns what's needed for the checks */
function loadPage(page) {
    const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
    const context = browserContext();
    const loaded = [];
    const failures = [];
    for (const [index, script] of pageScripts(html).entries()) {
        if (script.src && /^https?:\/\//.test(script.src)) continue; // CDN (socket.io): stubbed above
        const name = script.src || `${page} inline script #${index + 1}`;
        const code = script.src ? fs.readFileSync(path.join(FRONTEND, script.src), 'utf8') : script.code;
        loaded.push({ name, code, inline: !script.src });
        try {
            vm.runInContext(code, context, { filename: name });
        } catch (error) {
            failures.push(`${name}: ${error.name}: ${error.message}`);
        }
    }
    const isFunction = (name) => vm.runInContext(`typeof ${name} === 'function'`, context);
    const hasExport = (name) => vm.runInContext(`typeof FriChat !== 'undefined' && FriChat[${JSON.stringify(name)}] !== undefined`, context);
    return { html, context, loaded, failures, isFunction, hasExport };
}

describe('page scripts load together in one global scope', () => {
    for (const page of PAGES) {
        describe(page, () => {
            const result = loadPage(page);

            test('every script loads (no redeclared names, nothing throws)', () => {
                assert.deepEqual(result.failures, []);
            });

            test('every function the page calls is defined', () => {
                const pageCode = result.loaded.filter(script => script.inline).map(script => script.code)
                    .concat(inlineHandlers(result.html));
                const missing = new Set();
                for (const code of pageCode) {
                    for (const name of calledNames(code)) if (!result.isFunction(name)) missing.add(name);
                    for (const name of namespaceNames(code)) if (!result.hasExport(name)) missing.add(`FriChat.${name}`);
                }
                assert.deepEqual([...missing], []);
            });

            test('every FriChat name and handler the scripts use exists', () => {
                const missing = new Set();
                for (const script of result.loaded) {
                    for (const name of namespaceNames(script.code)) {
                        if (!result.hasExport(name)) missing.add(`${script.name}: FriChat.${name}`);
                    }
                    for (const handler of inlineHandlers(script.code)) {
                        for (const name of calledNames(handler.replace(/\$\{[^}]*\}/g, '0'))) {
                            if (!result.isFunction(name)) missing.add(`${script.name}: ${name}() in an on* handler`);
                        }
                    }
                }
                assert.deepEqual([...missing], []);
            });
        });
    }
});

describe('feature scripts keep their names to themselves', () => {
    test('chat.html loads every feature script, each wrapped in its own scope', () => {
        const scripts = pageScripts(fs.readFileSync(path.join(FRONTEND, 'chat.html'), 'utf8')).map(script => script.src);
        for (const file of FEATURE_MODULES) {
            assert.ok(scripts.includes(file), `${file} is on chat.html`);
            assert.ok(isWrappedModule(fs.readFileSync(path.join(FRONTEND, file), 'utf8')), `${file} is wrapped`);
        }
    });

    test('their private names (like PLAY_ICON_SVG) stay off the global scope', () => {
        const { isFunction, context } = loadPage('chat.html');
        assert.equal(vm.runInContext('typeof PLAY_ICON_SVG', context), 'undefined');
        assert.equal(isFunction('renderVoiceNoteHtml'), false);
        assert.equal(isFunction('FriChat.renderVoiceNoteHtml'), true);
        assert.equal(isFunction('FriChat.initializeVoiceNotes'), true);
        assert.equal(context.window.FriChat, vm.runInContext('FriChat', context));
    });

    test('the check catches a redeclared top-level name across two files', () => {
        const context = browserContext();
        vm.runInContext("const PLAY_ICON_SVG = '<svg></svg>';", context);
        assert.throws(() => vm.runInContext("const PLAY_ICON_SVG = '<svg></svg>';", context),
            error => error.name === 'SyntaxError' && /already been declared/.test(error.message));
    });

    test('a missing feature module leaves chat.html startup and the chat list working', () => {
        // Load chat.html's scripts without voice.js: everything else must still load
        const html = fs.readFileSync(path.join(FRONTEND, 'chat.html'), 'utf8');
        const context = browserContext();
        for (const script of pageScripts(html)) {
            if (script.src === 'js/voice.js' || (script.src && /^https?:/.test(script.src))) continue;
            vm.runInContext(script.src ? fs.readFileSync(path.join(FRONTEND, script.src), 'utf8') : script.code, context);
        }
        // startFeature logs and carries on instead of throwing
        const errors = [];
        context.console.error = (...args) => errors.push(args.join(' '));
        vm.runInContext("startFeature('Voice notes', () => FriChat.initializeVoiceNotes());", context);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Voice notes failed to start/);

        // A feature that throws while rendering the chat list gives its fallback, not an empty sidebar
        vm.runInContext("FriChat.renderChatListDisappearingIcon = () => { throw new Error('broken'); };", context);
        assert.equal(vm.runInContext("chatListFeature('renderChatListDisappearingIcon', 'fallback', {})", context), 'fallback');
        assert.equal(vm.runInContext("chatListFeature('notThere', 'fallback')", context), 'fallback');
    });
});
