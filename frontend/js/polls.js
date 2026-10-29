/**
 * Polls (phase 8): the create dialog, the poll card inside a message, voting and live updates.
 * The server owns every rule (members only, single choice, closed polls); this only renders state
 * it receives. All poll text is user content and goes through escapeHtml.
 */

// Polls with a vote on its way (the card dims until poll_updated arrives)
const pendingPollIds = new Set();
// The poll shown in the "View votes" dialog (kept in step with poll_updated while it's open)
let votesDialogPollId = null;
// Inline voter names per option on the card; the full list is in the dialog
const INLINE_VOTER_NAMES = 3;

/**
 * The poll card for a message of type 'poll' (messages.js renderMessageContent)
 */
function renderPollHtml(message) {
    const poll = message.poll;
    if (!poll) {
        return `<div class="poll"><div class="poll-question">${escapeHtml(message.content || 'Poll')}</div><div class="poll-meta">This poll is no longer available</div></div>`;
    }

    const mine = new Set(poll.myVotes || []);
    const currentUser = getCurrentUser();
    const isCreator = currentUser && poll.createdBy === currentUser.userId;

    const options = poll.options.map((option) => {
        const chosen = mine.has(option.id);
        const percent = Math.min(Math.max(parseInt(option.percent) || 0, 0), 100);
        const voters = option.voters || [];
        let votersHtml = '';
        if (!poll.anonymous && voters.length > 0) {
            const shown = voters.slice(0, INLINE_VOTER_NAMES);
            const more = voters.length - shown.length;
            votersHtml = `<div class="poll-option-voters">${escapeHtml(shown.map(v => v.name).join(', '))}${more > 0 ? ` +${more}` : ''}</div>`;
        }
        return `
            <li class="poll-option-row">
                <button type="button"
                        class="poll-option ${chosen ? 'chosen' : ''}"
                        data-poll-id="${parseInt(poll.id)}"
                        data-option-id="${parseInt(option.id)}"
                        aria-pressed="${chosen}"
                        ${poll.closed ? 'disabled' : ''}>
                    <span class="poll-option-bar" style="width: ${percent}%" aria-hidden="true"></span>
                    <span class="poll-option-check ${poll.multipleChoice ? 'multi' : ''}" aria-hidden="true"></span>
                    <span class="poll-option-text">${escapeHtml(option.text)}</span>
                    <span class="poll-option-count">${percent}% · ${parseInt(option.votes) || 0}</span>
                </button>
                ${votersHtml}
            </li>
        `;
    }).join('');

    const meta = [
        `${poll.voterCount} ${poll.voterCount === 1 ? 'vote' : 'votes'}`,
        poll.anonymous ? 'Anonymous' : null,
        poll.multipleChoice ? 'Multiple choice' : 'One choice',
        poll.closed
            ? 'Closed'
            : (poll.closesAt ? `Closes ${formatPlannerTime(poll.closesAt)}` : null)
    ].filter(Boolean).join(' · ');

    return `
        <div class="poll ${poll.closed ? 'closed' : ''} ${pendingPollIds.has(poll.id) ? 'pending' : ''}" data-poll="${parseInt(poll.id)}">
            <div class="poll-label">📊 Poll</div>
            <div class="poll-question">${escapeHtml(poll.question)}</div>
            <ul class="poll-options" aria-label="Poll options">${options}</ul>
            <div class="poll-meta">${escapeHtml(meta)}</div>
            <div class="poll-actions">
                ${!poll.anonymous ? `<button type="button" class="poll-link" data-poll-votes="${parseInt(poll.id)}" aria-haspopup="dialog">View votes</button>` : ''}
                ${isCreator && !poll.closed ? `<button type="button" class="poll-link" data-poll-close="${parseInt(poll.id)}">Close poll</button>` : ''}
            </div>
        </div>
    `;
}

function findPollMessage(pollId) {
    return currentMessages.find(m => m.poll && m.poll.id === pollId);
}

function rerenderPoll(message) {
    const element = document.querySelector(`#messagesContainer [data-message-id="${message.id}"] .poll`);
    if (element) element.outerHTML = renderPollHtml(message);
}

/**
 * poll_updated (or a REST answer): counts for everyone, myVotes only on our own copy
 */
function applyPollUpdate(poll) {
    if (!poll || !poll.messageId) return;
    pendingPollIds.delete(poll.id);
    if (votesDialogPollId === poll.id) renderPollVotes(poll);
    const message = currentMessages.find(m => m.id === poll.messageId);
    if (!message) return;
    const previous = message.poll || {};
    message.poll = {
        ...poll,
        myVotes: Array.isArray(poll.myVotes) ? poll.myVotes : (previous.myVotes || [])
    };
    rerenderPoll(message);
}

