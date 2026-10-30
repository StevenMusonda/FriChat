/**
 * Shared lists (phase 12): the Lists tab of "Events & lists" in chat info and the list dialog,
 * where members add, tick, edit and remove items. Changes go over the socket (REST when it's down)
 * and every member's open dialog is replaced by the list_updated the server sends back, so two
 * people ticking at once both end up seeing the same list, with who ticked what.
 *
 * Everything user-written goes in with textContent (FriChat.h), never innerHTML.
 */

(function (FriChat) {

// The Lists tab: { chatId, panel, lists, loading, error }
let listsPanel = null;
// The open list dialog: { listId, list, editingItemId, editDraft, showCompleted }
let openList = null;

function h(...args) {
    return FriChat.h(...args);
}

function myUserId() {
    const user = getCurrentUser();
    return user ? Number(user.userId) : null;
}

function firstError(response, fallback) {
    if (response && Array.isArray(response.errors) && response.errors[0]) return response.errors[0].msg;
    return (response && response.message) || fallback;
}

/**
 * Rename/delete is for the list's creator and group admins (the server checks; this hides the buttons)
 */
function canManageList(list) {
    if (!list) return false;
    if (Number(list.createdBy) === myUserId()) return true;
    const details = FriChat.currentChatDetails;
    return !!details && details.id === list.chatId && details.chat_type === 'group' && details.my_role === 'admin';
}

/* ===== Lists tab ===== */

/**
 * Fill the Lists tab of the "Events & lists" section (events.js calls this when the tab is picked)
 */
function renderListsPanel(panel, chatId) {
    if (!listsPanel || listsPanel.chatId !== chatId) {
        listsPanel = { chatId, panel, lists: null, loading: false, error: null };
    }
    listsPanel.panel = panel;
    if (listsPanel.lists === null) loadLists();
    else drawListsPanel();
}

async function loadLists() {
    const state = listsPanel;
    if (!state || state.loading) return;
    state.loading = true;
    drawListsPanel();
    try {
        const response = await apiRequest(`${CONFIG.ENDPOINTS.LISTS}?chatId=${state.chatId}`);
        if (listsPanel !== state) return;
        state.lists = response.success ? response.data : [];
        state.error = response.success ? null : (response.message || 'Could not load lists');
    } catch (error) {
        state.lists = state.lists || [];
        state.error = 'Could not load lists';
    } finally {
        state.loading = false;
        if (listsPanel === state) drawListsPanel();
    }
}

function drawListsPanel() {
    const state = listsPanel;
    if (!state || !state.panel || !state.panel.isConnected) return;
    // The tab may have been switched back to Events meanwhile
    if (state.panel.getAttribute('aria-labelledby') !== 'plansTab-lists') return;

    // A live update redraws the tab; a name being typed survives it
    const previous = state.panel.querySelector('.list-new-row input');
    const input = h('input', {
        attrs: { type: 'text', maxlength: CONFIG.LIST_NAME_MAX_LENGTH, placeholder: 'New list, e.g. Groceries', 'aria-label': 'New list name', autocomplete: 'off' }
    });
    if (previous) input.value = previous.value;
    const refocus = previous && document.activeElement === previous;
    const create = async () => {
        const name = input.value.replace(/\s+/g, ' ').trim();
        if (!name) { input.focus(); return; }
        input.disabled = true;
        try {
            const response = await apiRequest(CONFIG.ENDPOINTS.LISTS, { method: 'POST', body: JSON.stringify({ chatId: state.chatId, name }) });
            if (response.success) {
                applyListUpdate(response.data);
                openListModal(response.data.id);
            } else {
                showNotification(firstError(response, 'Could not create the list'), 'error');
            }
        } catch (error) {
            showNotification('Could not create the list', 'error');
        } finally {
            input.disabled = false;
        }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    const form = state.chatId === currentChatId
        ? h('div', { className: 'list-new-row' }, input, h('button', { className: 'btn btn-primary btn-small', text: 'Create', attrs: { type: 'button' }, on: { click: create } }))
        : null;

    let content;
    if (state.loading && state.lists === null) {
        content = h('p', { className: 'settings-note', text: 'Loading…' });
    } else if (state.error) {
        content = h('p', { className: 'settings-status error', text: state.error });
    } else if (state.lists.length === 0) {
        content = h('p', { className: 'shared-media-empty', text: 'No lists yet. Start a shopping list or a to-do.' });
    } else {
        content = h('ul', { className: 'event-rows' }, state.lists.map(list => h('li', { className: 'event-row' },
            h('button', {
                className: 'event-row-btn',
                attrs: { type: 'button', 'aria-haspopup': 'dialog' },
                on: { click: () => openListModal(list.id) }
            },
            h('span', { className: 'event-row-title', text: `☑ ${list.name}` }),
            h('span', { className: 'event-row-when', text: `${list.counts.done}/${list.counts.total} done` }))
        )));
    }
    state.panel.replaceChildren(...[form, content].filter(Boolean));
    if (refocus) input.focus();
}

/* ===== List dialog ===== */

async function openListModal(listId) {
    openList = { listId, list: null, editingItemId: null, editDraft: null, showCompleted: true };
    document.getElementById('listModalTitle').textContent = 'List';
    document.getElementById('listItems').replaceChildren(h('p', { className: 'settings-note', text: 'Loading…' }));
    document.getElementById('listAddText').value = '';
    document.getElementById('listAddDue').value = '';
    document.getElementById('listAddDueRow').hidden = true;
    document.getElementById('listModal').style.display = 'flex';
    document.getElementById('listAddText').focus();

    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LIST(listId));
        if (!openList || openList.listId !== listId) return;
        if (response.success) {
            applyListUpdate(response.data);
        } else {
            document.getElementById('listItems').replaceChildren(h('p', { className: 'settings-status error', text: response.message || 'Could not load the list' }));
        }
    } catch (error) {
        document.getElementById('listItems').replaceChildren(h('p', { className: 'settings-status error', text: 'Could not load the list' }));
    }
}

function closeListModal() {
    document.getElementById('listModal').style.display = 'none';
    openList = null;
}

function isListModalOpen() {
    return document.getElementById('listModal').style.display === 'flex';
}

function dueLabel(item) {
    if (!item.dueAt) return null;
    const overdue = !item.done && Date.parse(item.dueAt) <= Date.now();
    return { text: `${overdue ? 'Overdue' : 'Due'} ${FriChat.formatPlannerTime(item.dueAt)}`, overdue };
}

function itemRow(item) {
    const editing = openList && openList.editingItemId === item.id;
    const box = h('input', {
        className: 'list-item-check',
        attrs: { type: 'checkbox', 'aria-label': item.done ? `Mark "${item.text}" as not done` : `Mark "${item.text}" as done` }
    });
    box.checked = item.done;
    box.addEventListener('change', () => sendItemChange(item.id, { done: box.checked }));

    if (editing) {
        const text = h('input', { className: 'list-edit-text', attrs: { type: 'text', maxlength: CONFIG.LIST_ITEM_MAX_LENGTH, 'aria-label': 'Item text' } });
        text.value = openList.editDraft.text;
        text.addEventListener('input', () => { openList.editDraft.text = text.value; });
        const due = h('input', { className: 'list-edit-due', attrs: { type: 'datetime-local', 'aria-label': 'Due date (optional)' } });
        due.value = openList.editDraft.due;
        due.addEventListener('input', () => { openList.editDraft.due = due.value; });
        const save = () => saveItemEdit(item);
        text.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelItemEdit(); }
        });
        setTimeout(() => { if (text.isConnected && document.activeElement !== due) text.focus(); }, 0);
        return h('li', { className: 'list-item editing' },
            h('div', { className: 'list-edit-fields' }, text, due),
            h('div', { className: 'list-edit-actions' },
                h('button', { className: 'btn btn-primary btn-small', text: 'Save', attrs: { type: 'button' }, on: { click: save } }),
                item.dueAt ? h('button', { className: 'btn btn-secondary btn-small', text: 'Clear due date', attrs: { type: 'button' }, on: { click: () => { cancelItemEdit(); sendItemChange(item.id, { dueAt: null }); } } }) : null,
                h('button', { className: 'btn btn-secondary btn-small', text: 'Cancel', attrs: { type: 'button' }, on: { click: cancelItemEdit } })
            )
        );
    }

    const due = dueLabel(item);
    const meta = item.done && item.doneBy
        ? `✓ ${item.doneBy.name}${item.doneAt ? ` · ${FriChat.formatPlannerTime(item.doneAt)}` : ''}`
        : (item.createdBy ? `Added by ${item.createdBy.name}` : null);

    return h('li', { className: `list-item ${item.done ? 'done' : ''}` },
        box,
        h('div', { className: 'list-item-body' },
            h('span', { className: 'list-item-text', text: item.text }),
            h('span', { className: 'list-item-meta' },
                due ? h('span', { className: `list-item-due ${due.overdue ? 'overdue' : ''}`, text: due.text }) : null,
                meta ? h('span', { text: meta }) : null
            )
        ),
        h('button', {
            className: 'icon-btn list-item-action',
            text: '✎',
            attrs: { type: 'button', title: 'Edit', 'aria-label': `Edit "${item.text}"` },
            on: { click: () => startItemEdit(item) }
        }),
        h('button', {
            className: 'icon-btn list-item-action',
            text: '×',
            attrs: { type: 'button', title: 'Remove', 'aria-label': `Remove "${item.text}"` },
            on: { click: () => sendItemRemove(item.id) }
        })
    );
}

