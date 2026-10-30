/**
 * Events (phase 12): the event card inside a message, Going / Maybe / Can't go answers (live), the
 * create/edit dialog, the details dialog with names and "Add to calendar" (.ics), "My events" across
 * chats, the "Events & lists" section of chat info, the event/list notices in the thread, event
 * reminders, and the birthday banner in groups.
 *
 * The server owns every rule (members only, creator-only edits, reminders); this only renders the
 * state it receives. Times come as UTC ISO strings and are shown in the viewer's timezone, plus the
 * time where the event was planned when that zone is different.
 * Card HTML escapes every user text; dialogs are built with textContent (FriChat.h).
 */

(function (FriChat) {

const RSVP_CHOICES = [
    { key: 'going', label: 'Going', short: 'going' },
    { key: 'maybe', label: 'Maybe', short: 'maybe' },
    { key: 'declined', label: 'Can\'t go', short: 'can\'t go' }
];
const REMINDER_CHOICES = [
    { key: 'start', label: 'When it starts' },
    { key: '1h', label: '1 hour before' },
    { key: '1d', label: '1 day before' }
];
// Names under the answer counts on a card; the details dialog has everyone
const INLINE_NAMES = 3;

// Events with an answer on its way (the card dims until event_updated arrives)
const pendingRsvp = new Set();
// The event dialog: null = new event, else the event being edited
let editingEvent = null;
// The event in the details dialog
let detailsEventId = null;
// "Events & lists" section of chat info: { chatId, element, tab, events, past, showPast, loading }
let plansSection = null;
// "My events": { scope, filter, items, loading }
const myEvents = { scope: 'upcoming', filter: 'all', items: [], loading: false };
// Birthday banner of the open chat: { chatId, date, people }
let birthdayState = null;

/* ===== Small helpers ===== */

function h(...args) {
    return FriChat.h(...args);
}

function myUserId() {
    const user = getCurrentUser();
    return user ? Number(user.userId) : null;
}

function viewerZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
        return 'UTC';
    }
}

/**
 * The viewer's own answer, from the lists of names (room broadcasts don't carry myRsvp)
 */
function deriveMyRsvp(event) {
    const me = myUserId();
    for (const choice of RSVP_CHOICES) {
        if (((event.rsvps && event.rsvps[choice.key]) || []).some(person => Number(person.userId) === me)) return choice.key;
    }
    return null;
}