/**
 * The selection after clicking an option: single choice switches (or takes back), multiple toggles
 */
function nextPollSelection(poll, optionId) {
    const mine = poll.myVotes || [];
    if (poll.multipleChoice) {
        return mine.includes(optionId) ? mine.filter(id => id !== optionId) : [...mine, optionId];
    }
    return mine.includes(optionId) ? [] : [optionId];
}

async function voteInPoll(pollId, optionId) {
    const message = findPollMessage(pollId);
    if (!message || message.poll.closed || pendingPollIds.has(pollId)) return;

    const optionIds = nextPollSelection(message.poll, optionId);
    pendingPollIds.add(pollId);
    rerenderPoll(message);

    // Socket first (poll_updated comes back); REST when the socket is down
    if (votePollViaSocket(pollId, optionIds)) {
        // If nothing comes back (error event, rate limit), un-dim after a moment
        setTimeout(() => {
            if (pendingPollIds.delete(pollId)) {
                const current = findPollMessage(pollId);
                if (current) rerenderPoll(current);
            }
        }, 5000);
        return;
    }

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.POLL_VOTES(pollId), {
            method: 'PUT',
            body: JSON.stringify({ optionIds })
        });
        if (response.success) {
            applyPollUpdate(response.data);
        } else {
            showNotification(response.message || 'Could not save your vote', 'error');
        }
    } catch (error) {
        showNotification('Could not save your vote', 'error');
    } finally {
        if (pendingPollIds.delete(pollId)) {
            const current = findPollMessage(pollId);
            if (current) rerenderPoll(current);
        }
    }
}

async function closePollEarly(pollId) {
    if (!confirm('Close this poll? Nobody will be able to vote any more.')) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.POLL_CLOSE(pollId), { method: 'POST' });
        if (response.success) {
            applyPollUpdate(response.data);
        } else {
            showNotification(response.message || 'Could not close the poll', 'error');
        }
    } catch (error) {
        showNotification('Could not close the poll', 'error');
    }
}

/* ===== "View votes" dialog ===== */

/**
 * One line about the poll's state: closed by whom and when, or when it closes
 */
function pollStatusText(poll) {
    if (poll.closed) {
        const when = poll.closedAt ? ` ${formatPlannerTime(poll.closedAt)}` : '';
        if (poll.closedAutomatically) return `Closed automatically${when}`;
        const by = poll.closedBy && poll.closedBy.name ? ` by ${poll.closedBy.name}` : '';
        return `Closed${by}${when}`;
    }
    return poll.closesAt ? `Open · closes ${formatPlannerTime(poll.closesAt)}` : 'Open · no end time';
}

/**
 * Fill the dialog from a poll state. Built from DOM nodes: every user-written text goes in with textContent.
 * Anonymous polls show counts only (the server never sends their voters).
 */
function renderPollVotes(poll) {
    const body = document.getElementById('pollVotesBody');
    if (!body || !poll) return;
    body.replaceChildren();

    body.appendChild(plannerEl('div', 'poll-votes-question', poll.question));
    const summary = [
        `${poll.voterCount} ${poll.voterCount === 1 ? 'person voted' : 'people voted'}`,
        poll.multipleChoice ? 'Multiple choice' : 'One choice',
        poll.anonymous ? 'Anonymous' : null
    ].filter(Boolean).join(' · ');
    body.appendChild(plannerEl('div', 'poll-votes-summary', summary));
    body.appendChild(plannerEl('div', 'poll-votes-status', pollStatusText(poll)));
    if (poll.anonymous) {
        body.appendChild(plannerEl('p', 'poll-votes-note', 'This poll is anonymous, so only the counts are shown.'));
    }

    for (const option of poll.options) {
        const percent = Math.min(Math.max(parseInt(option.percent) || 0, 0), 100);
        const votes = parseInt(option.votes) || 0;
        const section = plannerEl('section', 'poll-votes-option');

        const head = plannerEl('div', 'poll-votes-option-head');
        head.append(
            plannerEl('span', 'poll-votes-option-text', option.text),
            plannerEl('span', 'poll-votes-option-count', `${votes} ${votes === 1 ? 'vote' : 'votes'} · ${percent}%`)
        );
        const bar = plannerEl('div', 'poll-votes-bar');
        const fill = plannerEl('span', 'poll-votes-bar-fill');
        fill.style.width = `${percent}%`;
        bar.appendChild(fill);
        section.append(head, bar);

        if (!poll.anonymous) {
            const voters = option.voters || [];
            if (voters.length === 0) {
                section.appendChild(plannerEl('p', 'poll-votes-empty', 'No votes'));
            } else {
                const list = plannerEl('ul', 'poll-votes-voters');
                for (const voter of voters) {
                    const name = String(voter.name || 'Unknown');
                    const item = plannerEl('li', 'poll-votes-voter');
                    const avatar = plannerEl('span', 'poll-votes-avatar', name.charAt(0).toUpperCase());
                    avatar.setAttribute('aria-hidden', 'true');
                    item.append(avatar, plannerEl('span', 'poll-votes-name', name));
                    list.appendChild(item);
                }
                section.appendChild(list);
            }
        }
        body.appendChild(section);
    }
}

