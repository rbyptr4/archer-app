const express = require('express');
const router = express.Router();
const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const rpt = require('../../controllers/owner/reportController');

router.use(
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('reports')
);

router.get('/orders/dashboard', rpt.reportDashboard);
router.get('/orders/transactions', rpt.totalTransactions);

// ====== Laporan Keuangan ======
// router.get('/finance/summary', rpt.);
// router.get('/finance/expense-list', rpt.);
router.get('/finance/profit-loss', rpt.profitLoss);

// ====== Laporan Member ======
router.get('/members/list', rpt.listMemberSummary);
router.get('/members/dashboard', rpt.memberDashboard);
router.get('/members/dashboard/top-spender', rpt.topSpendersThisMonth);
router.get('/members/customer-growth', rpt.customerGrowth);

// ====== Laporan Menu ======
router.get('/menu/top-menu', rpt.bestSeller);

router.get('/orders/:id', rpt.getDetailOrder);
router.get('/members/:id', rpt.getMemberDetail);

module.exports = router;