function drawListModal() {
    if (!openList || !openList.list) return;
    const list = openList.list;
    document.getElementById('listModalTitle').textContent = list.name;

    const manage = document.getElementById('listManage');
    manage.replaceChildren(...(canManageList(list) ? [
        h('button', { className: 'poll-link', text: 'Rename', attrs: { type: 'button' }, on: { click: () => renameList(list) } }),
        h('button', { className: 'poll-link list-delete-link', text: 'Delete list', attrs: { type: 'button' }, on: { click: () => deleteList(list) } })
    ] : []));

    const open = list.items.filter(i => !i.done);
    const done = list.items.filter(i => i.done);
    const container = document.getElementById('listItems');
    const focusedEdit = document.activeElement && document.activeElement.closest && document.activeElement.closest('.list-item.editing');

    container.replaceChildren(
        open.length === 0
            ? h('p', { className: 'shared-media-empty', text: done.length ? 'All done 🎉' : 'Nothing on this list yet' })
            : h('ul', { className: 'list-items', attrs: { 'aria-label': 'To do' } }, open.map(itemRow)),
        done.length > 0 ? h('div', { className: 'list-completed' },
            h('button', {
                className: 'poll-link list-completed-toggle',
                text: `${openList.showCompleted ? '▾' : '▸'} Completed (${done.length})`,
                attrs: { type: 'button', 'aria-expanded': openList.showCompleted ? 'true' : 'false' },
                on: { click: () => { openList.showCompleted = !openList.showCompleted; drawListModal(); } }
            }),
            openList.showCompleted ? h('ul', { className: 'list-items completed', attrs: { 'aria-label': 'Completed' } }, done.map(itemRow)) : null
        ) : null
    );
    if (focusedEdit) {
        const input = container.querySelector('.list-item.editing .list-edit-text');
        if (input) input.focus();
    }
}

