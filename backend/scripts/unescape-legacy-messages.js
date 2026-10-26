/**
 * ONE-OFF: un-escape message text (and optionally group chat names) that the old REST path
 * stored HTML-escaped with sanitizeHtml(). Since the "one text rule" change, all text is stored
 * raw and escaped only when the frontend renders it, so those old rows now show "&amp;" etc.
 *
 * Usage (from backend/, uses the DB settings in .env, works on MySQL and PostgreSQL):
 *   node scripts/unescape-legacy-messages.js --before "2026-10-26T12:00:00Z"            (dry run)
 *   node scripts/unescape-legacy-messages.js --before "2026-10-26T12:00:00Z" --apply    (write)
 *   add --chat-names to also fix chats.chat_name
 *
 * --before is required: the moment the raw-storage version went live. Rows created after it are
 * never touched, so text people type from then on (even a literal "&lt;") is safe.
 *
 * Which rows: not edited (edits were always stored raw), created before --before, and text that
 * looks exactly like sanitizeHtml output: at least one of &amp; &lt; &gt; &quot; &#x27; &#x2F;,
 * no raw < > " ' / characters, and no "&" that doesn't start one of those entities.
 * Socket-sent messages were always raw, so most of them fail that test and are left alone.
 *
 * RISK OF RUNNING IT TWICE: un-escaping is not idempotent. A message someone originally typed as
 * "&lt;b&gt;" was stored as "&amp;lt;b&amp;gt;"; the first run correctly restores "&lt;b&gt;",
 * but that result still looks escaped, so a second run would turn it into "<b>". Run it once,
 * with --apply, and keep the printed log. Always do a dry run and take a backup first.
 * (A raw socket message from before the cutoff that consists only of entity text, e.g. someone
 * typing "&amp;" literally, would be wrongly un-escaped too; that case is rare.)
 */

const ENTITY_MAP = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#x27;': "'",
    '&#x2F;': '/'
};
const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#x27|#x2F);/g;
const HAS_ENTITY = /&(?:amp|lt|gt|quot|#x27|#x2F);/;

/**
 * Could this text be sanitizeHtml() output?
 */
function looksLegacyEscaped(text) {
    if (typeof text !== 'string' || !HAS_ENTITY.test(text)) return false;

    // sanitizeHtml never leaves these raw
    if (/[<>"'/]/.test(text)) return false;

    // Every & must begin one of the entities it produced
    return !/&/.test(text.replace(ENTITY_PATTERN, ''));
}

/**
 * Exact inverse of sanitizeHtml (single pass, so "&amp;lt;" becomes "&lt;", not "<")
 */
function unescapeLegacyHtml(text) {
    return text.replace(ENTITY_PATTERN, entity => ENTITY_MAP[entity]);
}

function parseArgs(argv) {
    const args = { apply: false, chatNames: false, before: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--chat-names') args.chatNames = true;
        else if (arg === '--before') args.before = argv[++i];
        else if (arg.startsWith('--before=')) args.before = arg.slice('--before='.length);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

/**
 * Walk one table in id order and fix matching rows
 */
async function fixColumn(db, { table, column, extraWhere, before, apply }) {
    const BATCH = 500;
    let lastId = 0;
    let scanned = 0;
    let changed = 0;

    for (;;) {
        // BATCH is a constant, inlined like the other LIMITs in this codebase
        const rows = await db.executeQuery(
            `SELECT id, ${column} AS text FROM ${table}
             WHERE id > ? AND created_at < ? ${extraWhere} AND ${column} LIKE ?
             ORDER BY id LIMIT ${BATCH}`,
            [lastId, before, '%&%;%']
        );
        if (rows.length === 0) break;

        for (const row of rows) {
            scanned++;
            lastId = row.id;
            if (!looksLegacyEscaped(row.text)) continue;

            const fixed = unescapeLegacyHtml(row.text);
            changed++;
            console.log(`${apply ? 'FIX ' : 'WOULD FIX '} ${table}#${row.id}: ${JSON.stringify(row.text.slice(0, 80))} -> ${JSON.stringify(fixed.slice(0, 80))}`);

            if (apply) {
                // Only if nobody changed the row since it was read
                await db.executeQuery(
                    `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`,
                    [fixed, row.id, row.text]
                );
            }
        }
    }

    return { scanned, changed };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const before = args.before ? new Date(args.before) : null;
    if (!before || isNaN(before.getTime())) {
        console.error('Pass --before "<ISO date/time>": when the raw-storage version was deployed.');
        process.exit(1);
    }

    const db = require('../config/database');
    console.log(`${args.apply ? 'APPLYING' : 'DRY RUN (add --apply to write)'} on ${db.dbType}, rows created before ${before.toISOString()}`);

    try {
        const messages = await fixColumn(db, {
            table: 'messages',
            column: 'content',
            extraWhere: "AND message_type = 'text' AND edited_at IS NULL",
            before,
            apply: args.apply
        });
        console.log(`messages: ${messages.changed} of ${messages.scanned} candidates ${args.apply ? 'fixed' : 'would be fixed'}`);

        if (args.chatNames) {
            const chats = await fixColumn(db, {
                table: 'chats',
                column: 'chat_name',
                extraWhere: "AND chat_type = 'group'",
                before,
                apply: args.apply
            });
            console.log(`chat names: ${chats.changed} of ${chats.scanned} candidates ${args.apply ? 'fixed' : 'would be fixed'}`);
        }
    } finally {
        await db.db.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Failed:', error.message);
        process.exit(1);
    });
}

module.exports = { looksLegacyEscaped, unescapeLegacyHtml, parseArgs };
