const express = require('express');
const router = express.Router();
const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const rpt = require('../../controllers/owner/reportController');

router.use(
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('report')
);

router.get('/orders/summary', rpt.orderSummary);
router.get('/orders/list', rpt.orderList);
router.get('/orders/top-menu', rpt.orderTopMenu);

// ====== Laporan Keuangan ======
router.get('/finance/summary', rpt.financeSummary);
router.get('/finance/expense-list', rpt.expenseList);

// ====== Laporan Member ======
router.get('/members/summary', rpt.memberSummary);
router.get('/members/list', rpt.memberList);
router.get('/members/top-customer', rpt.topCustomer);

module.exports = router;
