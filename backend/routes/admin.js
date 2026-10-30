/**
 * Admin console API. Everything behind this router needs a signed-in user with users.is_admin set;
 * the three router.use lines run before any route, so a new route can't forget the check.
 * Nothing here sets is_admin: that's scripts/set-admin.js or the database.
 */

const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
    validateAdminReportsQuery,
    validateReportIdParam,
    validateEvidenceFileParams,
    validateAdminWarn,
    validateAdminSuspend,
    validateAdminSuspendUser,
    validateAdminUsersQuery,
    validateUserIdParam,
    validateAuditQuery,
    checkValidation
} = require('../utils/validation');

const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many requests. Please wait a moment.',
    keyGenerator: (req) => `user:${req.user.id}`
});

router.use(authenticateToken);
router.use(adminLimiter);
router.use(requireAdmin);

router.get('/config', adminController.getConfig);

router.get('/reports', validateAdminReportsQuery, checkValidation, adminController.listReports);
router.get('/reports/:reportId', validateReportIdParam, checkValidation, adminController.getReport);
router.get('/reports/:reportId/evidence/:evidenceId/file', validateEvidenceFileParams, checkValidation, adminController.downloadEvidenceFile);
router.post('/reports/:reportId/dismiss', validateReportIdParam, checkValidation, adminController.dismissReport);
router.post('/reports/:reportId/warn', validateAdminWarn, checkValidation, adminController.warnFromReport);
router.post('/reports/:reportId/suspend', validateAdminSuspend, checkValidation, adminController.suspendFromReport);
router.post('/reports/:reportId/delete-message', validateReportIdParam, checkValidation, adminController.deleteReportedMessage);

router.get('/users', validateAdminUsersQuery, checkValidation, adminController.listUsers);
router.post('/users/:userId/suspend', validateAdminSuspendUser, checkValidation, adminController.suspendUser);
router.post('/users/:userId/unsuspend', validateUserIdParam, checkValidation, adminController.unsuspendUser);
router.post('/users/:userId/logout', validateUserIdParam, checkValidation, adminController.forceLogout);

router.get('/audit', validateAuditQuery, checkValidation, adminController.searchAudit);

module.exports = router;