function withMyRsvp(event) {
    return event ? { ...event, myRsvp: deriveMyRsvp(event) } : event;
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDay(date, now = new Date()) {
    const options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString([], options);
}

function formatClock(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * "Fri 7 Nov, 18:00 – 21:00" or "Fri 7 Nov, 18:00 – Sat 8 Nov, 11:00" (viewer's timezone)
 */
function formatEventRange(event) {
    const start = new Date(event.startsAt);
    const end = new Date(event.endsAt);
    if (Number.isNaN(start.getTime())) return '';
    if (Number.isNaN(end.getTime())) return `${formatDay(start)}, ${formatClock(start)}`;
    return sameDay(start, end)
        ? `${formatDay(start)}, ${formatClock(start)} – ${formatClock(end)}`
        : `${formatDay(start)}, ${formatClock(start)} – ${formatDay(end)}, ${formatClock(end)}`;
}

/**
 * "18:00 in Europe/Berlin" when the event was planned in another timezone, else ''
 */
function plannedZoneNote(event) {
    if (!event.timezone || event.timezone === viewerZone()) return '';
    try {
        const time = new Date(event.startsAt).toLocaleString([], {
            timeZone: event.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit'
        });
        return `${time} in ${event.timezone.replace(/_/g, ' ')}`;
    } catch (e) {
        return '';
    }
}

function countsText(event) {
    const counts = event.counts || {};
    return RSVP_CHOICES
        .map(choice => `${parseInt(counts[choice.key]) || 0} ${choice.short}`)
        .join(' · ');
}

function stateLabel(event) {
    if (event.status === 'cancelled') return 'Cancelled';
    if (event.ended) return 'Ended';
    if (event.started) return 'Happening now';
    return null;
}

function firstError(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors[0]) return response.errors[0].msg;
    return (response && response.message) || fallback;
}

/* ===== The card in the thread ===== */

/**
 * The event card for a message of type 'event' (messages.js renderMessageContent)
 */
function renderEventCardHtml(message) {
    const event = message.event;
    if (!event) {
        return `<div class="event-card"><div class="event-card-label">📅 Event</div><div class="event-card-title">${escapeHtml(message.content || 'Event')}</div><div class="event-card-meta">This event is no longer available</div></div>`;
    }

    const id = parseInt(event.id);
    const mine = event.myRsvp !== undefined ? event.myRsvp : deriveMyRsvp(event);
    const closed = event.status === 'cancelled' || event.ended;
    const state = stateLabel(event);
    const zone = plannedZoneNote(event);
    const going = (event.rsvps && event.rsvps.going) || [];
    const shown = going.slice(0, INLINE_NAMES).map(p => p.name);
    const more = going.length - shown.length;

    const buttons = RSVP_CHOICES.map(choice => `
        <button type="button" class="event-rsvp-btn ${mine === choice.key ? 'chosen' : ''}"
                data-event-rsvp="${choice.key}" data-event-id="${id}"
                aria-pressed="${mine === choice.key}" ${closed ? 'disabled' : ''}>${escapeHtml(choice.label)}</button>
    `).join('');

    return `
        <div class="event-card ${event.status === 'cancelled' ? 'cancelled' : ''} ${event.ended ? 'ended' : ''} ${pendingRsvp.has(id) ? 'pending' : ''}" data-event-card="${id}">
            <div class="event-card-label">📅 Event${state ? ` · ${escapeHtml(state)}` : ''}</div>
            <div class="event-card-title">${escapeHtml(event.title)}</div>
            <div class="event-card-when">${escapeHtml(formatEventRange(event))}</div>
            ${zone ? `<div class="event-card-zone">${escapeHtml(zone)}</div>` : ''}
            ${event.location ? `<div class="event-card-where">📍 ${escapeHtml(event.location)}</div>` : ''}
            <div class="event-rsvp-row" role="group" aria-label="Your answer">${buttons}</div>
            <div class="event-card-meta">${escapeHtml(countsText(event))}</div>
            ${shown.length ? `<div class="event-card-names">${escapeHtml(shown.join(', '))}${more > 0 ? ` +${more}` : ''}</div>` : ''}
            <div class="poll-actions">
                <button type="button" class="poll-link" data-event-open="${id}" aria-haspopup="dialog">Details</button>
                ${event.status !== 'cancelled' ? `<button type="button" class="poll-link" data-event-ics="${id}">Add to calendar</button>` : ''}
            </div>
        </div>
    `;
}

function rerenderEventCards(eventId) {
    for (const message of currentMessages) {
        if (!message.event || message.event.id !== eventId) continue;
        const element = document.querySelector(`#messagesContainer [data-message-id="${message.id}"] .event-card`);
        if (element) element.outerHTML = renderEventCardHtml(message);
    }
}

/**
 * event_updated (or a REST answer): replace the event everywhere it is shown
 */
function applyEventUpdate(event) {
    if (!event || !event.id) return;
    const shaped = withMyRsvp(event);
    pendingRsvp.delete(shaped.id);

    for (const message of currentMessages) {
        if (message.event && message.event.id === shaped.id) message.event = shaped;
    }
    rerenderEventCards(shaped.id);

    if (detailsEventId === shaped.id) renderEventDetails(shaped);

    if (plansSection && plansSection.chatId === shaped.chatId) {
        for (const key of ['events', 'past']) {
            const index = (plansSection[key] || []).findIndex(e => e.id === shaped.id);
            if (index >= 0) plansSection[key][index] = shaped;
        }
        if (!(plansSection.events || []).some(e => e.id === shaped.id) && !shaped.ended && shaped.status === 'active') {
            plansSection.events = [...(plansSection.events || []), shaped]
                .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        }
        if (plansSection.tab === 'events') renderPlansEvents();
    }

    const index = myEvents.items.findIndex(e => e.id === shaped.id);
    if (index >= 0) {
        myEvents.items[index] = shaped;
        if (isOpen('myEventsModal')) renderMyEvents();
    }
}

function findKnownEvent(eventId) {
    const message = currentMessages.find(m => m.event && m.event.id === eventId);
    if (message) return message.event;
    if (plansSection) {
        const found = [...(plansSection.events || []), ...(plansSection.past || [])].find(e => e.id === eventId);
        if (found) return found;
    }
    return myEvents.items.find(e => e.id === eventId) || null;
}

/**
 * Answer (clicking your current answer takes it back). Socket first; REST when it's down.
 */
async function answerEvent(eventId, choice) {
    if (pendingRsvp.has(eventId)) return;
    const known = findKnownEvent(eventId);
    const current = known ? deriveMyRsvp(known) : null;
    const response = current === choice ? null : choice;

    pendingRsvp.add(eventId);
    rerenderEventCards(eventId);

    if (emitPlanEvent('event_rsvp', { eventId, response })) {
        // If nothing comes back (error event, rate limit), un-dim after a moment
        setTimeout(() => {
            if (pendingRsvp.delete(eventId)) rerenderEventCards(eventId);
        }, 5000);
        return;
    }

    try {
        const result = await apiRequest(CONFIG.ENDPOINTS.EVENT_RSVP(eventId), {
            method: 'PUT',
            body: JSON.stringify({ response })
        });
        if (result.success) applyEventUpdate(result.data);
        else showNotification(firstError(result, 'Could not save your answer'), 'error');
    } catch (error) {
        showNotification('Could not save your answer', 'error');
    } finally {
        if (pendingRsvp.delete(eventId)) rerenderEventCards(eventId);
    }
}

/* ===== .ics download ===== */

async function downloadEventIcs(eventId) {
    try {
        const token = await getAccessToken();
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.EVENT_ICS(eventId)}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            let message = 'Could not download the calendar file';
            try { message = (await response.json()).message || message; } catch (e) { /* not JSON */ }
            showNotification(message, 'error');
            return;
        }
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = /filename="([^"]+)"/.exec(disposition);
        const url = URL.createObjectURL(await response.blob());
        const link = h('a', { attrs: { href: url, download: match ? match[1] : 'event.ics' } });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
        showNotification('Could not download the calendar file', 'error');
    }
}

