/**
 * Link previews: the server fetches a URL from a message, reads its Open Graph tags and stores
 * a preview with the message.
 *
 * SSRF protection (the server makes requests to user-supplied URLs):
 * - only http/https, no user:password@, no localhost names
 * - every address a hostname resolves to must be public unicast (no private, loopback,
 *   link-local, CGNAT, multicast, reserved, documentation/benchmark or IPv4-mapped/6to4/NAT64
 *   ranges). The check runs inside the socket's DNS lookup, so the connection goes to exactly
 *   the address that was checked (no DNS rebinding between check and connect). IP literals skip
 *   DNS and are checked before connecting.
 * - redirects are followed by hand (at most MAX_REDIRECTS) and every hop is checked again
 * - one deadline for the whole chain (TIMEOUT_MS), and at most MAX_BYTES of body are read
 *   (after decompression)
 * - results, including failures, are cached in link_previews
 */

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const ipaddr = require('ipaddr.js');
const { executeQuery, queryOne, dbType } = require('../config/database');
const { stripControlChars } = require('./messageText');

const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2048;
const USER_AGENT = 'FriChatLinkPreview/1.0 (+https://github.com/frichat)';

// Cache lifetimes (hours): good previews for a day, URLs that gave nothing for an hour
const CACHE_HOURS_OK = 24;
const CACHE_HOURS_FAILED = 1;

// Preview fetches per sender per minute; more than that and the message just has no preview
const FETCHES_PER_MINUTE = 20;

const LIMITS = { title: 300, description: 500, siteName: 200 };

// Ranges ipaddr.js 1.9 still calls 'unicast' but that are not public Internet hosts
const EXTRA_BLOCKED_RANGES = [
    '192.0.0.0/24',     // IETF protocol assignments
    '192.0.2.0/24',     // TEST-NET-1
    '198.18.0.0/15',    // benchmarking
    '198.51.100.0/24',  // TEST-NET-2
    '203.0.113.0/24',   // TEST-NET-3
    '240.0.0.0/4',      // reserved
    '100::/64',         // discard
    '2001::/23',        // IETF protocol assignments (Teredo, ORCHID, benchmarking, ...)
    '2001:db8::/32',    // documentation
    'fec0::/10'         // deprecated site-local
].map(cidr => ipaddr.parseCIDR(cidr));

function isEnabled() {
    return String(process.env.LINK_PREVIEWS_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * True only for public unicast addresses
 */
function isPublicAddress(address) {
    let ip;
    try {
        ip = ipaddr.parse(String(address).replace(/^\[|\]$/g, ''));
    } catch (e) {
        return false;
    }
    if (ip.range() !== 'unicast') return false;
    return !EXTRA_BLOCKED_RANGES.some(([range, bits]) => ip.kind() === range.kind() && ip.match(range, bits));
}

/**
 * A URL the server may request: http(s), no credentials, not a localhost name, sane length.
 * Returns the normalized href (fragment dropped) or null.
 */
function normalizeUrl(value, base) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
    let url;
    try {
        url = base ? new URL(value, base) : new URL(value);
    } catch (e) {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return null;
    url.hash = '';
    return url.href.length <= MAX_URL_LENGTH ? url.href : null;
}

/**
 * Hostname without IPv6 brackets, and whether it is an IP literal
 */
function hostOf(url) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return { host, isIp: ipaddr.isValid(host) };
}

/**
 * First http(s) URL in message text, ignoring `code` and ``` blocks (same rule as the frontend formatter)
 */
function extractFirstUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const source = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
    const pattern = /(^|[^A-Za-z0-9_])(https?:\/\/[^\s<>"'`]+)/gi;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const url = normalizeUrl(trimUrlPunctuation(match[2]));
        if (url) return url;
    }
    return null;
}

/**
 * Drop sentence punctuation stuck to the end of a URL ("see https://x.com/a." or "(https://x.com)")
 */
function trimUrlPunctuation(url) {
    let result = url;
    for (;;) {
        const last = result.slice(-1);
        if (/[.,;:!?'"*_~]/.test(last)) {
            result = result.slice(0, -1);
        } else if (last === ')' && (result.match(/\(/g) || []).length < (result.match(/\)/g) || []).length) {
            result = result.slice(0, -1);
        } else {
            return result;
        }
    }
}

/**
 * dns.lookup replacement handed to http(s).request: resolves, refuses the whole host if any
 * address isn't allowed, and gives the socket only checked addresses
 */
function guardedLookup(isAddressAllowed) {
    return (hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (error) return callback(error);
            if (!addresses.length || addresses.some(a => !isAddressAllowed(a.address))) {
                const blocked = new Error(`Refusing to connect to ${hostname}: not a public address`);
                blocked.code = 'EBLOCKED';
                return callback(blocked);
            }
            if (options && options.all) return callback(null, addresses);
            callback(null, addresses[0].address, addresses[0].family);
        });
    };
}

