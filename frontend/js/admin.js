/**
 * Admin console (admin.html): Reports, Users and the Audit log.
 * The server decides who may use it: this page shows what /api/admin returns, and a 403 shows
 * "no access". Everything from the server goes in with textContent, never innerHTML: report notes,
 * evidence and usernames are written by the people being moderated.
 */

(function () {
    'use strict';

    const panels = {
        reports: { cursor: null, loaded: false },
        users: { cursor: null, loaded: false },
        audit: { cursor: null, loaded: false }
    };

    const byId = (id) => document.getElementById(id);

    function h(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        if (props.className) node.className = props.className;
        if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
        if (props.attrs) {
            for (const [name, value] of Object.entries(props.attrs)) {
                if (value === false || value === null || value === undefined) continue;
                node.setAttribute(name, value === true ? '' : String(value));
            }
        }
        if (props.on) {
            for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
        }
        for (const child of children.flat()) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }

    function formatTime(value) {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    }

    function setMessage(container, text) {
        container.replaceChildren(h('p', { className: 'empty-state', text }));
    }

    function actionButton(label, className, onClick) {
        return h('button', { className: `btn btn-small ${className}`, text: label, attrs: { type: 'button' }, on: { click: onClick } });
    }

    function badge(text, kind) {
        return h('span', { className: `admin-badge${kind ? ` admin-badge-${kind}` : ''}`, text });
    }

    /**
     * Run a POST action, tell the admin how it went, then redraw
     */
    async function runAction(endpoint, body, statusNode, after) {
        try {
            const result = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify(body || {}) });
            statusNode.textContent = result.message || (result.success ? 'Done' : 'That didn\'t work');
            if (result.success && after) await after();
        } catch (error) {
            statusNode.textContent = 'That didn\'t work. Check your connection.';
        }
    }

    // ===== Reports =====

    async function loadReports({ more = false } = {}) {
        const list = byId('reportList');
        const params = new URLSearchParams();
        const status = byId('reportStatusFilter').value;
        if (status) params.set('status', status);
        if (more && panels.reports.cursor) params.set('before', panels.reports.cursor);

        const result = await apiRequest(`${CONFIG.ENDPOINTS.ADMIN_REPORTS}?${params}`);
        if (!result.success) return setMessage(list, result.message || 'Failed to load reports');

        const rows = result.data.reports.map(renderReportRow);
        if (more) list.append(...rows);
        else if (rows.length > 0) list.replaceChildren(...rows);
        else setMessage(list, 'No reports here.');

        panels.reports.cursor = result.data.nextCursor;
        byId('reportMore').hidden = !result.data.nextCursor;
    }

    function renderReportRow(report) {
        const about = report.reportedUser ? `@${report.reportedUser.username}` : 'deleted account';
        return h('button', { className: 'admin-row', attrs: { type: 'button' }, on: { click: () => openReport(report.id) } },
            h('span', { className: 'admin-row-title', text: `#${report.id} ${report.targetType === 'message' ? 'Message' : 'User'} by ${about}` }),
            h('span', { className: 'admin-row-meta' },
                badge(report.reason), ' ',
                badge(report.status, report.status === 'open' ? 'open' : null), ' ',
                `${report.reporter ? `from @${report.reporter.username}` : 'from a deleted account'} · ${formatTime(report.createdAt)}`
            )
        );
    }

    function renderEvidence(item, report) {
        const download = item.hasFile
            ? actionButton('Download attachment', 'btn-secondary', () => downloadEvidence(report.id, item))
            : null;
        const fileLine = item.fileName
            ? h('p', { className: 'admin-evidence-file', text: `${item.fileName} (${item.fileMime || 'file'})` })
            : null;

        return h('div', { className: `admin-evidence${item.isReported ? ' admin-evidence-reported' : ''}` },
            h('p', { className: 'admin-row-meta', text: `@${item.senderUsername || 'unknown'} · ${formatTime(item.sentAt)}${item.isReported ? ' · reported message' : ''}` }),
            item.content ? h('p', { className: 'admin-evidence-text', text: item.content }) : null,
            !item.content && !item.fileName ? h('p', { className: 'admin-row-meta', text: `(${item.messageType})` }) : null,
            fileLine,
            download
        );
    }

    async function downloadEvidence(reportId, item) {
        const token = await getAccessToken();
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.ADMIN_EVIDENCE_FILE(reportId, item.id)}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            alert('The file could not be downloaded.');
            return;
        }
        const url = URL.createObjectURL(await response.blob());
        const link = h('a', { attrs: { href: url, download: item.fileName || 'evidence' } });
        link.click();
        URL.revokeObjectURL(url);
    }

    async function openReport(reportId) {
        const detail = byId('reportDetail');
        detail.hidden = false;
        setMessage(detail, 'Loading…');

        const result = await apiRequest(CONFIG.ENDPOINTS.ADMIN_REPORT(reportId));
        if (!result.success) return setMessage(detail, result.message || 'Failed to load the report');
        const report = result.data;

        const status = h('p', { className: 'report-status', attrs: { role: 'status' } });
        const text = h('textarea', { attrs: { id: 'reportActionText', rows: 3, maxlength: 500, placeholder: 'Warning to the user, or reason for the suspension' } });
        const refresh = async () => { await openReport(report.id); await loadReports(); };

        const actions = h('div', { className: 'admin-actions' },
            actionButton('Dismiss', 'btn-secondary', () => runAction(CONFIG.ENDPOINTS.ADMIN_REPORT_ACTION(report.id, 'dismiss'), {}, status, refresh)),
            report.reportedUser ? actionButton('Warn', 'btn-secondary', () => {
                if (!text.value.trim()) { status.textContent = 'Write the warning first.'; return; }
                runAction(CONFIG.ENDPOINTS.ADMIN_REPORT_ACTION(report.id, 'warn'), { message: text.value }, status, refresh);
            }) : null,
            report.reportedUser && !report.reportedUser.suspended ? actionButton('Suspend user', 'btn-danger', () => {
                if (!confirm(`Suspend @${report.reportedUser.username}? They are signed out everywhere and can't sign in.`)) return;
                runAction(CONFIG.ENDPOINTS.ADMIN_REPORT_ACTION(report.id, 'suspend'), { reason: text.value.slice(0, 255) }, status, refresh);
            }) : null,
            report.messageId ? actionButton('Delete message', 'btn-danger', () => {
                if (!confirm('Delete this message for everyone? The evidence below is kept.')) return;
                runAction(CONFIG.ENDPOINTS.ADMIN_REPORT_ACTION(report.id, 'delete-message'), {}, status, refresh);
            }) : null
        );

        detail.replaceChildren(
            h('h2', { text: `Report #${report.id}` }),
            h('p', {}, badge(report.reason), ' ', badge(report.status, report.status === 'open' ? 'open' : null),
                report.resolution ? ' ' : null, report.resolution ? badge(report.resolution) : null),
            h('p', { className: 'admin-row-meta', text: `Reported by ${report.reporter ? `@${report.reporter.username}` : 'a deleted account'} on ${formatTime(report.createdAt)}` }),
            report.reportedUser
                ? h('p', { className: 'admin-row-meta', text: `About @${report.reportedUser.username}${report.reportedUser.suspended ? ' (suspended)' : ''}` })
                : null,
            report.note ? h('blockquote', { className: 'warning-text', text: report.note }) : null,
            report.reviewedBy ? h('p', { className: 'admin-row-meta', text: `Last reviewed by @${report.reviewedBy} on ${formatTime(report.reviewedAt)}` }) : null,
            h('h3', { text: 'Evidence' }),
            report.evidence.length > 0
                ? h('div', { className: 'admin-evidence-list' }, report.evidence.map(item => renderEvidence(item, report)))
                : h('p', { className: 'admin-row-meta', text: 'No messages were saved with this report.' }),
            h('h3', { text: 'Action' }),
            h('label', { className: 'report-note-label', attrs: { for: 'reportActionText' } }, 'Message', text),
            actions,
            status
        );
        detail.scrollIntoView({ block: 'start' });
    }

    // ===== Users =====

    async function loadUsers({ more = false } = {}) {
        const list = byId('userList');
        const params = new URLSearchParams();
        const search = byId('userSearch').value.trim();
        const status = byId('userStatusFilter').value;
        if (search) params.set('q', search);
        if (status) params.set('status', status);
        if (more && panels.users.cursor) params.set('before', panels.users.cursor);

        const result = await apiRequest(`${CONFIG.ENDPOINTS.ADMIN_USERS}?${params}`);
        if (!result.success) return setMessage(list, result.message || 'Failed to load users');

        const rows = result.data.users.map(renderUserRow);
        if (more) list.append(...rows);
        else if (rows.length > 0) list.replaceChildren(...rows);
        else setMessage(list, 'No users found.');

        panels.users.cursor = result.data.nextCursor;
        byId('userMore').hidden = !result.data.nextCursor;
    }

    function renderUserRow(user) {
        const status = h('p', { className: 'report-status', attrs: { role: 'status' } });
        const reload = () => loadUsers();

        return h('div', { className: 'admin-row admin-row-static' },
            h('span', { className: 'admin-row-title', text: `@${user.username}${user.fullName ? ` (${user.fullName})` : ''}` }),
            h('span', { className: 'admin-row-meta' },
                user.isAdmin ? badge('admin') : null, user.isAdmin ? ' ' : null,
                user.suspended ? badge('suspended', 'open') : null, user.suspended ? ' ' : null,
                user.openReports > 0 ? badge(`${user.openReports} open report${user.openReports === 1 ? '' : 's'}`) : null,
                user.openReports > 0 ? ' ' : null,
                `${user.email} · joined ${formatTime(user.createdAt)}`
            ),
            user.suspendedReason ? h('span', { className: 'admin-row-meta', text: `Reason: ${user.suspendedReason}` }) : null,
            h('div', { className: 'admin-actions' },
                user.suspended
                    ? actionButton('Unsuspend', 'btn-secondary', () => runAction(CONFIG.ENDPOINTS.ADMIN_USER_ACTION(user.id, 'unsuspend'), {}, status, reload))
                    : !user.isAdmin ? actionButton('Suspend', 'btn-danger', () => {
                        const reason = prompt(`Suspend @${user.username}? Reason (optional):`, '');
                        if (reason === null) return;
                        runAction(CONFIG.ENDPOINTS.ADMIN_USER_ACTION(user.id, 'suspend'), { reason: reason.slice(0, 255) }, status, reload);
                    }) : null,
                actionButton('Force logout', 'btn-secondary', () => {
                    if (confirm(`Sign @${user.username} out of every device?`)) {
                        runAction(CONFIG.ENDPOINTS.ADMIN_USER_ACTION(user.id, 'logout'), {}, status);
                    }
                })
            ),
            status
        );
    }

    // ===== Audit log =====

    async function loadAudit({ more = false } = {}) {
        const list = byId('auditList');
        const params = new URLSearchParams();
        const filters = {
            event: byId('auditEvent').value,
            q: byId('auditSearch').value.trim(),
            actorId: byId('auditActor').value,
            targetId: byId('auditTarget').value,
            ip: byId('auditIp').value.trim(),
            from: byId('auditFrom').value,
            to: byId('auditTo').value
        };
        for (const [name, value] of Object.entries(filters)) {
            if (value) params.set(name, value);
        }
        if (more && panels.audit.cursor) params.set('before', panels.audit.cursor);

        const result = await apiRequest(`${CONFIG.ENDPOINTS.ADMIN_AUDIT}?${params}`);
        if (!result.success) return setMessage(list, result.message || 'Failed to load the audit log');

        const rows = result.data.entries.map(renderAuditRow);
        if (more) list.append(...rows);
        else if (rows.length > 0) list.replaceChildren(...rows);
        else setMessage(list, 'Nothing matches.');

        panels.audit.cursor = result.data.nextCursor;
        byId('auditMore').hidden = !result.data.nextCursor;
    }

    function renderAuditRow(entry) {
        const actor = entry.actorId === null ? 'system or signed out' : `@${entry.actorUsername || `user ${entry.actorId}`}`;
        const target = entry.targetType ? ` → ${entry.targetType} ${entry.targetId}` : '';
        return h('div', { className: 'admin-row admin-row-static' },
            h('span', { className: 'admin-row-title', text: entry.event }),
            h('span', { className: 'admin-row-meta', text: `${formatTime(entry.createdAt)} · ${actor}${target}${entry.ipAddress ? ` · ${entry.ipAddress}` : ''}` }),
            entry.metadata ? h('span', { className: 'admin-row-meta admin-row-details', text: JSON.stringify(entry.metadata) }) : null
        );
    }

    // ===== Page =====

    const LOADERS = { reports: loadReports, users: loadUsers, audit: loadAudit };

    function selectTab(name) {
        document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
            const selected = tab.dataset.adminTab === name;
            tab.setAttribute('aria-selected', String(selected));
            if (selected) tab.removeAttribute('tabindex');
            else tab.setAttribute('tabindex', '-1');
        });
        document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
            panel.hidden = panel.dataset.adminPanel !== name;
        });
        if (!panels[name].loaded) {
            panels[name].loaded = true;
            LOADERS[name]();
        }
    }

    function applySavedTheme() {
        try {
            if (localStorage.getItem(CONFIG.STORAGE_KEYS.THEME) === 'dark') document.body.classList.add('dark-theme');
        } catch (error) {
            // Storage unavailable: the light theme it is
        }
    }

    async function start() {
        applySavedTheme();
        if (!isAuthenticated()) {
            window.location.href = 'login.html';
            return;
        }
        const session = await ensureSession();
        if (!session.ok) return;

        const config = await apiRequest(CONFIG.ENDPOINTS.ADMIN_CONFIG);
        if (!config.success) {
            byId('adminDenied').hidden = false;
            return;
        }

        const eventFilter = byId('auditEvent');
        config.data.auditEvents.forEach(event => eventFilter.appendChild(h('option', { text: event, attrs: { value: event } })));

        byId('adminConsole').hidden = false;
        document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
            tab.addEventListener('click', () => selectTab(tab.dataset.adminTab));
        });

        byId('reportStatusFilter').addEventListener('change', () => {
            byId('reportDetail').hidden = true;
            loadReports();
        });
        byId('userFilters').addEventListener('submit', (event) => { event.preventDefault(); loadUsers(); });
        byId('auditFilters').addEventListener('submit', (event) => { event.preventDefault(); loadAudit(); });
        byId('reportMore').addEventListener('click', () => loadReports({ more: true }));
        byId('userMore').addEventListener('click', () => loadUsers({ more: true }));
        byId('auditMore').addEventListener('click', () => loadAudit({ more: true }));

        selectTab('reports');
    }

    document.addEventListener('DOMContentLoaded', start);
})();
