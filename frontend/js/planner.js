/**
 * Scheduled messages and "Remind me" (phase 8).
 *
 * Times: the user picks a local date and time (their browser's timezone); it goes to the server as
 * an ISO instant (toISOString, always UTC), and every time the server sends back is a UTC ISO
 * string shown here with the browser's own timezone. So a message scheduled for 09:00 in Berlin
 * shows as 09:00 in Berlin and 08:00 in London.
 *
 * Everything user-written is put on the page with textContent (never innerHTML).
 */

(function (FriChat) {

// The user's pending/failed scheduled messages and pending/fired reminders (kept in step by socket events)
let scheduledItems = [];
let reminderItems = [];
let reminderTargetMessageId = null;
let plannerTab = 'scheduled';

const TONIGHT_HOUR = 20;
const MORNING_HOUR = 9;

/* ===== Time helpers ===== */

function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * Local "YYYY-MM-DDTHH:MM" for <input type="datetime-local">
 */
function toDateTimeLocalValue(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * <input type="datetime-local"> value -> Date in the browser's timezone (null if empty/invalid)
 */
function parseDateTimeLocal(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
    if (!match) return null;
    const [, y, mo, d, h, mi] = match.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Quick choices in the user's own timezone. "Tonight" (20:00) is offered until 19:30.
 * @returns {Array<{ key, label, at: Date }>}
 */
function plannerPresets(now = new Date()) {
    const presets = [{ key: 'hour', label: 'In 1 hour', at: new Date(now.getTime() + 60 * 60 * 1000) }];

    const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), TONIGHT_HOUR, 0, 0, 0);
    if (tonight.getTime() - now.getTime() >= 30 * 60 * 1000) {
        presets.push({ key: 'tonight', label: `Tonight (${formatClock(tonight)})`, at: tonight });
    }

    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, MORNING_HOUR, 0, 0, 0);
    presets.push({ key: 'tomorrow', label: `Tomorrow (${formatClock(tomorrow)})`, at: tomorrow });
    return presets;
}

function formatClock(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * "Today 18:30", "Tomorrow 09:00", "Fri 7 Nov, 18:30" (next year: with the year) in the viewer's timezone
 */
function formatPlannerTime(iso, now = new Date()) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000));
    const clock = formatClock(date);
    if (dayDiff === 0) return `today ${clock}`;
    if (dayDiff === 1) return `tomorrow ${clock}`;
    if (dayDiff === -1) return `yesterday ${clock}`;
    const options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return `${date.toLocaleDateString([], options)}, ${clock}`;
}

function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function plannerTimezoneLabel() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time';
    } catch (e) {
        return 'your local time';
    }
}

function setPlannerStatus(id, text, isError = false) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = text || '';
    element.classList.toggle('error', !!isError);
}

function chatNameFor(chatId) {
    const chat = typeof allChats !== 'undefined' ? allChats.find(c => c.id === chatId) : null;
    return chat ? getChatDisplayName(chat) : 'A chat you left';
}

function plannerEl(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
}

function plannerButton(label, className, onClick) {
    const button = plannerEl('button', `btn ${className} btn-small`, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
}

/**
 * Fill a row of quick-choice buttons that set a datetime-local input
 */
function renderPresetButtons(containerId, inputId) {
    const container = document.getElementById(containerId);
    container.replaceChildren();
    for (const preset of plannerPresets()) {
        const button = plannerEl('button', 'planner-chip', preset.label);
        button.type = 'button';
        button.addEventListener('click', () => {
            const input = document.getElementById(inputId);
            input.value = toDateTimeLocalValue(preset.at);
            input.dispatchEvent(new Event('input'));
            container.querySelectorAll('.planner-chip').forEach(b => b.classList.toggle('active', b === button));
        });
        container.appendChild(button);
    }
}

/**
 * The picked time as an ISO instant, or an error message
 */
function readPickedTime(inputId) {
    const picked = parseDateTimeLocal(document.getElementById(inputId).value);
    if (!picked) return { ok: false, error: 'Pick a date and time' };
    if (picked.getTime() <= Date.now()) return { ok: false, error: 'Pick a time in the future' };
    return { ok: true, iso: picked.toISOString(), date: picked };
}

function firstError(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors[0]) return response.errors[0].msg;
    return (response && response.message) || fallback;
}

