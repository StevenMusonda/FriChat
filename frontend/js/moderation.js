/**
 * Reporting and warnings (phase 13): the Report dialog for messages and users, with the offer to
 * block at the same time, and the notice a user sees when an admin warns them.
 *
 * Everything user-written goes in with textContent (FriChat.h), never innerHTML.
 */

(function (FriChat) {

const REPORT_REASONS = [
    { value: 'spam', label: 'Spam' },
    { value: 'harassment', label: 'Harassment or bullying' },
    { value: 'inappropriate', label: 'Inappropriate content' },
    { value: 'other', label: 'Something else' }
];
const NOTE_MAX_LENGTH = 500;

// Warnings still to show, oldest first
let pendingWarnings = [];
let warningOpen = false;

function h(...args) {
    return FriChat.h(...args);
}

function buildModal(titleId, title, onClose, body, footer) {
    const modal = h('div', { className: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
        h('div', { className: 'modal-content' },
            h('div', { className: 'modal-header' },
                h('h3', { text: title, attrs: { id: titleId } }),
                onClose ? h('button', { className: 'modal-close', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: onClose } }) : null
            ),
            h('div', { className: 'modal-body' }, body),
            h('div', { className: 'modal-footer' }, footer)
        )
    );
    document.body.appendChild(modal);
    return modal;
}

/**
 * @param {Object} target - { messageId } or { userId, chatId? }, plus name (who it's about)
 */
function openReportModal(target) {
    const close = () => modal.remove();
    const heading = target.messageId ? 'Report message' : `Report ${target.name || 'user'}`;

    const reasons = h('fieldset', { className: 'report-reasons' },
        h('legend', { text: 'What\'s wrong?' }),
        REPORT_REASONS.map((reason, index) => h('label', { className: 'report-reason' },
            h('input', { attrs: { type: 'radio', name: 'reportReason', value: reason.value, checked: index === 0 } }),
            h('span', { text: reason.label })
        ))
    );
    const note = h('textarea', { attrs: { id: 'reportNote', rows: 3, maxlength: NOTE_MAX_LENGTH, placeholder: 'Anything that helps us understand (optional)' } });
    const block = h('input', { attrs: { type: 'checkbox', id: 'reportBlock' } });
    const status = h('p', { className: 'report-status', attrs: { role: 'status' } });

    const submit = h('button', { className: 'btn btn-danger', text: 'Send report', attrs: { type: 'button' } });
    const cancel = h('button', { className: 'btn btn-secondary', text: 'Cancel', attrs: { type: 'button' }, on: { click: close } });

    const body = h('div', { className: 'report-form' },
        h('p', { className: 'report-hint', text: target.messageId
            ? 'The moderators will see this message and the ones around it. The sender isn\'t told who reported them.'
            : 'The moderators will see your report. This person isn\'t told who reported them.' }),
        reasons,
        h('label', { className: 'report-note-label', attrs: { for: 'reportNote' } }, 'Note', note),
        h('label', { className: 'report-block', attrs: { for: 'reportBlock' } }, block,
            h('span', { text: target.name ? `Also block ${target.name}` : 'Also block this person' })),
        status
    );

    submit.addEventListener('click', async () => {
        const chosen = reasons.querySelector('input:checked');
        submit.disabled = true;
        status.textContent = '';
        try {
            const result = await apiRequest(CONFIG.ENDPOINTS.REPORTS, {
                method: 'POST',
                body: JSON.stringify({
                    targetType: target.messageId ? 'message' : 'user',
                    messageId: target.messageId || null,
                    userId: target.userId || null,
                    chatId: target.chatId || null,
                    reason: chosen.value,
                    note: note.value.trim() || null,
                    block: block.checked
                })
            });
            if (!result.success) {
                status.textContent = result.message || 'The report could not be sent.';
                submit.disabled = false;
                return;
            }
            close();
            showNotification(result.message, 'success');
        } catch (error) {
            status.textContent = 'The report could not be sent. Check your connection.';
            submit.disabled = false;
        }
    });

    const modal = buildModal('reportModalTitle', heading, close, body, [cancel, submit]);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
}

function showNextWarning() {
    if (warningOpen || pendingWarnings.length === 0) return;
    const warning = pendingWarnings[0];
    warningOpen = true;

    const understood = h('button', { className: 'btn btn-primary', text: 'I understand', attrs: { type: 'button' } });
    const body = h('div', { className: 'report-form' },
        h('p', { text: 'A moderator reviewed your activity and sent you this warning:' }),
        h('blockquote', { className: 'warning-text', text: warning.message }),
        h('p', { className: 'report-hint', text: 'Further problems can lead to your account being suspended.' })
    );

    understood.addEventListener('click', async () => {
        understood.disabled = true;
        try {
            await apiRequest(CONFIG.ENDPOINTS.REPORT_WARNING_ACK(warning.id), { method: 'POST' });
        } catch (error) {
            // Shown again next time the app opens
        }
        modal.remove();
        pendingWarnings.shift();
        warningOpen = false;
        showNextWarning();
    });

    // No close button: the warning stays until it's acknowledged
    const modal = buildModal('warningModalTitle', 'Account warning', null, body, [understood]);
}

function addWarning(warning) {
    if (!warning || !warning.id || pendingWarnings.some(item => item.id === warning.id)) return;
    pendingWarnings.push(warning);
    showNextWarning();
}

async function initializeModeration() {
    const user = getCurrentUser();
    const adminSection = document.getElementById('adminConsoleSection');
    if (adminSection && user && user.isAdmin) adminSection.hidden = false;

    onAccountEvent((event, data) => {
        if (event === 'account_warning') addWarning(data);
    });

    const result = await apiRequest(CONFIG.ENDPOINTS.REPORT_WARNINGS);
    if (result.success) result.data.forEach(addWarning);
}

// What the other scripts and chat.html use (window.FriChat); everything else stays inside this file
Object.assign(FriChat, {
    openReportModal,
    initializeModeration
});
})(globalThis.FriChat = globalThis.FriChat || {});