function isPollVotesOpen() {
    const modal = document.getElementById('pollVotesModal');
    return !!modal && modal.style.display === 'flex';
}

/**
 * Open the dialog with the card's data right away, then refresh it from the server
 * (works after a reload or live updates: it never depends on the card's own DOM)
 */
async function openPollVotes(pollId) {
    const message = findPollMessage(pollId);
    votesDialogPollId = pollId;
    if (message) renderPollVotes(message.poll);
    document.getElementById('pollVotesModal').style.display = 'flex';
    document.getElementById('closePollVotes').focus();

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.POLL(pollId));
        if (votesDialogPollId !== pollId) return;
        if (response.success) {
            renderPollVotes(response.data);
        } else if (!message) {
            closePollVotes();
            showNotification(response.message || 'Could not load the votes', 'error');
        }
    } catch (error) {
        if (!message && votesDialogPollId === pollId) {
            closePollVotes();
            showNotification('Could not load the votes', 'error');
        }
    }
}

function closePollVotes() {
    const modal = document.getElementById('pollVotesModal');
    if (modal) modal.style.display = 'none';
    votesDialogPollId = null;
}

/* ===== Create dialog ===== */

function openPollModal() {
    if (!currentChatId) return;
    if (typeof canPostInCurrentChat === 'function' && !canPostInCurrentChat()) {
        showNotification('Only admins can send messages in this group', 'error');
        return;
    }
    const modal = document.getElementById('pollModal');
    document.getElementById('pollQuestion').value = '';
    document.getElementById('pollMultiple').checked = false;
    document.getElementById('pollAnonymous').checked = false;
    document.getElementById('pollCloses').value = '';
    const custom = document.getElementById('pollClosesAt');
    custom.hidden = true;
    custom.value = '';
    setPlannerStatus('pollStatus', '');

    const list = document.getElementById('pollOptionList');
    list.replaceChildren();
    addPollOptionInput();
    addPollOptionInput();

    modal.style.display = 'flex';
    document.getElementById('pollQuestion').focus();
}

function closePollModal() {
    document.getElementById('pollModal').style.display = 'none';
}

function updatePollOptionControls() {
    const rows = document.querySelectorAll('#pollOptionList .poll-option-input');
    rows.forEach((row, index) => {
        const input = row.querySelector('input');
        input.placeholder = `Option ${index + 1}`;
        input.setAttribute('aria-label', `Option ${index + 1}`);
        row.querySelector('button').hidden = rows.length <= CONFIG.POLL_MIN_OPTIONS;
    });
    document.getElementById('pollAddOption').hidden = rows.length >= CONFIG.POLL_MAX_OPTIONS;
}

function addPollOptionInput() {
    const list = document.getElementById('pollOptionList');
    if (list.children.length >= CONFIG.POLL_MAX_OPTIONS) return;

    const row = document.createElement('div');
    row.className = 'poll-option-input';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = CONFIG.POLL_OPTION_MAX_LENGTH;
    input.autocomplete = 'off';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.title = 'Remove option';
    remove.setAttribute('aria-label', 'Remove option');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
        row.remove();
        updatePollOptionControls();
    });
    // Enter in the last option adds another one
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (row === list.lastElementChild && input.value.trim()) {
                addPollOptionInput();
                list.lastElementChild.querySelector('input').focus();
            }
        }
    });
    row.append(input, remove);
    list.appendChild(row);
    updatePollOptionControls();
}

/**
 * The form's values, checked the way the server checks them
 * @returns {{ ok: true, body } | { ok: false, error }}
 */