/* ===== Schedule send (composer) ===== */

function openScheduleModal() {
    if (!currentChatId) return;
    if (typeof FriChat.canPostInCurrentChat === 'function' && !FriChat.canPostInCurrentChat()) {
        showNotification('Only admins can send messages in this group', 'error');
        return;
    }
    if (isEditingMessage()) {
        showNotification('Finish editing the message first', 'error');
        return;
    }
    const text = document.getElementById('messageInput').value.trim();
    if (!text) {
        showNotification('Type the message you want to schedule first', 'error');
        return;
    }
    if (FriChat.hasPendingUploads()) {
        showNotification('Attachments can\'t be scheduled. Send or remove them first.', 'error');
        return;
    }

    document.getElementById('schedulePreview').textContent = text;
    document.getElementById('scheduleZone').textContent = plannerTimezoneLabel();
    const input = document.getElementById('scheduleAt');
    input.min = toDateTimeLocalValue(new Date());
    input.value = toDateTimeLocalValue(plannerPresets()[0].at);
    renderPresetButtons('schedulePresets', 'scheduleAt');
    setPlannerStatus('scheduleStatus', '');
    document.getElementById('scheduleModal').style.display = 'flex';
}

function closeScheduleModal() {
    document.getElementById('scheduleModal').style.display = 'none';
}

async function submitSchedule() {
    const picked = readPickedTime('scheduleAt');
    if (!picked.ok) {
        setPlannerStatus('scheduleStatus', picked.error, true);
        return;
    }
    const messageInput = document.getElementById('messageInput');
    const content = messageInput.value.trim();
    if (!content) {
        setPlannerStatus('scheduleStatus', 'The message is empty', true);
        return;
    }

    const button = document.getElementById('scheduleSubmitBtn');
    button.disabled = true;
    try {
        const chatId = currentChatId;
        const response = await apiRequest(CONFIG.ENDPOINTS.SCHEDULED_MESSAGES, {
            method: 'POST',
            body: JSON.stringify({ chatId, content, sendAt: picked.iso, replyToMessageId: getReplyTargetId() })
        });
        if (!response.success) {
            setPlannerStatus('scheduleStatus', firstError(response, 'Could not schedule the message'), true);
            return;
        }
        closeScheduleModal();
        upsertScheduled(response.data);
        // Same as sending: the composer, its draft and the reply bar are cleared
        messageInput.value = '';
        autoResizeComposer();
        clearComposerContext();
        FriChat.clearDraft(chatId);
        showNotification(`Scheduled for ${formatPlannerTime(response.data.sendAt)}`);
    } catch (error) {
        setPlannerStatus('scheduleStatus', 'Could not schedule the message', true);
    } finally {
        button.disabled = false;
    }
}

/* ===== Scheduled list state ===== */

function upsertScheduled(item) {
    if (!item || !item.id) return;
    const open = ['pending', 'sending', 'failed'].includes(item.status);
    const index = scheduledItems.findIndex(s => s.id === item.id);
    if (!open) {
        if (index !== -1) scheduledItems.splice(index, 1);
    } else if (index === -1) {
        scheduledItems.push(item);
    } else {
        scheduledItems[index] = { ...scheduledItems[index], ...item };
    }
    scheduledItems.sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
    refreshPlannerIndicators();
}