/* ===== Details dialog ===== */

function isOpen(id) {
    const modal = document.getElementById(id);
    return !!modal && modal.style.display === 'flex';
}

function renderEventDetails(event) {
    const body = document.getElementById('eventDetailsBody');
    if (!body || !event) return;
    const mine = deriveMyRsvp(event);
    const closed = event.status === 'cancelled' || event.ended;
    const isCreator = Number(event.createdBy) === myUserId();
    const state = stateLabel(event);
    const zone = plannedZoneNote(event);

    document.getElementById('eventDetailsTitle').textContent = event.title;

    const answers = h('div', { className: 'event-rsvp-row', attrs: { role: 'group', 'aria-label': 'Your answer' } },
        RSVP_CHOICES.map(choice => h('button', {
            className: `event-rsvp-btn ${mine === choice.key ? 'chosen' : ''}`,
            text: choice.label,
            attrs: { type: 'button', 'aria-pressed': mine === choice.key ? 'true' : 'false', disabled: closed },
            on: { click: () => answerEvent(event.id, choice.key) }
        }))
    );

    const people = RSVP_CHOICES.map(choice => {
        const list = (event.rsvps && event.rsvps[choice.key]) || [];
        return h('section', { className: 'event-people' },
            h('div', { className: 'event-people-head', text: `${choice.label} (${list.length})` }),
            list.length === 0
                ? h('p', { className: 'poll-votes-empty', text: 'Nobody yet' })
                : h('ul', { className: 'poll-votes-voters' }, list.map(person => h('li', { className: 'poll-votes-voter' },
                    h('span', { className: 'poll-votes-avatar', text: String(person.name || '?').charAt(0).toUpperCase(), attrs: { 'aria-hidden': 'true' } }),
                    h('span', { className: 'poll-votes-name', text: person.name || 'Unknown' })
                )))
        );
    });

    const reminders = (event.reminders || [])
        .map(key => (REMINDER_CHOICES.find(r => r.key === key) || {}).label)
        .filter(Boolean);

    const actions = h('div', { className: 'event-details-actions' },
        event.status !== 'cancelled'
            ? h('button', { className: 'btn btn-secondary btn-small', text: 'Add to calendar (.ics)', attrs: { type: 'button' }, on: { click: () => downloadEventIcs(event.id) } })
            : null,
        event.messageId
            ? h('button', {
                className: 'btn btn-secondary btn-small',
                text: 'Show in chat',
                attrs: { type: 'button' },
                on: { click: () => { closeAllEventDialogs(); jumpToMessage(event.chatId, event.messageId); } }
            })
            : null,
        isCreator && !closed
            ? h('button', { className: 'btn btn-secondary btn-small', text: 'Edit', attrs: { type: 'button' }, on: { click: () => openEventForm(event) } })
            : null,
        isCreator && event.status !== 'cancelled' && !event.ended
            ? h('button', { className: 'btn btn-danger btn-small', text: 'Cancel event', attrs: { type: 'button' }, on: { click: () => cancelEvent(event) } })
            : null
    );

    body.replaceChildren(
        state ? h('div', { className: `event-details-state ${event.status === 'cancelled' ? 'cancelled' : ''}`, text: state }) : null,
        h('div', { className: 'event-details-when', text: formatEventRange(event) }),
        zone ? h('div', { className: 'event-card-zone', text: zone }) : null,
        event.location ? h('div', { className: 'event-details-row', text: `📍 ${event.location}` }) : null,
        event.description ? h('p', { className: 'event-details-description', text: event.description }) : null,
        h('div', { className: 'event-details-row settings-row-hint', text: `Planned by ${event.createdByName || 'someone'}${reminders.length ? ` · Reminders: ${reminders.join(', ')}` : ''}` }),
        answers,
        h('div', { className: 'event-card-meta', text: countsText(event) }),
        ...people,
        actions
    );
}

async function openEventDetails(eventId) {
    detailsEventId = eventId;
    const known = findKnownEvent(eventId);
    const body = document.getElementById('eventDetailsBody');
    if (known) renderEventDetails(withMyRsvp(known));
    else body.replaceChildren(h('p', { className: 'settings-note', text: 'Loading…' }));
    document.getElementById('eventDetailsModal').style.display = 'flex';
    document.getElementById('closeEventDetails').focus();

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.EVENT(eventId));
        if (detailsEventId !== eventId) return;
        if (response.success) {
            applyEventUpdate(response.data);
            renderEventDetails(withMyRsvp(response.data));
        } else if (!known) {
            body.replaceChildren(h('p', { className: 'settings-status error', text: response.message || 'Could not load the event' }));
        }
    } catch (error) {
        if (!known && detailsEventId === eventId) {
            body.replaceChildren(h('p', { className: 'settings-status error', text: 'Could not load the event' }));
        }
    }
}

function closeEventDetails() {
    document.getElementById('eventDetailsModal').style.display = 'none';
    detailsEventId = null;
}

async function cancelEvent(event) {
    if (!confirm(`Cancel "${event.title}"? Everyone in the chat will be told.`)) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.EVENT_CANCEL(event.id), { method: 'POST' });
        if (response.success) applyEventUpdate(response.data);
        else showNotification(firstError(response, 'Could not cancel the event'), 'error');
    } catch (error) {
        showNotification('Could not cancel the event', 'error');
    }
}

