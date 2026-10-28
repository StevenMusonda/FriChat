/**
 * @mention autocomplete in the composer (group chats only).
 * Typing @ opens a list of the chat's members (currentChatMembers, filled by loadChatDetails);
 * Arrow keys move, Enter or Tab inserts @username, Escape closes. The server decides who was
 * actually mentioned (utils/mentions.js); this only helps typing the name.
 */

const MAX_MENTION_SUGGESTIONS = 6;

// { start, items, active } while the list is open
let mentionState = null;

/**
 * The "@query" being typed right before the caret, or null.
 * '@' must not follow a word character, so e-mail addresses don't open the list.
 */
function findMentionQuery(value, caret) {
    const before = value.slice(0, caret);
    const match = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{0,50})$/.exec(before);
    if (!match) return null;
    return { start: caret - match[2].length - 1, query: match[2] };
}

/**
 * Members whose username or a word of their name starts with the query (then those containing it)
 */
function matchMentionMembers(members, query) {
    const q = query.toLowerCase();
    const scored = [];
    for (const member of members || []) {
        const username = String(member.username || '').toLowerCase();
        const name = String(member.full_name || '').toLowerCase();
        let score = -1;
        if (username.startsWith(q)) score = 0;
        else if (name.split(/\s+/).some(word => word.startsWith(q))) score = 1;
        else if (username.includes(q) || name.includes(q)) score = 2;
        if (score >= 0) scored.push({ member, score });
    }
    scored.sort((a, b) => a.score - b.score || String(a.member.username).localeCompare(String(b.member.username)));
    return scored.slice(0, MAX_MENTION_SUGGESTIONS).map(entry => entry.member);
}

function closeMentionSuggestions() {
    mentionState = null;
    const box = document.getElementById('mentionSuggestions');
    const input = document.getElementById('messageInput');
    if (box) {
        box.hidden = true;
        box.replaceChildren();
    }
    if (input) {
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }
}

function renderMentionSuggestions() {
    const box = document.getElementById('mentionSuggestions');
    const input = document.getElementById('messageInput');

    box.replaceChildren(...mentionState.items.map((member, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `mention-option${index === mentionState.active ? ' active' : ''}`;
        option.id = `mentionOption${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === mentionState.active ? 'true' : 'false');
        option.dataset.index = index;

        const avatar = document.createElement('span');
        avatar.className = 'mention-option-avatar';
        avatar.textContent = String(member.full_name || member.username).charAt(0).toUpperCase();

        const name = document.createElement('span');
        name.className = 'mention-option-name';
        name.textContent = member.full_name || member.username;

        const handle = document.createElement('span');
        handle.className = 'mention-option-username';
        handle.textContent = `@${member.username}`;

        option.append(avatar, name, handle);
        return option;
    }));

    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `mentionOption${mentionState.active}`);
    const active = box.querySelector('.mention-option.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateMentionSuggestions() {
    const input = document.getElementById('messageInput');
    if (!currentChatMembers.length || input.selectionStart !== input.selectionEnd) {
        closeMentionSuggestions();
        return;
    }

    const found = findMentionQuery(input.value, input.selectionStart);
    const items = found ? matchMentionMembers(currentChatMembers, found.query) : [];
    if (!found || items.length === 0) {
        closeMentionSuggestions();
        return;
    }

    const previous = mentionState && mentionState.start === found.start ? mentionState.active : 0;
    mentionState = { start: found.start, items, active: Math.min(previous, items.length - 1) };
    renderMentionSuggestions();
}

/**
 * Replace the typed "@query" with "@username "
 */
function insertMention(index) {
    if (!mentionState || !mentionState.items[index]) return;
    const input = document.getElementById('messageInput');
    const member = mentionState.items[index];
    const caret = input.selectionStart;
    const text = `@${member.username} `;

    input.setRangeText(text, mentionState.start, caret, 'end');
    closeMentionSuggestions();
    input.focus();
    autoResizeComposer();
}

function handleMentionKeydown(e) {
    if (!mentionState) return;

    const count = mentionState.items.length;
    let handled = true;
    if (e.key === 'ArrowDown') {
        mentionState.active = (mentionState.active + 1) % count;
        renderMentionSuggestions();
    } else if (e.key === 'ArrowUp') {
        mentionState.active = (mentionState.active - 1 + count) % count;
        renderMentionSuggestions();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        insertMention(mentionState.active);
    } else if (e.key === 'Escape') {
        closeMentionSuggestions();
    } else {
        handled = false;
    }

    if (handled) {
        // Keeps Enter from sending and Escape from cancelling a reply while the list is open
        e.preventDefault();
        e.stopImmediatePropagation();
    }
}

function initializeMentionAutocomplete() {
    const input = document.getElementById('messageInput');
    const box = document.getElementById('mentionSuggestions');

    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'mentionSuggestions');
    input.setAttribute('aria-expanded', 'false');

    // Capture phase: runs before the composer's other key handlers
    input.addEventListener('keydown', handleMentionKeydown, true);
    input.addEventListener('input', updateMentionSuggestions);
    input.addEventListener('click', updateMentionSuggestions);
    input.addEventListener('blur', () => setTimeout(closeMentionSuggestions, 150));

    // Keep focus in the composer while picking with the mouse
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
        const option = e.target.closest('[data-index]');
        if (option) insertMention(parseInt(option.dataset.index));
    });
}

// Node tests load this file directly
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { findMentionQuery, matchMentionMembers };
}