function upsertReminder(item) {
    if (!item || !item.id) return;
    const index = reminderItems.findIndex(r => r.id === item.id);
    const open = item.status === 'pending' || item.status === 'fired';
    if (!open) {
        if (index !== -1) reminderItems.splice(index, 1);
    } else if (index === -1) {
        reminderItems.push(item);
    } else {
        reminderItems[index] = item;
    }
    reminderItems.sort((a, b) => new Date(a.remindAt) - new Date(b.remindAt));
    refreshPlannerIndicators();
}

/**
 * Sidebar badge (fired reminders + failed scheduled messages), the bar above the composer, and the open panel
 */
function refreshPlannerIndicators() {
    const attention = reminderItems.filter(r => r.status === 'fired').length
        + scheduledItems.filter(s => s.status === 'failed').length;
    const badge = document.getElementById('plannerBadge');
    if (badge) {
        badge.textContent = attention > 99 ? '99+' : String(attention);
        badge.hidden = attention === 0;
    }

    const bar = document.getElementById('scheduledBar');
    if (bar) {
        const count = currentChatId ? scheduledItems.filter(s => s.chatId === currentChatId && s.status !== 'failed').length : 0;
        bar.hidden = count === 0;
        document.getElementById('scheduledBarText').textContent = count === 1
            ? '1 scheduled message in this chat'
            : `${count} scheduled messages in this chat`;
    }

    const modal = document.getElementById('plannerModal');
    if (modal && modal.style.display === 'flex') renderPlannerList();
}

async function loadPlannerItems() {
    try {
        const [scheduledResponse, remindersResponse] = await Promise.all([
            apiRequest(CONFIG.ENDPOINTS.SCHEDULED_MESSAGES),
            apiRequest(CONFIG.ENDPOINTS.REMINDERS)
        ]);
        if (scheduledResponse.success) scheduledItems = scheduledResponse.data || [];
        if (remindersResponse.success) reminderItems = remindersResponse.data || [];
        refreshPlannerIndicators();
    } catch (error) {
        console.error('Load scheduled messages and reminders error:', error);
    }
}

/* ===== Panel: scheduled messages and reminders ===== */

function openPlannerModal(tab = plannerTab) {
    plannerTab = tab;
    document.getElementById('plannerModal').style.display = 'flex';
    document.getElementById('plannerZone').textContent = plannerTimezoneLabel();
    renderPlannerList();
    loadPlannerItems();
}

function closePlannerModal() {
    document.getElementById('plannerModal').style.display = 'none';
}

function renderPlannerList() {
    document.querySelectorAll('#plannerModal [data-planner-tab]').forEach((tabButton) => {
        const active = tabButton.dataset.plannerTab === plannerTab;
        tabButton.classList.toggle('active', active);
        tabButton.setAttribute('aria-selected', String(active));
    });

    const list = document.getElementById('plannerList');
    list.replaceChildren();
    const items = plannerTab === 'scheduled' ? scheduledItems : reminderItems;
    if (items.length === 0) {
        list.appendChild(plannerEl('p', 'planner-empty', plannerTab === 'scheduled'
            ? 'No scheduled messages. Type a message and press the clock button next to Send.'
            : 'No reminders. Open a message\'s menu and choose "Remind me".'));
        return;
    }
    for (const item of items) {
        list.appendChild(plannerTab === 'scheduled' ? renderScheduledItem(item) : renderReminderItem(item));
    }
}

function renderScheduledItem(item) {
    const row = plannerEl('div', `planner-item ${item.status === 'failed' ? 'failed' : ''}`);
    const head = plannerEl('div', 'planner-item-head');
    head.append(
        plannerEl('span', 'planner-item-chat', chatNameFor(item.chatId)),
        plannerEl('span', 'planner-item-time', item.status === 'failed'
            ? 'Not sent'
            : (item.status === 'sending' ? 'Sending…' : capitalize(formatPlannerTime(item.sendAt))))
    );
    row.appendChild(head);
    row.appendChild(plannerEl('div', 'planner-item-text', item.content));
    if (item.failureReason) row.appendChild(plannerEl('div', 'planner-item-reason', item.failureReason));

    const actions = plannerEl('div', 'planner-item-actions');
    if (item.status === 'pending' || item.status === 'failed') {
        actions.appendChild(plannerButton(item.status === 'failed' ? 'Reschedule' : 'Edit', 'btn-secondary', () => startScheduledEdit(row, item)));
        actions.appendChild(plannerButton(item.status === 'failed' ? 'Dismiss' : 'Cancel', 'btn-secondary', () => cancelScheduledItem(item)));
    }
    row.appendChild(actions);
    return row;
}