/**
 * list_updated (or a REST answer): the whole list as it now is
 */
function applyListUpdate(list) {
    if (!list || !list.id) return;
    if (listsPanel && listsPanel.chatId === list.chatId && Array.isArray(listsPanel.lists)) {
        const summary = { id: list.id, chatId: list.chatId, name: list.name, createdBy: list.createdBy, createdByName: list.createdByName, counts: list.counts };
        const index = listsPanel.lists.findIndex(l => l.id === list.id);
        if (index >= 0) listsPanel.lists[index] = summary;
        else listsPanel.lists.push(summary);
        drawListsPanel();
    }
    if (openList && openList.listId === list.id && Array.isArray(list.items)) {
        openList.list = list;
        // The item being edited was removed by someone else
        if (openList.editingItemId && !list.items.some(i => i.id === openList.editingItemId)) cancelItemEdit(false);
        drawListModal();
    }
    // Notices in the thread show the list's current name
    for (const message of currentMessages) {
        if (message.list_ref && message.list_ref.id === list.id && message.list_ref.name !== list.name) {
            message.list_ref = { ...message.list_ref, name: list.name };
        }
    }
}

function applyListDeleted(data) {
    const listId = Number(data && data.listId);
    if (!listId) return;
    if (listsPanel && Array.isArray(listsPanel.lists)) {
        listsPanel.lists = listsPanel.lists.filter(l => l.id !== listId);
        drawListsPanel();
    }
    if (openList && openList.listId === listId) {
        closeListModal();
        showNotification('This list was deleted', 'info');
    }
}

/* ===== Changes ===== */

/**
 * Socket first; REST when it's down. The list comes back as list_updated either way.
 */
async function sendListChange(socketEvent, socketData, restUrl, restOptions, fallbackError) {
    if (emitPlanEvent(socketEvent, socketData)) return;
    try {
        const response = await apiRequest(restUrl, restOptions);
        if (response.success) {
            if (response.data) applyListUpdate(response.data);
        } else {
            showNotification(firstError(response, fallbackError), 'error');
            if (openList) drawListModal();
        }
    } catch (error) {
        showNotification(fallbackError, 'error');
        if (openList) drawListModal();
    }
}

function sendItemChange(itemId, changes) {
    sendListChange('list_item_update', { itemId, ...changes }, CONFIG.ENDPOINTS.LIST_ITEM(itemId),
        { method: 'PATCH', body: JSON.stringify(changes) }, 'Could not update the item');
}

function sendItemRemove(itemId) {
    sendListChange('list_item_remove', { itemId }, CONFIG.ENDPOINTS.LIST_ITEM(itemId),
        { method: 'DELETE' }, 'Could not remove the item');
}

