/**
 * Message formatting: a small whitelist formatter. User text is never inserted as HTML.
 * Every character of the text is escaped, and the only markup ever produced is this fixed set
 * (no attributes taken from the text except a checked http(s) link target):
 *
 *   **bold**      -> <strong>
 *   _italic_      -> <em>
 *   ~strike~      -> <del>
 *   `code`        -> <code class="inline-code">
 *   ```block```   -> <div class="code-block"> with a Copy button (optional language on the first line)
 *   http(s)://... -> <a href target="_blank" rel="noopener noreferrer nofollow ugc">
 *   @username     -> <span class="mention"> (only for mentions the server stored for the message)
 *
 * Emphasis is matched with a delimiter stack, so tags are always balanced and properly nested;
 * anything unmatched stays literal text. Emphasis doesn't cross lines. `_` and `~` must sit at a
 * word boundary, so snake_case_names stay as they are.
 * Keep the URL rule in step with extractFirstUrl() in backend/utils/linkPreview.js.
 */

(function (FriChat) {

const FORMAT_URL_PATTERN = /^https?:\/\/[^\s<>"'`]+/i;
const FORMAT_MENTION_PATTERN = /^@([A-Za-z0-9_]{3,50})(?![A-Za-z0-9_])/;
const FORMAT_FENCE_PATTERN = /```(?:([A-Za-z0-9_+.#-]{1,20})\n)?([\s\S]*?)```/g;

const FORMAT_TAGS = {
    '**': ['<strong>', '</strong>'],
    '_': ['<em>', '</em>'],
    '~': ['<del>', '</del>']
};

function escapeFormatHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isFormatWordChar(ch) {
    return !!ch && /[A-Za-z0-9_]/.test(ch);
}

/**
 * The URL itself if it is http(s), else null (used for links, preview cards and preview images)
 */
function safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (e) {
        return null;
    }
}

/**
 * Drop sentence punctuation stuck to the end of a URL (same rule as the server)
 */
function trimFormatUrl(url) {
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
 * One line of inline formatting -> HTML
 */
function formatLine(line, ctx) {
    const parts = [];
    const stack = []; // open emphasis: { marker, index } (index of its literal in parts)
    let text = '';
    const flush = () => {
        if (text) {
            parts.push(escapeFormatHtml(text));
            text = '';
        }
    };

    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        const prev = i > 0 ? line[i - 1] : '';

        // `inline code`: nothing inside is formatted
        if (ch === '`') {
            const end = line.indexOf('`', i + 1);
            if (end > i + 1) {
                flush();
                parts.push(`<code class="inline-code">${escapeFormatHtml(line.slice(i + 1, end))}</code>`);
                i = end + 1;
                continue;
            }
        }

        // Links
        if ((ch === 'h' || ch === 'H') && !isFormatWordChar(prev)) {
            const match = FORMAT_URL_PATTERN.exec(line.slice(i));
            if (match) {
                const raw = trimFormatUrl(match[0]);
                const href = safeHttpUrl(raw);
                if (href) {
                    flush();
                    parts.push(`<a href="${escapeFormatHtml(href)}" target="_blank" rel="noopener noreferrer nofollow ugc">${escapeFormatHtml(raw)}</a>`);
                    i += raw.length;
                    continue;
                }
            }
        }

        // Mentions the server resolved for this message
        if (ch === '@' && !/[A-Za-z0-9_@]/.test(prev)) {
            const match = FORMAT_MENTION_PATTERN.exec(line.slice(i));
            if (match && ctx.mentions.has(match[1].toLowerCase())) {
                flush();
                const isMe = ctx.currentUserId !== undefined && ctx.mentions.get(match[1].toLowerCase()) === Number(ctx.currentUserId);
                parts.push(`<span class="mention${isMe ? ' mention-me' : ''}">${escapeFormatHtml(match[0])}</span>`);
                i += match[0].length;
                continue;
            }
        }

        // Emphasis
        const marker = line.startsWith('**', i) ? '**' : (ch === '_' || ch === '~' ? ch : null);
        if (marker) {
            const next = line[i + marker.length] || '';
            const boundary = marker === '**';
            const canClose = !!prev && !/\s/.test(prev) && (boundary || !isFormatWordChar(next));
            const canOpen = !!next && !/\s/.test(next) && (boundary || !isFormatWordChar(prev));

            if (canClose) {
                let j = stack.length - 1;
                while (j >= 0 && stack[j].marker !== marker) j--;
                if (j >= 0) {
                    flush();
                    const opener = stack[j];
                    if (parts.length > opener.index + 1) {
                        // Openers above it were never closed: they stay as literal text
                        stack.length = j;
                        parts[opener.index] = FORMAT_TAGS[marker][0];
                        parts.push(FORMAT_TAGS[marker][1]);
                        i += marker.length;
                        continue;
                    }
                }
            }

            if (canOpen) {
                flush();
                stack.push({ marker, index: parts.length });
                parts.push(escapeFormatHtml(marker));
                i += marker.length;
                continue;
            }

            text += marker;
            i += marker.length;
            continue;
        }

        text += ch;
        i++;
    }

    flush();
    return parts.join('');
}

function formatInline(segment, ctx) {
    return segment.split('\n').map(line => formatLine(line, ctx)).join('\n');
}

function renderCodeBlock(language, code) {
    const body = code.replace(/^\n/, '').replace(/\n$/, '');
    return '<div class="code-block">'
        + '<div class="code-block-header">'
        + `<span class="code-block-lang">${language ? escapeFormatHtml(language) : 'code'}</span>`
        + '<button type="button" class="code-copy-btn" data-copy-code aria-label="Copy code">Copy</button>'
        + '</div>'
        + `<pre><code>${escapeFormatHtml(body)}</code></pre>`
        + '</div>';
}

/**
 * Message text -> safe HTML.
 * options.mentions: [{ user_id, username }] stored for the message; options.currentUserId marks your own mentions.
 */
function formatMessageText(text, options = {}) {
    if (text === null || text === undefined) return '';
    const source = String(text);

    const ctx = {
        mentions: new Map((options.mentions || []).map(m => [String(m.username).toLowerCase(), Number(m.user_id)])),
        currentUserId: options.currentUserId
    };

    const out = [];
    let last = 0;
    let match;
    FORMAT_FENCE_PATTERN.lastIndex = 0;
    while ((match = FORMAT_FENCE_PATTERN.exec(source)) !== null) {
        if (!match[2].trim()) continue; // ``` ``` with nothing inside stays text
        // A block starts on its own line, so drop the line break that separates it from the text
        out.push(formatInline(source.slice(last, match.index).replace(/\n$/, ''), ctx));
        out.push(renderCodeBlock(match[1], match[2]));
        last = FORMAT_FENCE_PATTERN.lastIndex;
        if (source[last] === '\n') last++;
    }
    out.push(formatInline(source.slice(last), ctx));
    return out.join('');
}

// Node tests load this file directly
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatMessageText, safeHttpUrl };
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    safeHttpUrl,
    formatMessageText
});
})(globalThis.FriChat = globalThis.FriChat || {});
