/**
 * Loads backend modules against a fake mysql2 / pg driver so the real
 * config/database.js, controllers and server.js run without a database.
 *
 * handler(sql, params) returns what the database would: an array of rows for
 * SELECT / RETURNING, or (MySQL only) an { insertId } header for a plain INSERT.
 */

const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const NODE_MODULES = path.join(BACKEND_DIR, 'node_modules');

function stubModule(request, exports) {
    const resolved = require.resolve(request, { paths: [BACKEND_DIR] });
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Drop cached app modules (not dependencies) so each test gets a fresh copy bound to its fake driver
function clearAppModules() {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(BACKEND_DIR) && !key.startsWith(NODE_MODULES) && !key.includes(`${path.sep}test${path.sep}`)) {
            delete require.cache[key];
        }
    }
}

function setupFakeDb(dbType, handler) {
    const calls = [];
    const record = (sql, params) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: normalized, params });
        return handler(normalized, params || []);
    };

    process.env.DB_TYPE = dbType;
    // Push stays off unless a test sets keys (dotenv never overrides a key that already exists)
    process.env.VAPID_PUBLIC_KEY = '';
    process.env.VAPID_PRIVATE_KEY = '';
    clearAppModules();

    stubModule('mysql2/promise', {
        createPool: () => ({
            async execute(sql, params) {
                if (/\bRETURNING\b/i.test(sql)) {
                    // What MySQL 8 does with a RETURNING clause
                    throw new Error('ER_PARSE_ERROR: You have an error in your SQL syntax near RETURNING');
                }
                return [record(sql, params)];
            },
            async getConnection() {
                return { release() {} };
            }
        })
    });

    stubModule('pg', {
        Pool: class {
            async query(sql, params) {
                if (/\?/.test(sql)) throw new Error('placeholders were not converted');
                const rows = record(sql, params);
                if (!Array.isArray(rows)) throw new Error(`pg handler must return rows for: ${sql}`);
                return { rows };
            }
            async connect() {
                return { release() {} };
            }
        }
    });

    return {
        calls,
        load: (relativePath) => require(path.join(BACKEND_DIR, relativePath))
    };
}

/**
 * Minimal Express res double
 */
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

/**
 * Socket.IO server double that records every emit by room
 */
function fakeIo() {
    const emitted = [];
    return {
        emitted,
        to(room) {
            return { emit: (event, data) => emitted.push({ room, event, data }) };
        }
    };
}

module.exports = { setupFakeDb, fakeRes, fakeIo, stubModule };
