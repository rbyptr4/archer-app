// routes/owner/memberReportRoutes.js
const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/owner/memberManagementController');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const guard = requireRole('owner', 'employee');
router.use(requirePageAccess('members'));

router.get('/summary', guard, ctrl.listMemberSummary);

router.get('/customer-growth', guard, ctrl.newCustomers);

router.get('/:id', guard, ctrl.getMemberDetail);

router.get('/top-spenders', guard, ctrl.topSpenders);

router.delete('remove/:id', requireRole('owner'), ctrl.deleteMemberAccount);

module.exports = router;