/**
 * Inline editor: text + date/time, Save / Cancel
 */
function startScheduledEdit(row, item) {
    row.replaceChildren();
    row.classList.add('editing');
    const text = plannerEl('textarea', 'planner-edit-text');
    text.value = item.content;
    text.rows = 3;
    text.setAttribute('aria-label', 'Message');
    const time = plannerEl('input', 'planner-edit-time');
    time.type = 'datetime-local';
    time.min = toDateTimeLocalValue(new Date());
    const current = new Date(item.sendAt);
    time.value = toDateTimeLocalValue(current.getTime() > Date.now() ? current : plannerPresets()[0].at);
    time.setAttribute('aria-label', 'Send at');
    const status = plannerEl('p', 'settings-status');
    status.setAttribute('role', 'status');

    const actions = plannerEl('div', 'planner-item-actions');
    actions.append(
        plannerButton('Cancel', 'btn-secondary', () => renderPlannerList()),
        plannerButton('Save', 'btn-primary', async () => {
            const picked = parseDateTimeLocal(time.value);
            if (!picked || picked.getTime() <= Date.now()) {
                status.textContent = 'Pick a time in the future';
                status.classList.add('error');
                return;
            }
            const body = { sendAt: picked.toISOString() };
            if (text.value.trim() !== item.content) body.content = text.value;
            try {
                const response = await apiRequest(CONFIG.ENDPOINTS.SCHEDULED_MESSAGE(item.id), {
                    method: 'PATCH',
                    body: JSON.stringify(body)
                });
                if (response.success) {
                    upsertScheduled(response.data);
                    renderPlannerList();
                } else {
                    status.textContent = firstError(response, 'Could not save');
                    status.classList.add('error');
                }
            } catch (error) {
                status.textContent = 'Could not save';
                status.classList.add('error');
            }
        })
    );
    row.append(text, time, status, actions);
    text.focus();
}

async function cancelScheduledItem(item) {
    if (item.status === 'pending' && !confirm('Cancel this scheduled message? It will not be sent.')) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.SCHEDULED_MESSAGE(item.id), { method: 'DELETE' });
        if (response.success) {
            upsertScheduled({ id: item.id, status: 'cancelled' });
        } else {
            showNotification(response.message || 'Could not cancel', 'error');
            loadPlannerItems();
        }
    } catch (error) {
        showNotification('Could not cancel', 'error');
    }
}

/**
 * One line describing the message a reminder points at
 */
function reminderPreview(reminder) {
    if (!reminder.message) return 'This message is no longer available';
    const message = reminder.message;
    const preview = message.messageType === 'poll'
        ? `📊 ${message.content || 'Poll'}`
        : getMessagePreviewText(message.messageType, message.content, message.fileName);
    const oneLine = String(preview || '').replace(/\s+/g, ' ').trim();
    return `${message.senderName}: ${oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine}`;
}