function readPollForm() {
    const question = document.getElementById('pollQuestion').value.trim();
    if (!question) return { ok: false, error: 'Ask a question' };

    const options = [...document.querySelectorAll('#pollOptionList input')]
        .map(input => input.value.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (options.length < CONFIG.POLL_MIN_OPTIONS) return { ok: false, error: `Add at least ${CONFIG.POLL_MIN_OPTIONS} options` };
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) {
        return { ok: false, error: 'Options must be different from each other' };
    }

    let closesAt = null;
    const closes = document.getElementById('pollCloses').value;
    if (closes === 'custom') {
        const picked = parseDateTimeLocal(document.getElementById('pollClosesAt').value);
        if (!picked || picked.getTime() <= Date.now()) return { ok: false, error: 'Pick a closing time in the future' };
        closesAt = picked.toISOString();
    } else if (closes) {
        closesAt = new Date(Date.now() + parseInt(closes) * 60 * 60 * 1000).toISOString();
    }

    return {
        ok: true,
        body: {
            question,
            options,
            multipleChoice: document.getElementById('pollMultiple').checked,
            anonymous: document.getElementById('pollAnonymous').checked,
            closesAt
        }
    };
}

async function submitPoll() {
    const form = readPollForm();
    if (!form.ok) {
        setPlannerStatus('pollStatus', form.error, true);
        return;
    }
    const button = document.getElementById('pollSubmitBtn');
    button.disabled = true;
    try {
        const chatId = currentChatId;
        const response = await apiRequest(CONFIG.ENDPOINTS.POLLS, {
            method: 'POST',
            body: JSON.stringify({ chatId, ...form.body })
        });
        if (response.success) {
            closePollModal();
            // Usually new_message got here first; this covers a disconnected socket
            if (response.data && response.data.chat_id === currentChatId) addMessageToUI(response.data);
        } else {
            const detail = response.errors && response.errors[0] ? response.errors[0].msg : null;
            setPlannerStatus('pollStatus', detail || response.message || 'Could not create the poll', true);
        }
    } catch (error) {
        setPlannerStatus('pollStatus', 'Could not create the poll', true);
    } finally {
        button.disabled = false;
    }
}

function initializePolls() {
    const pollBtn = document.getElementById('pollBtn');
    if (pollBtn) pollBtn.addEventListener('click', openPollModal);

    document.getElementById('closePollModal').addEventListener('click', closePollModal);
    document.getElementById('cancelPoll').addEventListener('click', closePollModal);
    document.getElementById('pollAddOption').addEventListener('click', () => {
        addPollOptionInput();
        const list = document.getElementById('pollOptionList');
        list.lastElementChild.querySelector('input').focus();
    });
    document.getElementById('pollSubmitBtn').addEventListener('click', submitPoll);
    document.getElementById('pollQuestion').maxLength = CONFIG.POLL_QUESTION_MAX_LENGTH;
    document.getElementById('pollCloses').addEventListener('change', (e) => {
        const custom = document.getElementById('pollClosesAt');
        custom.hidden = e.target.value !== 'custom';
        if (!custom.hidden) {
            custom.min = toDateTimeLocalValue(new Date());
            if (!custom.value) custom.value = toDateTimeLocalValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
        }
    });

    // Options, "View votes" and "Close poll" inside poll cards. Delegated on the container, which is
    // never replaced, so it keeps working for cards from history, live messages and every re-render.
    document.getElementById('messagesContainer').addEventListener('click', (e) => {
        const option = e.target.closest('[data-option-id]');
        if (option && !option.disabled) {
            voteInPoll(parseInt(option.dataset.pollId), parseInt(option.dataset.optionId));
            return;
        }
        const votes = e.target.closest('[data-poll-votes]');
        if (votes) {
            openPollVotes(parseInt(votes.dataset.pollVotes));
            return;
        }
        const close = e.target.closest('[data-poll-close]');
        if (close) closePollEarly(parseInt(close.dataset.pollClose));
    });

    // "View votes" dialog: close button, a click on the backdrop, or Esc
    const votesModal = document.getElementById('pollVotesModal');
    document.getElementById('closePollVotes').addEventListener('click', closePollVotes);
    votesModal.addEventListener('click', (e) => {
        if (e.target === votesModal) closePollVotes();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isPollVotesOpen()) {
            e.preventDefault();
            closePollVotes();
        }
    });

    onPlannerEvent((event, data) => {
        if (event === 'poll_updated') applyPollUpdate(data);
    });

    // A refused vote (closed poll, rate limit) un-dims the card right away
    onSocketError((data) => {
        if (data.event === 'poll_vote' && data.pollId) {
            const pollId = parseInt(data.pollId);
            if (pendingPollIds.delete(pollId)) {
                const message = findPollMessage(pollId);
                if (message) rerenderPoll(message);
            }
        }
    });
}