/* ===== Create / edit dialog ===== */

function nextFullHour(now = new Date()) {
    const date = new Date(now.getTime() + 60 * 60 * 1000);
    date.setMinutes(0, 0, 0);
    return date;
}

/**
 * @param {Object|null} event - the event to edit, or null for a new one in the open chat
 */
function openEventForm(event = null) {
    if (!event) {
        if (!currentChatId) return;
        if (typeof FriChat.canPostInCurrentChat === 'function' && !FriChat.canPostInCurrentChat()) {
            showNotification('Only admins can send messages in this group', 'error');
            return;
        }
    }
    editingEvent = event;
    document.getElementById('eventModalTitle').textContent = event ? 'Edit event' : 'New event';
    document.getElementById('eventSubmitBtn').textContent = event ? 'Save changes' : 'Create event';

    const start = event ? new Date(event.startsAt) : nextFullHour();
    const end = event ? new Date(event.endsAt) : new Date(start.getTime() + 60 * 60 * 1000);
    document.getElementById('eventTitle').value = event ? event.title : '';
    document.getElementById('eventDescription').value = event ? (event.description || '') : '';
    document.getElementById('eventLocation').value = event ? (event.location || '') : '';
    const startInput = document.getElementById('eventStart');
    startInput.min = FriChat.toDateTimeLocalValue(new Date());
    startInput.value = FriChat.toDateTimeLocalValue(start);
    document.getElementById('eventEnd').value = FriChat.toDateTimeLocalValue(end);
    document.getElementById('eventZone').textContent = viewerZone();
    const reminders = event ? (event.reminders || []) : ['1h'];
    document.querySelectorAll('#eventModal [data-event-reminder]').forEach((box) => {
        box.checked = reminders.includes(box.dataset.eventReminder);
    });
    FriChat.setPlannerStatus('eventStatus', '');

    document.getElementById('eventModal').style.display = 'flex';
    document.getElementById('eventTitle').focus();
}

function closeEventForm() {
    document.getElementById('eventModal').style.display = 'none';
    editingEvent = null;
}

/**
 * The form's values, checked the way the server checks them
 * @returns {{ ok: true, body } | { ok: false, error }}
 */
function readEventForm(original = null) {
    const title = document.getElementById('eventTitle').value.replace(/\s+/g, ' ').trim();
    if (!title) return { ok: false, error: 'Give the event a title' };
    const start = FriChat.parseDateTimeLocal(document.getElementById('eventStart').value);
    const end = FriChat.parseDateTimeLocal(document.getElementById('eventEnd').value);
    if (!start || !end) return { ok: false, error: 'Pick a start and an end time' };
    if (end.getTime() <= start.getTime()) return { ok: false, error: 'The event must end after it starts' };

    const fields = {
        title,
        description: document.getElementById('eventDescription').value.trim() || null,
        location: document.getElementById('eventLocation').value.replace(/\s+/g, ' ').trim() || null,
        reminders: [...document.querySelectorAll('#eventModal [data-event-reminder]')]
            .filter(box => box.checked)
            .map(box => box.dataset.eventReminder)
    };
    const startsAt = start.toISOString();
    const endsAt = end.toISOString();

    if (!original) {
        if (start.getTime() <= Date.now()) return { ok: false, error: 'Pick a start time in the future' };
        return { ok: true, body: { ...fields, startsAt, endsAt, timezone: viewerZone() } };
    }

    // An edit sends only what changed (a minute's difference counts as unchanged)
    const body = {};
    for (const key of ['title', 'description', 'location']) {
        if ((fields[key] || null) !== (original[key] || null)) body[key] = fields[key];
    }
    if ([...fields.reminders].sort().join() !== [...(original.reminders || [])].sort().join()) body.reminders = fields.reminders;
    const moved = (iso, date) => Math.abs(Date.parse(iso) - date.getTime()) >= 60 * 1000;
    if (moved(original.startsAt, start)) {
        if (start.getTime() <= Date.now()) return { ok: false, error: 'Pick a start time in the future' };
        body.startsAt = startsAt;
    }
    if (moved(original.endsAt, end)) body.endsAt = endsAt;
    if (body.startsAt || body.endsAt) body.timezone = viewerZone();
    return { ok: true, body };
}

async function submitEventForm() {
    const original = editingEvent;
    const form = readEventForm(original);
    if (!form.ok) {
        FriChat.setPlannerStatus('eventStatus', form.error, true);
        return;
    }
    if (original && Object.keys(form.body).length === 0) {
        closeEventForm();
        return;
    }

    const button = document.getElementById('eventSubmitBtn');
    button.disabled = true;
    try {
        const response = original
            ? await apiRequest(CONFIG.ENDPOINTS.EVENT(original.id), { method: 'PATCH', body: JSON.stringify(form.body) })
            : await apiRequest(CONFIG.ENDPOINTS.EVENTS, { method: 'POST', body: JSON.stringify({ chatId: currentChatId, ...form.body }) });
        if (!response.success) {
            FriChat.setPlannerStatus('eventStatus', firstError(response, 'Could not save the event'), true);
            return;
        }
        closeEventForm();
        if (original) {
            applyEventUpdate(response.data);
        } else if (response.data) {
            // Usually new_message got here first; this covers a disconnected socket
            if (response.data.chat_id === currentChatId) addMessageToUI(response.data);
            if (response.data.event) applyEventUpdate(response.data.event);
        }
    } catch (error) {
        FriChat.setPlannerStatus('eventStatus', 'Could not save the event', true);
    } finally {
        button.disabled = false;
    }
}

