/**
 * Incoming webhooks: admins manage them under /api/chats/:chatId/webhooks; POST /api/webhooks/:id/:token
 * is what outside systems call
 */

const { requireGroupMember } = require('../utils/groups');
const { cleanMessageText } = require('../utils/messageText');
const webhooks = require('../utils/webhooks');
const auditLog = require('../utils/auditLog');

function sendError(res, error) {
    res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error.message);
    res.status(500).json({ success: false, message });
}

/**
 * Behind a proxy the request can name the wrong host, so PUBLIC_API_URL wins when it's set
 */
function webhookUrl(req, webhookId, token) {
    const base = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    return `${base}/api/webhooks/${webhookId}/${token}`;
}

/**
 * GET /api/chats/:chatId/webhooks (group admins)
 */
async function listWebhooks(req, res) {
    try {
        const check = await requireGroupMember(req.params.chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);
        res.json({ success: true, data: await webhooks.listWebhooks(req.params.chatId) });
    } catch (error) {
        serverError(res, 'List webhooks', error, 'Failed to load webhooks');
    }
}

/**
 * POST /api/chats/:chatId/webhooks Body: { name } (group admins). The URL is shown this once.
 */
async function createWebhook(req, res) {
    try {
        const { chatId } = req.params;
        const check = await requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const created = await webhooks.createWebhook(chatId, req.user.id, req.body.name);
        if (created.error) return sendError(res, created.error);

        await auditLog.recordRequest(req, 'webhook_created', {
            targetType: 'chat',
            targetId: Number(chatId),
            metadata: { webhookId: created.webhook.id, name: created.webhook.name }
        });

        res.set('Cache-Control', 'no-store');
        res.status(201).json({
            success: true,
            data: { ...created.webhook, url: webhookUrl(req, created.webhook.id, created.token) }
        });
    } catch (error) {
        serverError(res, 'Create webhook', error, 'Failed to create the webhook');
    }
}

/**
 * DELETE /api/chats/:chatId/webhooks/:webhookId (group admins)
 */
async function revokeWebhook(req, res) {
    try {
        const { chatId, webhookId } = req.params;
        const check = await requireGroupMember(chatId, req.user.id, { admin: true });
        if (check.error) return sendError(res, check.error);

        const revoked = await webhooks.revokeWebhook(chatId, webhookId, req.user.id);
        if (!revoked) return sendError(res, { status: 404, message: 'Webhook not found' });

        await auditLog.recordRequest(req, 'webhook_revoked', {
            targetType: 'chat',
            targetId: Number(chatId),
            metadata: { webhookId: Number(webhookId) }
        });
        res.json({ success: true, message: 'Webhook revoked' });
    } catch (error) {
        serverError(res, 'Revoke webhook', error, 'Failed to revoke the webhook');
    }
}

/**
 * Credentials first (routes/webhooks.js), so a request without them costs no body parsing.
 * Unknown id, wrong token and revoked all answer 404.
 */
async function authenticateWebhook(req, res, next) {
    try {
        const webhook = await webhooks.findWebhook(req.params.webhookId, req.params.token);
        if (!webhook) return sendError(res, { status: 404, message: 'Webhook not found' });
        req.webhook = webhook;
        next();
    } catch (error) {
        serverError(res, 'Webhook authentication', error, 'Failed to post the message');
    }
}

/**
 * POST /api/webhooks/:webhookId/:token Body: { text, username? }
 */
async function receiveWebhook(req, res) {
    try {
        // The same rule as every other send path
        const cleaned = cleanMessageText(req.body.text, { required: true });
        if (!cleaned.ok) return sendError(res, { status: 400, message: cleaned.error });

        const message = await webhooks.postWebhookMessage(req.io, req.webhook, cleaned.text, req.body.username);
        res.status(201).json({ success: true, data: { messageId: message ? Number(message.id) : null } });
    } catch (error) {
        serverError(res, 'Receive webhook', error, 'Failed to post the message');
    }
}

/**
 * Body errors stay here: the app's handler would log them and answer 500
 */
function handleWebhookBodyError(error, req, res, next) {
    if (error.type === 'entity.too.large') {
        return sendError(res, { status: 413, message: 'The request is too large' });
    }
    if (error.type === 'entity.parse.failed' || error.status === 400) {
        return sendError(res, { status: 400, message: 'The body must be JSON' });
    }
    next(error);
}

module.exports = {
    listWebhooks,
    createWebhook,
    revokeWebhook,
    authenticateWebhook,
    receiveWebhook,
    handleWebhookBodyError
};
