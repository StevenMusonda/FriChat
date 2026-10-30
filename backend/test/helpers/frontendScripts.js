/**
 * Loading frontend scripts into a vm sandbox.
 *
 * The feature scripts (formatter.js ... voice.js) each run inside
 *   (function (FriChat) { ... })(globalThis.FriChat = globalThis.FriChat || {});
 * and share only a few names on window.FriChat. Unit tests also call their private helpers, so
 * runFrontendScript runs such a file with the wrapper taken off: its top-level names land on the
 * sandbox as before, and its FriChat exports are still set. Other scripts run as they are.
 */

const vm = require('vm');

const MODULE_START = '(function (FriChat) {';
const MODULE_END = '})(globalThis.FriChat = globalThis.FriChat || {});';

function isWrappedModule(source) {
    return source.includes(`\n${MODULE_START}\n`) && source.trimEnd().endsWith(MODULE_END);
}

function unwrapModule(source) {
    if (!isWrappedModule(source)) return source;
    const start = source.indexOf(`\n${MODULE_START}\n`);
    const end = source.lastIndexOf(MODULE_END);
    return source.slice(0, start)
        + '\nvar FriChat = globalThis.FriChat = globalThis.FriChat || {};\n'
        + source.slice(start + MODULE_START.length + 2, end);
}

function runFrontendScript(source, context, options) {
    return vm.runInContext(unwrapModule(source), context, options);
}

module.exports = { MODULE_START, MODULE_END, isWrappedModule, unwrapModule, runFrontendScript };
