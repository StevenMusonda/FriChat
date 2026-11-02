/**
 * Optional AI features. The rules are in utils/ai.js; every route works without an API key and just
 * answers AI_DISABLED.
 */

const ai = require('../utils/ai');
const { aiEnabled } = require('../config/ai');
const { queryOne } = require('../config/database');

function sendError(res, error) {
    res.status(error.status).json({ success: false, message: error.message, code: error.code });
}

function serverError(res, label, error, message) {
    console.error(`${label} error:`, error.message);
    res.status(500).json({ success: false, message });
}

/**
 * GET /api/ai/status
 */
async function getStatus(req, res) {
    try {
        res.json({ success: true, data: await ai.getStatus(req.user.id) });
    } catch (error) {
        serverError(res, 'AI status', error, 'Failed to load AI settings');
    }
}

/**
 * POST /api/ai/consent Body: { language? }
 */
async function giveConsent(req, res) {
    try {
        if (!aiEnabled()) return sendError(res, ai.DISABLED_ERROR);
        await ai.recordConsent(req.user.id, req.body.language);
        res.json({ success: true, data: await ai.getStatus(req.user.id) });
    } catch (error) {
        serverError(res, 'AI consent', error, 'Failed to save your choice');
    }
}

/**
 * PUT /api/ai/language Body: { language } (the language Translate uses)
 */
async function setLanguage(req, res) {
    try {
        if (!aiEnabled()) return sendError(res, ai.DISABLED_ERROR);
        await ai.saveLanguage(req.user.id, req.body.language);
        res.json({ success: true, data: await ai.getStatus(req.user.id) });
    } catch (error) {
        serverError(res, 'AI language', error, 'Failed to save the language');
    }
}

/**
 * PUT /api/ai/chats/:chatId Body: { enabled } (turning it off works even without consent)
 */
async function setChatEnabled(req, res) {
    try {
        if (!aiEnabled()) return sendError(res, ai.DISABLED_ERROR);
        const { chatId } = req.params;
        const member = await queryOne('SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?', [chatId, req.user.id]);
        if (!member) return sendError(res, { status: 403, message: 'Access denied to this chat' });
        await ai.setChatAiEnabled(chatId, req.user.id, req.body.enabled);
        res.json({ success: true, data: await ai.getStatus(req.user.id) });
    } catch (error) {
        serverError(res, 'AI chat setting', error, 'Failed to save the setting');
    }
}

/**
 * POST /api/ai/chats/:chatId/summary (the answer goes only to the person who asked)
 */
async function summarizeUnread(req, res) {
    try {
        const result = await ai.summarizeUnread(req.user.id, req.params.chatId);
        if (result.error) return sendError(res, result.error);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: result });
    } catch (error) {
        serverError(res, 'AI summary', error, 'Failed to summarize this chat');
    }
}

/**
 * POST /api/ai/messages/:messageId/translate
 */
async function translateMessage(req, res) {
    try {
        const result = await ai.translateMessage(req.user.id, req.params.messageId);
        if (result.error) return sendError(res, result.error);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: result });
    } catch (error) {
        serverError(res, 'AI translation', error, 'Failed to translate this message');
    }
}

module.exports = {
    getStatus,
    giveConsent,
    setLanguage,
    setChatEnabled,
    summarizeUnread,
    translateMessage
};