function renderReminderItem(reminder) {
    const row = plannerEl('div', `planner-item ${reminder.status === 'fired' ? 'due' : ''}`);
    const head = plannerEl('div', 'planner-item-head');
    head.append(
        plannerEl('span', 'planner-item-chat', chatNameFor(reminder.chatId)),
        plannerEl('span', 'planner-item-time', reminder.status === 'fired'
            ? `⏰ ${capitalize(formatPlannerTime(reminder.firedAt || reminder.remindAt))}`
            : capitalize(formatPlannerTime(reminder.remindAt)))
    );
    row.append(head, plannerEl('div', 'planner-item-text', reminderPreview(reminder)));

    const actions = plannerEl('div', 'planner-item-actions');
    if (reminder.available) {
        actions.appendChild(plannerButton('View message', 'btn-secondary', () => {
            closePlannerModal();
            jumpToMessage(reminder.chatId, reminder.messageId);
        }));
    }
    actions.appendChild(plannerButton(reminder.status === 'fired' ? 'Dismiss' : 'Cancel', 'btn-secondary', () => removeReminder(reminder.id)));
    row.appendChild(actions);
    return row;
}

async function removeReminder(reminderId) {
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.REMINDER(reminderId), { method: 'DELETE' });
        if (response.success || response.message === 'Reminder not found') {
            upsertReminder({ id: reminderId, status: 'deleted' });
            const notice = document.querySelector(`#reminderNotices [data-reminder-id="${reminderId}"]`);
            if (notice) notice.remove();
        } else {
            showNotification(response.message || 'Could not remove the reminder', 'error');
        }
    } catch (error) {
        showNotification('Could not remove the reminder', 'error');
    }
}

/* ===== Remind me (message menu) ===== */

function openReminderModal(messageId) {
    closeMessageActionMenus();
    const message = currentMessages.find(m => m.id === messageId);
    if (!message) return;
    reminderTargetMessageId = messageId;

    document.getElementById('reminderZone').textContent = plannerTimezoneLabel();
    document.getElementById('reminderPreview').textContent = reminderPreview({
        message: {
            senderName: message.full_name || message.username,
            messageType: message.message_type,
            content: message.content,
            fileName: message.file_name
        }
    });
    const existing = reminderItems.find(r => r.messageId === messageId && r.status === 'pending');
    setPlannerStatus('reminderStatus', existing ? `You'll be reminded ${formatPlannerTime(existing.remindAt)}. Setting a new time replaces it.` : '');

    const input = document.getElementById('reminderAt');
    input.min = toDateTimeLocalValue(new Date());
    input.value = toDateTimeLocalValue(plannerPresets()[0].at);
    renderPresetButtons('reminderPresets', 'reminderAt');
    document.getElementById('reminderModal').style.display = 'flex';
}

function closeReminderModal() {
    document.getElementById('reminderModal').style.display = 'none';
    reminderTargetMessageId = null;
}

async function submitReminder() {
    const picked = readPickedTime('reminderAt');
    if (!picked.ok) {
        setPlannerStatus('reminderStatus', picked.error, true);
        return;
    }
    const button = document.getElementById('reminderSubmitBtn');
    button.disabled = true;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.REMINDERS, {
            method: 'POST',
            body: JSON.stringify({ messageId: reminderTargetMessageId, remindAt: picked.iso })
        });
        if (!response.success) {
            setPlannerStatus('reminderStatus', firstError(response, 'Could not set the reminder'), true);
            return;
        }
        // The one it replaced (same message) leaves the list
        reminderItems = reminderItems.filter(r => !(r.messageId === response.data.messageId && r.status === 'pending'));
        upsertReminder(response.data);
        closeReminderModal();
        showNotification(`I'll remind you ${formatPlannerTime(response.data.remindAt)}`);
    } catch (error) {
        setPlannerStatus('reminderStatus', 'Could not set the reminder', true);
    } finally {
        button.disabled = false;
    }
}

/**
 * In-app notice when a reminder comes due (stays until dismissed or opened)
 */