class PreviewError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

/**
 * One GET. Resolves { status, headers, location } for redirects/errors or { status, headers, body }
 * for a 200 HTML page (body capped at maxBytes).
 */
function requestOnce(href, { isAddressAllowed, signal, maxBytes }) {
    return new Promise((resolve, reject) => {
        const url = new URL(href);
        const { host, isIp } = hostOf(url);
        if (isIp && !isAddressAllowed(host)) {
            return reject(new PreviewError(`Refusing to connect to ${host}: not a public address`, 'EBLOCKED'));
        }

        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: url.protocol,
            hostname: host,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            agent: false, // fresh connection every time; nothing is reused across hosts
            lookup: guardedLookup(isAddressAllowed),
            signal,
            servername: isIp ? undefined : host,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept-Language': 'en'
            }
        }, (response) => {
            const status = response.statusCode;
            const headers = response.headers;

            if (status >= 300 && status < 400) {
                response.destroy();
                return resolve({ status, headers, location: headers.location || null });
            }

            const type = String(headers['content-type'] || '').toLowerCase();
            if (status !== 200 || !/text\/html|application\/xhtml\+xml/.test(type)) {
                response.destroy();
                return resolve({ status, headers, body: null });
            }

            // Decompress ourselves so the cap applies to what we actually parse (no zip bombs)
            let stream = response;
            const encoding = String(headers['content-encoding'] || '').toLowerCase().trim();
            if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip());
            else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate());
            else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress());
            else if (encoding && encoding !== 'identity') {
                response.destroy();
                return resolve({ status, headers, body: null });
            }

            const chunks = [];
            let size = 0;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                response.destroy();
                resolve({ status, headers, body: Buffer.concat(chunks, Math.min(size, maxBytes)) });
            };

            stream.on('data', (chunk) => {
                if (done) return;
                chunks.push(chunk);
                size += chunk.length;
                if (size >= maxBytes) finish(); // enough for <head>; stop reading
            });
            stream.on('end', finish);
            stream.on('error', (error) => {
                if (done) return;
                if (size > 0) return finish(); // keep what decoded fine
                done = true;
                reject(error);
            });
        });

        request.on('error', reject);
        request.end();
    });
}

/**
 * Fetch a page, following up to MAX_REDIRECTS checked redirects, within TIMEOUT_MS overall.
 * Returns { finalUrl, body, contentType } or throws (PreviewError code EBLOCKED for refused targets).
 */
async function fetchPage(startUrl, options = {}) {
    const isAddressAllowed = options.isAddressAllowed || isPublicAddress;
    const timeoutMs = options.timeoutMs || TIMEOUT_MS;
    const maxBytes = options.maxBytes || MAX_BYTES;

    let href = normalizeUrl(startUrl);
    if (!href) throw new PreviewError('Only public http(s) URLs can be previewed', 'EBLOCKED');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const result = await requestOnce(href, { isAddressAllowed, signal: controller.signal, maxBytes });
            if (result.location !== undefined) {
                if (!result.location) throw new PreviewError('Redirect without a location', 'EFETCH');
                const next = normalizeUrl(result.location, href);
                if (!next) throw new PreviewError('Redirect to a URL that cannot be previewed', 'EBLOCKED');
                href = next;
                continue;
            }
            if (!result.body) throw new PreviewError(`No HTML page (status ${result.status})`, 'EFETCH');
            return { finalUrl: href, body: result.body, contentType: String(result.headers['content-type'] || '') };
        }
        throw new PreviewError('Too many redirects', 'EFETCH');
    } catch (error) {
        if (controller.signal.aborted) throw new PreviewError('Timed out', 'ETIMEOUT');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name) => {
        const lower = name.toLowerCase();
        if (lower[0] === '#') {
            const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        return NAMED_ENTITIES[lower] !== undefined ? NAMED_ENTITIES[lower] : whole;
    });
}

