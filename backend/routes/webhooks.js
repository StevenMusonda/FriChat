/**
 * Incoming webhook endpoint: no session, the URL's token is the credential.
 * Mounted before the app's JSON parser so this route's smaller limit and error answers apply. The
 * per-webhook limiter runs after the token check, so someone without the token can't use up a
 * webhook's budget by guessing its id; the per-IP limiter covers them instead.
 *
 * Nothing here logs the URL: it holds the token. Keep it out of proxy access logs too (FEATURES_SETUP.md).
 */

const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const { rateLimit } = require('../middleware/rateLimit');
const { webhookLimits, WEBHOOK_MAX_BODY } = require('../config/webhooks');
const { validateWebhookPost, checkValidation } = require('../utils/validation');

const limits = webhookLimits();

const webhookIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: limits.ipPerMinute,
    message: 'Too many requests. Please wait a moment.'
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: limits.perMinute,
    message: 'This webhook is sending too fast. Please wait a moment.',
    keyGenerator: (req) => `webhook:${req.webhook.id}`
});

router.post(
    '/:webhookId/:token',
    webhookIpLimiter,
    webhookController.authenticateWebhook,
    webhookLimiter,
    express.json({ limit: WEBHOOK_MAX_BODY }),
    validateWebhookPost,
    checkValidation,
    webhookController.receiveWebhook
);

router.use(webhookController.handleWebhookBodyError);

module.exports = router;