function addItemFromForm() {
    if (!openList) return;
    const input = document.getElementById('listAddText');
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (!text) { input.focus(); return; }

    let dueAt;
    if (!document.getElementById('listAddDueRow').hidden && document.getElementById('listAddDue').value) {
        const picked = FriChat.parseDateTimeLocal(document.getElementById('listAddDue').value);
        if (!picked || picked.getTime() <= Date.now()) {
            showNotification('Pick a due time in the future', 'error');
            return;
        }
        dueAt = picked.toISOString();
    }

    const listId = openList.listId;
    sendListChange('list_item_add', { listId, text, dueAt }, CONFIG.ENDPOINTS.LIST_ITEMS(listId),
        { method: 'POST', body: JSON.stringify(dueAt ? { text, dueAt } : { text }) }, 'Could not add the item');
    input.value = '';
    document.getElementById('listAddDue').value = '';
    document.getElementById('listAddDueRow').hidden = true;
    input.focus();
}

function startItemEdit(item) {
    if (!openList) return;
    openList.editingItemId = item.id;
    openList.editDraft = {
        text: item.text,
        due: item.dueAt ? FriChat.toDateTimeLocalValue(new Date(item.dueAt)) : ''
    };
    drawListModal();
}

function cancelItemEdit(redraw = true) {
    if (!openList) return;
    openList.editingItemId = null;
    openList.editDraft = null;
    if (redraw) drawListModal();
}

function saveItemEdit(item) {
    const draft = openList && openList.editDraft;
    if (!draft) return;
    const text = draft.text.replace(/\s+/g, ' ').trim();
    if (!text) {
        showNotification('The item cannot be empty', 'error');
        return;
    }
    const changes = {};
    if (text !== item.text) changes.text = text;
    const originalDue = item.dueAt ? FriChat.toDateTimeLocalValue(new Date(item.dueAt)) : '';
    if (draft.due !== originalDue) {
        if (!draft.due) {
            changes.dueAt = null;
        } else {
            const picked = FriChat.parseDateTimeLocal(draft.due);
            if (!picked || picked.getTime() <= Date.now()) {
                showNotification('Pick a due time in the future', 'error');
                return;
            }
            changes.dueAt = picked.toISOString();
        }
    }
    cancelItemEdit();
    if (Object.keys(changes).length > 0) sendItemChange(item.id, changes);
}

async function renameList(list) {
    const name = prompt('Rename the list', list.name);
    if (name === null) return;
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean || clean === list.name) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LIST(list.id), { method: 'PATCH', body: JSON.stringify({ name: clean }) });
        if (response.success) applyListUpdate(response.data);
        else showNotification(firstError(response, 'Could not rename the list'), 'error');
    } catch (error) {
        showNotification('Could not rename the list', 'error');
    }
}

async function deleteList(list) {
    if (!confirm(`Delete the list "${list.name}" and all its items for everyone?`)) return;
    try {
        const response = await apiRequest(CONFIG.ENDPOINTS.LIST(list.id), { method: 'DELETE' });
        if (response.success) applyListDeleted({ listId: list.id });
        else showNotification(firstError(response, 'Could not delete the list'), 'error');
    } catch (error) {
        showNotification('Could not delete the list', 'error');
    }
}

/* ===== Setup ===== */

function initializeLists() {
    const modal = document.getElementById('listModal');
    document.getElementById('closeListModal').addEventListener('click', closeListModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeListModal(); });
    // Captured, so Esc closes only this dialog and not the chat info / plans dialog under it
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isListModalOpen() && document.getElementById('eventModal').style.display !== 'flex') {
            e.preventDefault();
            e.stopPropagation();
            if (openList && openList.editingItemId) cancelItemEdit();
            else closeListModal();
        }
    }, true);

    const addText = document.getElementById('listAddText');
    addText.maxLength = CONFIG.LIST_ITEM_MAX_LENGTH;
    addText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addItemFromForm(); }
    });
    document.getElementById('listAddBtn').addEventListener('click', addItemFromForm);
    document.getElementById('listAddDueToggle').addEventListener('click', () => {
        const row = document.getElementById('listAddDueRow');
        row.hidden = !row.hidden;
        const due = document.getElementById('listAddDue');
        due.min = FriChat.toDateTimeLocalValue(new Date());
        if (!row.hidden) due.focus();
    });

    onPlanEvent((event, data) => {
        if (event === 'list_updated') applyListUpdate(data);
        else if (event === 'list_deleted') applyListDeleted(data);
    });

    // A refused change (rate limit, removed item): show the list as the server last sent it
    onSocketError((data) => {
        if (/^list_item_/.test(data.event || '') && openList) drawListModal();
    });

    // "Overdue" labels change as time passes
    setInterval(() => { if (openList && isListModalOpen() && !openList.editingItemId) drawListModal(); }, 60 * 1000);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    renderListsPanel,
    openListModal,
    initializeLists
});
})(globalThis.FriChat = globalThis.FriChat || {});