/**
 * Plain text for storage: entities decoded, controls stripped, whitespace collapsed, length capped.
 * Stored raw like message text; the frontend escapes it when rendering.
 */
function cleanText(value, max) {
    if (!value) return null;
    const text = stripControlChars(decodeEntities(String(value))).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function decodeBody(body, contentType) {
    const head = body.subarray(0, 4096).toString('latin1');
    const charset = (/charset=["']?([\w-]+)/i.exec(contentType) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8';
    try {
        return new TextDecoder(charset.toLowerCase()).decode(body);
    } catch (e) {
        return new TextDecoder('utf-8').decode(body);
    }
}

/**
 * Open Graph (then Twitter card, then <title>/description) from an HTML page.
 * Returns { title, description, imageUrl, siteName } or null when there's nothing to show.
 */
function parseOpenGraph(html, pageUrl) {
    const headEnd = html.search(/<\/head\s*>/i);
    const head = headEnd > 0 ? html.slice(0, headEnd) : html;

    const meta = {};
    const tagPattern = /<meta\b[^>]*>/gi;
    const attrPattern = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let tag;
    while ((tag = tagPattern.exec(head)) !== null) {
        const attrs = {};
        let attr;
        attrPattern.lastIndex = 0;
        while ((attr = attrPattern.exec(tag[0])) !== null) {
            attrs[attr[1].toLowerCase()] = attr[2] !== undefined ? attr[2] : (attr[3] !== undefined ? attr[3] : attr[4]);
        }
        const key = (attrs.property || attrs.name || '').toLowerCase();
        if (key && attrs.content !== undefined && meta[key] === undefined) meta[key] = attrs.content;
    }

    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    const title = cleanText(meta['og:title'] || meta['twitter:title'] || (titleTag && titleTag[1]), LIMITS.title);
    const description = cleanText(meta['og:description'] || meta['twitter:description'] || meta.description, LIMITS.description);
    if (!title && !description) return null;

    // The viewer's browser loads the image, not the server: still refuse localhost names and private IP literals
    let imageUrl = null;
    const rawImage = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'];
    if (rawImage) {
        const candidate = normalizeUrl(decodeEntities(rawImage.trim()), pageUrl);
        if (candidate) {
            const { host, isIp } = hostOf(new URL(candidate));
            if (!isIp || isPublicAddress(host)) imageUrl = candidate;
        }
    }

    let siteName = cleanText(meta['og:site_name'], LIMITS.siteName);
    if (!siteName) {
        try {
            siteName = new URL(pageUrl).hostname.replace(/^www\./, '');
        } catch (e) {
            siteName = null;
        }
    }

    return { title, description, imageUrl, siteName };
}

/**
 * Fetch and parse; null when the page has no usable preview. Throws on refused/failed fetches.
 */
async function fetchPreviewData(url, options = {}) {
    const page = await fetchPage(url, options);
    return parseOpenGraph(decodeBody(page.body, page.contentType), page.finalUrl);
}

// Tests replace the network fetch; production always uses fetchPreviewData
let previewFetcher = fetchPreviewData;
function setPreviewFetcher(fn) {
    previewFetcher = fn || fetchPreviewData;
}

function hashUrl(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

function hoursAgoCondition(hours) {
    const h = parseInt(hours);
    return dbType === 'postgresql'
        ? `fetched_at > CURRENT_TIMESTAMP - INTERVAL '${h} hours'`
        : `fetched_at > CURRENT_TIMESTAMP - INTERVAL ${h} HOUR`;
}

async function readCache(urlHash) {
    return queryOne(`
        SELECT id, status, url, title, description, image_url, site_name,
            CASE WHEN status = 'ok' AND ${hoursAgoCondition(CACHE_HOURS_OK)} THEN 1
                 WHEN status <> 'ok' AND ${hoursAgoCondition(CACHE_HOURS_FAILED)} THEN 1
                 ELSE 0 END AS is_fresh
        FROM link_previews WHERE url_hash = ?
    `, [urlHash]);
}

async function writeCache(urlHash, url, data) {
    const params = [
        urlHash, url, data ? 'ok' : 'failed',
        data ? data.title : null, data ? data.description : null,
        data ? data.imageUrl : null, data ? data.siteName : null
    ];
    if (dbType === 'postgresql') {
        await executeQuery(`
            INSERT INTO link_previews (url_hash, url, status, title, description, image_url, site_name, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (url_hash) DO UPDATE SET
                status = EXCLUDED.status, title = EXCLUDED.title, description = EXCLUDED.description,
                image_url = EXCLUDED.image_url, site_name = EXCLUDED.site_name, fetched_at = CURRENT_TIMESTAMP
        `, params);
    } else {
        await executeQuery(`
            INSERT INTO link_previews (url_hash, url, status, title, description, image_url, site_name, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE
                status = VALUES(status), title = VALUES(title), description = VALUES(description),
                image_url = VALUES(image_url), site_name = VALUES(site_name), fetched_at = CURRENT_TIMESTAMP
        `, params);
    }
    return readCache(urlHash);
}

// Concurrent sends of the same URL share one fetch
const inFlight = new Map();

/**
 * Cached preview row for a URL ({ id, status: 'ok', ... }) or null when it has none
 */
async function getPreview(url) {
    const urlHash = hashUrl(url);
    const cached = await readCache(urlHash);
    if (cached && parseInt(cached.is_fresh)) {
        return cached.status === 'ok' ? cached : null;
    }

    if (!inFlight.has(urlHash)) {
        inFlight.set(urlHash, (async () => {
            let data = null;
            try {
                data = await previewFetcher(url);
            } catch (error) {
                // Refused targets are cached too, so a repeated localhost link doesn't retry every time
                console.warn(`Link preview skipped for ${url}: ${error.code || ''} ${error.message}`);
            }
            return writeCache(urlHash, url, data);
        })().finally(() => inFlight.delete(urlHash)));
    }

    const row = await inFlight.get(urlHash);
    return row && row.status === 'ok' ? row : null;
}

const senderBudget = new Map(); // userId -> { count, resetAt }
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of senderBudget) if (entry.resetAt <= now) senderBudget.delete(key);
}, 60 * 1000).unref();

function takeFetchBudget(userId) {
    const now = Date.now();
    let entry = senderBudget.get(userId);
    if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + 60 * 1000 };
        senderBudget.set(userId, entry);
    }
    entry.count++;
    return entry.count <= FETCHES_PER_MINUTE;
}