function showReminderNotice(reminder) {
    const container = document.getElementById('reminderNotices');
    if (!container || container.querySelector(`[data-reminder-id="${reminder.id}"]`)) return;

    const card = plannerEl('div', 'reminder-notice');
    card.dataset.reminderId = String(reminder.id);
    card.setAttribute('role', 'alert');
    card.append(
        plannerEl('div', 'reminder-notice-title', `⏰ Reminder · ${chatNameFor(reminder.chatId)}`),
        plannerEl('div', 'reminder-notice-text', reminderPreview(reminder))
    );
    const actions = plannerEl('div', 'planner-item-actions');
    actions.append(
        plannerButton('Dismiss', 'btn-secondary', () => removeReminder(reminder.id)),
        plannerButton('View message', 'btn-primary', () => {
            card.remove();
            removeReminder(reminder.id);
            jumpToMessage(reminder.chatId, reminder.messageId);
        })
    );
    card.appendChild(actions);
    container.appendChild(card);
}

/* ===== Wiring ===== */

/**
 * A chat was opened (chat.js): the bar above the composer shows its scheduled messages
 */
function resetPlannerChatState() {
    refreshPlannerIndicators();
}

function handlePlannerEvent(event, data) {
    if (event === 'scheduled_message_updated') {
        const previous = scheduledItems.find(s => s.id === data.id);
        upsertScheduled(data);
        if (data.status === 'failed' && (!previous || previous.status !== 'failed')) {
            showNotification(`Scheduled message to ${chatNameFor(data.chatId)} wasn't sent. ${data.failureReason || ''}`, 'error');
        }
    } else if (event === 'reminder_updated') {
        if (data.status === 'pending') {
            reminderItems = reminderItems.filter(r => !(r.messageId === data.messageId && r.status === 'pending' && r.id !== data.id));
        }
        upsertReminder(data);
        if (data.status === 'deleted') {
            const notice = document.querySelector(`#reminderNotices [data-reminder-id="${data.id}"]`);
            if (notice) notice.remove();
        }
    } else if (event === 'reminder_due') {
        upsertReminder(data);
        showReminderNotice(data);
    }
}

function initializePlanner() {
    document.getElementById('scheduleBtn').addEventListener('click', openScheduleModal);
    document.getElementById('closeScheduleModal').addEventListener('click', closeScheduleModal);
    document.getElementById('cancelSchedule').addEventListener('click', closeScheduleModal);
    document.getElementById('scheduleSubmitBtn').addEventListener('click', submitSchedule);
    document.getElementById('scheduleViewAll').addEventListener('click', () => {
        closeScheduleModal();
        openPlannerModal('scheduled');
    });
    document.getElementById('scheduleAt').addEventListener('input', () => {
        document.querySelectorAll('#schedulePresets .planner-chip').forEach(b => b.classList.remove('active'));
    });

    document.getElementById('plannerBtn').addEventListener('click', () => openPlannerModal(
        reminderItems.some(r => r.status === 'fired') ? 'reminders' : plannerTab
    ));
    document.getElementById('closePlannerModal').addEventListener('click', closePlannerModal);
    document.querySelectorAll('#plannerModal [data-planner-tab]').forEach((tabButton) => {
        tabButton.addEventListener('click', () => {
            plannerTab = tabButton.dataset.plannerTab;
            renderPlannerList();
        });
    });
    document.getElementById('scheduledBarBtn').addEventListener('click', () => openPlannerModal('scheduled'));

    document.getElementById('closeReminderModal').addEventListener('click', closeReminderModal);
    document.getElementById('cancelReminder').addEventListener('click', closeReminderModal);
    document.getElementById('reminderSubmitBtn').addEventListener('click', submitReminder);
    document.getElementById('reminderAt').addEventListener('input', () => {
        document.querySelectorAll('#reminderPresets .planner-chip').forEach(b => b.classList.remove('active'));
    });

    onPlannerEvent(handlePlannerEvent);
    loadPlannerItems();
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    resetPlannerChatState,
    formatPlannerTime,
    plannerEl,
    setPlannerStatus,
    parseDateTimeLocal,
    toDateTimeLocalValue,
    openReminderModal,
    initializePlanner
});
})(globalThis.FriChat = globalThis.FriChat || {});
