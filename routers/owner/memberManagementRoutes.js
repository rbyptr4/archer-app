// routes/owner/memberReportRoutes.js
const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/owner/memberManagementController');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const validateToken = require('../../utils/tokenHandler'); // staff token middleware

router.use(
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('members')
);

router.get('/summary', ctrl.listMemberSummary);
router.get('/top-spenders', ctrl.topSpenders);
router.get('/:id', ctrl.getMemberDetail);
router.delete('remove/:id', ctrl.deleteMemberAccount);

module.exports = router;