/* ===== Event rows (chat info section and "My events") ===== */

function chatLabel(chatId) {
    const chat = typeof allChats !== 'undefined' ? allChats.find(c => c.id === chatId) : null;
    return chat ? getChatDisplayName(chat) : 'A chat';
}

function eventRow(event, { showChat = false } = {}) {
    const mine = deriveMyRsvp(event);
    const choice = RSVP_CHOICES.find(c => c.key === mine);
    const state = stateLabel(event);
    return h('li', { className: 'event-row' },
        h('button', {
            className: `event-row-btn ${event.status === 'cancelled' ? 'cancelled' : ''}`,
            attrs: { type: 'button', 'aria-haspopup': 'dialog' },
            on: { click: () => openEventDetails(event.id) }
        },
        h('span', { className: 'event-row-title', text: event.title }),
        h('span', { className: 'event-row-when', text: [formatEventRange(event), showChat ? chatLabel(event.chatId) : null].filter(Boolean).join(' · ') }),
        h('span', { className: 'event-row-meta' },
            h('span', { text: countsText(event) }),
            choice ? h('span', { className: `event-badge ${choice.key}`, text: `You: ${choice.label}` }) : null,
            state ? h('span', { className: `event-badge state ${event.status === 'cancelled' ? 'cancelled' : ''}`, text: state }) : null
        ))
    );
}

/* ===== "Events & lists" section in chat info ===== */

function resetPlansSection() {
    plansSection = null;
}

/**
 * The section for chat info (group info, a direct chat's profile card, or the "Events & lists"
 * dialog). While it stays open for the same chat the same element is returned, so re-renders
 * around it keep its state.
 */
function renderPlansSection(chatId) {
    if (plansSection && plansSection.chatId === chatId) return plansSection.element;

    const tabs = [{ id: 'events', label: 'Events' }, { id: 'lists', label: 'Lists' }];
    const element = h('section', { className: 'chat-info-section plans-section' },
        h('h4', { text: 'Events & lists' }),
        h('div', { className: 'shared-media-tabs', attrs: { role: 'tablist', 'aria-label': 'Events and lists' } },
            tabs.map(tab => h('button', {
                className: 'shared-media-tab',
                text: tab.label,
                attrs: { type: 'button', role: 'tab', id: `plansTab-${tab.id}`, 'aria-controls': 'plansPanel', 'data-plans-tab': tab.id },
                on: { click: () => selectPlansTab(tab.id) }
            }))
        ),
        h('div', { className: 'plans-panel', attrs: { id: 'plansPanel', role: 'tabpanel' } })
    );

    plansSection = { chatId, element, tab: 'events', events: null, past: null, showPast: false, loading: false };
    selectPlansTab('events');
    return element;
}