/**
 * Client shape of a preview row (null when there's none)
 */
function toClientPreview(row) {
    if (!row) return null;
    return {
        url: row.url,
        title: row.title || null,
        description: row.description || null,
        image_url: row.image_url || null,
        site_name: row.site_name || null
    };
}

/**
 * Find the message's first URL, get its preview and store it with the message, then tell the chat
 * (message_link_preview). Runs after the message was broadcast and never throws: a preview problem
 * must not fail or delay a send. hadPreview: the message showed a preview before (edits), so it is
 * cleared when the new text has none.
 */
async function attachLinkPreview(io, message, { hadPreview = false } = {}) {
    try {
        if (!message || !isEnabled() || message.message_type !== 'text') return null;

        const emit = (preview) => {
            if (io) io.to(`chat_${message.chat_id}`).emit('message_link_preview', { messageId: message.id, chatId: message.chat_id, preview });
        };
        const clear = async () => {
            if (!hadPreview) return null;
            await executeQuery('UPDATE messages SET link_preview_id = NULL WHERE id = ?', [message.id]);
            emit(null);
            return null;
        };

        const url = extractFirstUrl(message.content);
        if (!url) return clear();
        if (!takeFetchBudget(message.sender_id)) return clear();

        const row = await getPreview(url);
        if (!row) return clear();

        // Never re-attach to a message whose sender dismissed its preview, or that was deleted meanwhile
        await executeQuery(`
            UPDATE messages SET link_preview_id = ?
            WHERE id = ? AND link_preview_dismissed = FALSE
            AND (deleted_for_everyone IS NULL OR deleted_for_everyone = FALSE)
        `, [row.id, message.id]);
        const stored = await queryOne('SELECT link_preview_id FROM messages WHERE id = ?', [message.id]);
        if (!stored || Number(stored.link_preview_id) !== Number(row.id)) return null;

        const preview = toClientPreview(row);
        emit(preview);
        return preview;
    } catch (error) {
        console.error('Link preview error:', error);
        return null;
    }
}

module.exports = {
    TIMEOUT_MS,
    MAX_BYTES,
    MAX_REDIRECTS,
    isPublicAddress,
    normalizeUrl,
    extractFirstUrl,
    fetchPage,
    fetchPreviewData,
    parseOpenGraph,
    setPreviewFetcher,
    getPreview,
    toClientPreview,
    attachLinkPreview
};
