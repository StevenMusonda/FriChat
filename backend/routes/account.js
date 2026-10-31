/**
 * Data rights: export your data, delete your account
 */

const express = require('express');
const router = express.Router();
const accountController = require('../controllers/accountController');
const { authenticateToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateReauthentication,
    validateExportIdParam,
    validateExportDownload,
    checkValidation
} = require('../utils/validation');

const byUser = (req) => `user:${req.user.id}`;

// The data_exports table also allows only one export per DATA_EXPORT_COOLDOWN_HOURS, across restarts
const exportRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'Too many export requests. Please try again later.',
    keyGenerator: byUser
});

const exportReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many requests. Please wait a moment.',
    keyGenerator: byUser
});

// Before the token is read, so per IP
const exportDownloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many downloads. Please try again in a few minutes.'
});

const deletionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many attempts. Please try again in a few minutes.',
    keyGenerator: byUser
});

// The only route without a session: its token is minted by /exports/:id/link, which has one
router.get('/exports/:exportId/download', exportDownloadLimiter, validateExportDownload, checkValidation, accountController.downloadExport);

router.use(authenticateToken);

router.get('/exports', exportReadLimiter, accountController.listExports);
router.post('/exports', exportRequestLimiter, accountController.requestExport);
router.post('/exports/:exportId/link', exportReadLimiter, validateExportIdParam, checkValidation, accountController.createDownloadLink);
router.post('/delete', deletionLimiter, validateReauthentication, checkValidation, accountController.requestDeletion);

module.exports = router;