function selectPlansTab(tabId) {
    if (!plansSection) return;
    plansSection.tab = tabId;
    plansSection.element.querySelectorAll('[data-plans-tab]').forEach((button) => {
        const selected = button.dataset.plansTab === tabId;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    const panel = plansSection.element.querySelector('.plans-panel');
    panel.setAttribute('aria-labelledby', `plansTab-${tabId}`);
    if (tabId === 'lists') {
        if (typeof FriChat.renderListsPanel === 'function') FriChat.renderListsPanel(panel, plansSection.chatId);
        return;
    }
    if (plansSection.events === null) loadPlansEvents();
    else renderPlansEvents();
}

async function loadPlansEvents() {
    const state = plansSection;
    if (!state || state.loading) return;
    state.loading = true;
    renderPlansEvents();
    try {
        const [upcoming, past] = await Promise.all([
            apiRequest(`${CONFIG.ENDPOINTS.EVENTS}?chatId=${state.chatId}&scope=upcoming`),
            apiRequest(`${CONFIG.ENDPOINTS.EVENTS}?chatId=${state.chatId}&scope=past`)
        ]);
        if (plansSection !== state) return;
        state.events = upcoming.success ? upcoming.data.map(withMyRsvp) : [];
        state.past = past.success ? past.data.map(withMyRsvp) : [];
        state.error = upcoming.success ? null : (upcoming.message || 'Could not load events');
    } catch (error) {
        state.error = 'Could not load events';
        state.events = state.events || [];
    } finally {
        state.loading = false;
        if (plansSection === state && state.tab === 'events') renderPlansEvents();
    }
}

function renderPlansEvents() {
    if (!plansSection || plansSection.tab !== 'events') return;
    const panel = plansSection.element.querySelector('.plans-panel');
    const state = plansSection;
    const isCurrentChat = state.chatId === currentChatId;

    let content;
    if (state.loading && state.events === null) {
        content = h('p', { className: 'settings-note', text: 'Loading…' });
    } else if (state.error) {
        content = h('p', { className: 'settings-status error', text: state.error });
    } else {
        const upcoming = (state.events || []).filter(e => !e.ended);
        content = h('div', {},
            upcoming.length === 0
                ? h('p', { className: 'shared-media-empty', text: 'No upcoming events' })
                : h('ul', { className: 'event-rows' }, upcoming.map(e => eventRow(e))),
            (state.past || []).length > 0
                ? h('button', {
                    className: 'poll-link',
                    text: state.showPast ? 'Hide past events' : `Past events (${state.past.length})`,
                    attrs: { type: 'button', 'aria-expanded': state.showPast ? 'true' : 'false' },
                    on: { click: () => { state.showPast = !state.showPast; renderPlansEvents(); } }
                })
                : null,
            state.showPast ? h('ul', { className: 'event-rows past' }, state.past.map(e => eventRow(e))) : null
        );
    }

    panel.replaceChildren(
        isCurrentChat
            ? h('button', { className: 'btn btn-primary btn-small plans-new-btn', text: '+ New event', attrs: { type: 'button' }, on: { click: () => openEventForm() } })
            : null,
        content
    );
}

function openChatPlans(tab = 'events') {
    if (!currentChatId) return;
    resetPlansSection();
    const body = document.getElementById('chatPlansBody');
    body.replaceChildren(renderPlansSection(currentChatId));
    selectPlansTab(tab);
    document.getElementById('chatPlansModal').style.display = 'flex';
    document.getElementById('closeChatPlans').focus();
}

function closeChatPlans() {
    document.getElementById('chatPlansModal').style.display = 'none';
}

/* ===== "My events" ===== */

async function loadMyEvents() {
    myEvents.loading = true;
    renderMyEvents();
    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.EVENTS}?scope=${myEvents.scope}`);
        myEvents.items = response.success ? response.data.map(withMyRsvp) : [];
        myEvents.error = response.success ? null : (response.message || 'Could not load your events');
    } catch (error) {
        myEvents.error = 'Could not load your events';
    } finally {
        myEvents.loading = false;
        renderMyEvents();
    }
}

function renderMyEvents() {
    const list = document.getElementById('myEventsList');
    if (!list) return;
    document.querySelectorAll('#myEventsModal [data-my-events-scope]').forEach((tab) => {
        const selected = tab.dataset.myEventsScope === myEvents.scope;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    });

    if (myEvents.loading && myEvents.items.length === 0) {
        list.replaceChildren(h('p', { className: 'settings-note', text: 'Loading…' }));
        return;
    }
    if (myEvents.error) {
        list.replaceChildren(h('p', { className: 'settings-status error', text: myEvents.error }));
        return;
    }
    const items = myEvents.items.filter(e => myEvents.filter === 'all' || deriveMyRsvp(e) === myEvents.filter);
    if (items.length === 0) {
        list.replaceChildren(h('p', { className: 'shared-media-empty', text: myEvents.scope === 'past' ? 'No past events' : 'Nothing planned yet' }));
        return;
    }

    // Grouped by day in the viewer's timezone
    const groups = [];
    for (const event of items) {
        const label = formatDay(new Date(event.startsAt));
        let group = groups[groups.length - 1];
        if (!group || group.label !== label) {
            group = { label, events: [] };
            groups.push(group);
        }
        group.events.push(event);
    }
    list.replaceChildren(...groups.map(group => h('section', { className: 'my-events-day' },
        h('h4', { className: 'my-events-day-label', text: group.label }),
        h('ul', { className: 'event-rows' }, group.events.map(e => eventRow(e, { showChat: true })))
    )));
}

function openMyEvents() {
    document.getElementById('myEventsModal').style.display = 'flex';
    document.getElementById('myEventsZone').textContent = viewerZone();
    document.getElementById('closeMyEvents').focus();
    loadMyEvents();
}

function closeMyEvents() {
    document.getElementById('myEventsModal').style.display = 'none';
}

function closeAllEventDialogs() {
    closeEventDetails();
    closeMyEvents();
    closeChatPlans();
    const chatInfo = document.getElementById('chatInfoModal');
    if (chatInfo) chatInfo.style.display = 'none';
    const profileCard = document.getElementById('profileCardModal');
    if (profileCard) profileCard.style.display = 'none';
}

/* ===== Notices in the thread ("event updated", "list created") ===== */

const PLAN_NOTICE = /^(event_updated|event_cancelled|list_created):(\d+)(?::([a-z,]+))?$/;
const FIELD_WORDS = { title: 'name', time: 'time', location: 'place', description: 'details' };

function isPlanNotice(message) {
    return !!message && message.message_type === 'system' && PLAN_NOTICE.test(String(message.content || ''));
}

/**
 * Plain text of an event/list notice (callers escape it)
 */
function describePlanNotice(message) {
    const match = PLAN_NOTICE.exec(String(message.content || ''));
    if (!match) return '';
    const isMe = Number(message.sender_id) === myUserId();
    const actor = isMe ? 'You' : (message.full_name || message.username || 'Someone');

    if (match[1] === 'list_created') {
        const name = message.list_ref ? `the list “${message.list_ref.name}”` : 'a list';
        return `${actor} created ${name}`;
    }
    const title = message.event_ref ? `“${message.event_ref.title}”` : 'an event';
    if (match[1] === 'event_cancelled') return `${actor} cancelled ${title}`;

    const words = (match[3] || '').split(',').map(f => FIELD_WORDS[f]).filter(Boolean);
    if (words.length === 0) return `${actor} updated ${title}`;
    const joined = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
    return `${actor} changed the ${joined} of ${title}`;
}

/**
 * What opens when a notice is clicked: { kind: 'event' | 'list', id } (only while it still exists)
 */
function planNoticeTarget(message) {
    const match = PLAN_NOTICE.exec(String(message && message.content || ''));
    if (!match) return null;
    if (match[1] === 'list_created') return message.list_ref ? { kind: 'list', id: Number(match[2]) } : null;
    return message.event_ref ? { kind: 'event', id: Number(match[2]) } : null;
}

function planNoticeIconHtml(message) {
    return /^list_created:/.test(String(message.content || ''))
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
}

/* ===== Birthday banner (groups) ===== */

function localDateString(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function birthdayKey(kind, chatId, date, userId = '') {
    return `birthday:${kind}:${myUserId()}:${chatId}:${date}${userId ? `:${userId}` : ''}`;
}

function readFlag(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
}

function writeFlag(key) {
    try { localStorage.setItem(key, '1'); } catch (e) { /* only a convenience */ }
}

function resetPlanChatState() {
    birthdayState = null;
    const bar = document.getElementById('birthdayBar');
    if (bar) bar.hidden = true;
}

/**
 * The open chat's details arrived (chat.js): look for birthdays today in groups
 */
async function applyPlanChatState(chat) {
    if (!chat || chat.chat_type !== 'group') return;
    const chatId = chat.id;
    const date = localDateString();
    if (birthdayState && birthdayState.chatId === chatId && birthdayState.date === date) return;
    birthdayState = { chatId, date, people: [] };
    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.CHAT_BIRTHDAYS(chatId)}?date=${date}`);
        if (!birthdayState || birthdayState.chatId !== chatId || currentChatId !== chatId) return;
        birthdayState.people = response.success ? response.data : [];
        renderBirthdayBar();
    } catch (error) {
        // The banner is a nicety; the chat works without it
    }
}

