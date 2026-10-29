/**
 * Message search and shared-media helpers: turning the user's search text into safe terms,
 * the engine-specific full-text condition (MySQL FULLTEXT / PostgreSQL tsvector), the filters,
 * and the highlighted snippet sent with each result.
 */

const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 50;
const SNIPPET_LENGTH = 160;
const SNIPPET_LEAD = 50;
const MAX_LINKS_PER_MESSAGE = 5;
const MAX_URL_LENGTH = 2048;

// innodb_ft_min_token_size defaults to 3; shorter words never reach the FULLTEXT index
const MYSQL_MIN_TOKEN_LENGTH = 3;

// InnoDB's default stopword list: these are not in the index either, so they go through LIKE
const MYSQL_STOPWORDS = new Set([
    'a', 'about', 'an', 'are', 'as', 'at', 'be', 'by', 'com', 'de', 'en', 'for', 'from', 'how',
    'i', 'in', 'is', 'it', 'la', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what',
    'when', 'where', 'who', 'will', 'with', 'und', 'www'
]);

// "Has" filters; the SQL is constant text (never user input) and must not contain '?'
const HAS_LINK_SQL = `(m.message_type = 'text' AND (m.link_preview_id IS NOT NULL
    OR LOWER(m.content) LIKE '%http://%' OR LOWER(m.content) LIKE '%https://%'))`;

const HAS_FILTERS = {
    image: `m.message_type = 'image'`,
    video: `m.message_type = 'video'`,
    file: `m.message_type = 'file'`,
    link: HAS_LINK_SQL
};

// Shared media panel tabs
const MEDIA_TABS = {
    media: `m.message_type IN ('image', 'video') AND f.id IS NOT NULL`,
    files: `m.message_type = 'file' AND f.id IS NOT NULL`,
    links: HAS_LINK_SQL
};

/**
 * Words to search for: letters and digits only (so nothing the user types can act as
 * FULLTEXT or tsquery syntax), lower-cased, unique, at most MAX_TERMS.
 */
function parseSearchTerms(text) {
    if (typeof text !== 'string') return [];
    const words = text.slice(0, MAX_QUERY_LENGTH).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const terms = [];
    for (const word of words) {
        const term = word.slice(0, MAX_TERM_LENGTH);
        if (!terms.includes(term)) terms.push(term);
        if (terms.length >= MAX_TERMS) break;
    }
    return terms;
}

/**
 * LIKE pattern for a term (terms have no wildcards, but escape them anyway)
 */
function likePattern(term) {
    return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Every term must match, as a word prefix ("deplo" finds "deployment").
 * Returns { sql, params } to AND into a WHERE clause, or null when there are no terms.
 */
function buildTextCondition(terms, dbType) {
    if (!terms || terms.length === 0) return null;

    if (dbType === 'postgresql') {
        return {
            sql: `m.search_vector @@ to_tsquery('simple', ?)`,
            params: [terms.map(term => `${term}:*`).join(' & ')]
        };
    }

    const indexed = terms.filter(term => term.length >= MYSQL_MIN_TOKEN_LENGTH && !MYSQL_STOPWORDS.has(term));
    const unindexed = terms.filter(term => !indexed.includes(term));
    const parts = [];
    const params = [];

    if (indexed.length > 0) {
        parts.push('MATCH(m.content) AGAINST (? IN BOOLEAN MODE)');
        params.push(indexed.map(term => `+${term}*`).join(' '));
    }
    for (const term of unindexed) {
        parts.push('LOWER(m.content) LIKE ?');
        params.push(likePattern(term));
    }

    return { sql: parts.join(' AND '), params };
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A short piece of the message around the first match, plus where the matches are in it.
 * highlights are [start, end) character offsets into text; the client wraps them in <mark>
 * using text nodes, so nothing here is ever treated as HTML.
 */
function buildSnippet(content, terms) {
    if (typeof content !== 'string' || content.length === 0) return null;

    const text = content.replace(/\s+/g, ' ').trim();
    if (!terms || terms.length === 0) {
        return {
            text: text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH - 1)}…` : text,
            highlights: []
        };
    }

    // Longest first so "deploy" wins over "de" at the same spot
    const alternatives = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    let pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})`, 'giu');
    if (!pattern.test(text)) {
        // Matched by LIKE inside a word (short terms on MySQL)
        pattern = new RegExp(`(?:${alternatives})`, 'giu');
    }
    pattern.lastIndex = 0;

    const matches = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        matches.push([match.index, match.index + match[0].length]);
        if (match[0].length === 0) pattern.lastIndex++;
    }

    let start = 0;
    if (matches.length > 0 && matches[0][0] > SNIPPET_LEAD) {
        start = matches[0][0] - SNIPPET_LEAD;
        // Start on a word if one begins shortly after the cut
        const space = text.indexOf(' ', start);
        if (space !== -1 && space < matches[0][0] && space - start < 15) start = space + 1;
    }
    const end = Math.min(text.length, start + SNIPPET_LENGTH);

    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    const highlights = matches
        .filter(([s, e]) => s >= start && e <= end)
        .map(([s, e]) => [s - start + prefix.length, e - start + prefix.length]);

    return { text: prefix + text.slice(start, end) + suffix, highlights };
}

/**
 * The URL if it parses as http(s), else null
 */
function httpUrl(value) {
    if (!value || value.length > MAX_URL_LENGTH) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (e) {
        return null;
    }
}

/**
 * http(s) links in a text message, outside `code` (for the Links tab)
 */
function extractUrls(text) {
    if (!text || typeof text !== 'string') return [];
    const source = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
    const pattern = /(^|[^A-Za-z0-9_])(https?:\/\/[^\s<>"'`]+)/gi;
    const urls = [];
    let match;
    while ((match = pattern.exec(source)) !== null && urls.length < MAX_LINKS_PER_MESSAGE) {
        const url = httpUrl(match[2].replace(/[.,;:!?'"*_~)\]]+$/, ''));
        if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
}

/**
 * Name shown for a result's chat (group name, or the other person in a direct chat)
 */
function chatDisplayName(row) {
    return row.chat_type === 'group'
        ? (row.chat_name || 'Group')
        : (row.direct_partner_name || row.chat_name || 'Chat');
}

module.exports = {
    MAX_QUERY_LENGTH,
    MAX_TERMS,
    HAS_FILTERS,
    MEDIA_TABS,
    parseSearchTerms,
    buildTextCondition,
    buildSnippet,
    extractUrls,
    chatDisplayName
};