function renderBirthdayBar() {
    const bar = document.getElementById('birthdayBar');
    if (!bar || !birthdayState) return;
    const { chatId, date, people } = birthdayState;
    if (people.length === 0 || readFlag(birthdayKey('dismissed', chatId, date))) {
        bar.hidden = true;
        return;
    }

    const self = people.find(p => p.isSelf);
    const others = people.filter(p => !p.isSelf);
    const names = others.map(p => p.name);
    const text = [
        self ? 'Happy birthday to you! 🎉' : null,
        names.length ? `🎂 It's ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}'s birthday today` : null
    ].filter(Boolean).join(' ');

    const wishButtons = others.slice(0, 3)
        .filter(person => !readFlag(birthdayKey('wished', chatId, date, person.userId)))
        .map(person => h('button', {
            className: 'btn btn-primary btn-small',
            text: others.length === 1 ? 'Wish happy birthday' : `Wish ${person.name}`,
            attrs: { type: 'button' },
            on: { click: (e) => wishHappyBirthday(person, e.currentTarget) }
        }));

    bar.replaceChildren(
        h('span', { className: 'birthday-bar-text', text }),
        ...wishButtons,
        h('button', {
            className: 'icon-btn birthday-bar-close',
            text: '×',
            attrs: { type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss birthday banner' },
            on: { click: () => { writeFlag(birthdayKey('dismissed', chatId, date)); bar.hidden = true; } }
        })
    );
    bar.hidden = false;
}

/**
 * Quick message to the group with an @mention (the normal send path, so every send rule applies)
 */
async function wishHappyBirthday(person, button) {
    if (!birthdayState) return;
    const { chatId, date } = birthdayState;
    if (button) button.disabled = true;
    const result = await sendTextMessage(chatId, `Happy birthday @${person.username}! 🎂🎉`);
    if (result && result.success) {
        writeFlag(birthdayKey('wished', chatId, date, person.userId));
        renderBirthdayBar();
    } else {
        if (button) button.disabled = false;
        showNotification((result && result.message) || 'Could not send your wishes', 'error');
    }
}

/* ===== Live events and setup ===== */

function handlePlanEvent(event, data) {
    if (event === 'event_updated') {
        applyEventUpdate(data);
    } else if (event === 'event_reminder') {
        showNotification(`📅 ${data.text || 'Event reminder'}`, 'info');
        if (data.event) applyEventUpdate(data.event);
    } else if (event === 'list_item_due') {
        showNotification(`✅ Due in "${data.listName || 'a list'}": ${data.text || ''}`, 'info');
    }
}

function initializeEvents() {
    // Event dialog
    document.getElementById('closeEventModal').addEventListener('click', closeEventForm);
    document.getElementById('cancelEventModal').addEventListener('click', closeEventForm);
    document.getElementById('eventSubmitBtn').addEventListener('click', submitEventForm);
    document.getElementById('eventTitle').maxLength = CONFIG.EVENT_TITLE_MAX_LENGTH;
    document.getElementById('eventDescription').maxLength = CONFIG.EVENT_DESCRIPTION_MAX_LENGTH;
    document.getElementById('eventLocation').maxLength = CONFIG.EVENT_LOCATION_MAX_LENGTH;
    // Moving the start keeps the length; an end before the start follows it
    let lastStart = null;
    const startInput = document.getElementById('eventStart');
    startInput.addEventListener('focus', () => { lastStart = FriChat.parseDateTimeLocal(startInput.value); });
    startInput.addEventListener('change', () => {
        const start = FriChat.parseDateTimeLocal(startInput.value);
        const endInput = document.getElementById('eventEnd');
        const end = FriChat.parseDateTimeLocal(endInput.value);
        if (!start) return;
        const length = lastStart && end ? Math.max(end - lastStart, 15 * 60 * 1000) : 60 * 60 * 1000;
        if (!end || end <= start || lastStart) endInput.value = FriChat.toDateTimeLocalValue(new Date(start.getTime() + length));
        lastStart = start;
    });

    // Details, "My events" and "Events & lists" dialogs: close button, backdrop click or Esc
    const dialogs = [
        ['eventDetailsModal', 'closeEventDetails', closeEventDetails],
        ['myEventsModal', 'closeMyEvents', closeMyEvents],
        ['chatPlansModal', 'closeChatPlans', closeChatPlans],
        ['eventModal', null, closeEventForm]
    ];
    for (const [modalId, closeId, close] of dialogs) {
        const modal = document.getElementById(modalId);
        if (closeId) document.getElementById(closeId).addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    }
    // Captured, so Esc closes only the top-most dialog and not group info / a profile card under it
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // The top-most one first (they're stacked in this order; the list dialog is above them all)
        if (isOpen('listModal')) return;
        const open = ['eventModal', 'eventDetailsModal', 'chatPlansModal', 'myEventsModal'].find(isOpen);
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        dialogs.find(d => d[0] === open)[2]();
    }, true);

    document.getElementById('myEventsBtn').addEventListener('click', openMyEvents);
    document.querySelectorAll('#myEventsModal [data-my-events-scope]').forEach((tab) => {
        tab.addEventListener('click', () => {
            myEvents.scope = tab.dataset.myEventsScope;
            myEvents.items = [];
            loadMyEvents();
        });
    });
    document.getElementById('myEventsFilter').addEventListener('change', (e) => {
        myEvents.filter = e.target.value;
        renderMyEvents();
    });

    // Answers, "Details" and "Add to calendar" on cards, and clickable notices. Delegated on the
    // container, which is never replaced, so it works for history, live messages and re-renders.
    const container = document.getElementById('messagesContainer');
    container.addEventListener('click', (e) => {
        const rsvp = e.target.closest('[data-event-rsvp]');
        if (rsvp && !rsvp.disabled) {
            answerEvent(parseInt(rsvp.dataset.eventId), rsvp.dataset.eventRsvp);
            return;
        }
        const open = e.target.closest('[data-event-open]');
        if (open) {
            openEventDetails(parseInt(open.dataset.eventOpen));
            return;
        }
        const ics = e.target.closest('[data-event-ics]');
        if (ics) {
            downloadEventIcs(parseInt(ics.dataset.eventIcs));
            return;
        }
        const notice = e.target.closest('[data-plan-kind]');
        if (notice) openPlanTarget(notice.dataset.planKind, parseInt(notice.dataset.planId));
    });
    container.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const notice = e.target.closest && e.target.closest('[data-plan-kind]');
        if (!notice) return;
        e.preventDefault();
        openPlanTarget(notice.dataset.planKind, parseInt(notice.dataset.planId));
    });

    onPlanEvent(handlePlanEvent);

    // A new event card (any chat): the open "Events & lists" section and My events pick it up
    onNewMessage((message) => {
        if (message && message.message_type === 'event' && message.event) applyEventUpdate(message.event);
    });

    // A refused answer (cancelled event, rate limit) un-dims the card right away
    onSocketError((data) => {
        if (data.event === 'event_rsvp' && data.eventId) {
            const eventId = parseInt(data.eventId);
            if (pendingRsvp.delete(eventId)) rerenderEventCards(eventId);
        }
    });

    // Cards say "Happening now" / "Ended" on their own as time passes
    setInterval(() => {
        if (!currentMessages.some(m => m.event)) return;
        const now = Date.now();
        for (const message of currentMessages) {
            const event = message.event;
            if (!event) continue;
            const started = Date.parse(event.startsAt) <= now;
            const ended = Date.parse(event.endsAt) <= now;
            if (started !== !!event.started || ended !== !!event.ended) {
                message.event = { ...event, started, ended };
                rerenderEventCards(event.id);
            }
        }
    }, 60 * 1000);
}

function openPlanTarget(kind, id) {
    if (!id) return;
    if (kind === 'event') openEventDetails(id);
    else if (kind === 'list' && typeof FriChat.openListModal === 'function') FriChat.openListModal(id);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    renderEventCardHtml,
    isPlanNotice,
    describePlanNotice,
    planNoticeTarget,
    planNoticeIconHtml,
    renderPlansSection,
    resetPlansSection,
    openChatPlans,
    openEventForm,
    openEventDetails,
    resetPlanChatState,
    applyPlanChatState,
    initializeEvents
});
})(globalThis.FriChat = globalThis.FriChat || {});
