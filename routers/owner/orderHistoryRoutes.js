const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/owner/orderHistoryController');

// Ganti middleware sesuai proyekmu
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const guard = requireRole('owner', 'employee');

router.use(requirePageAccess('reports'));
// ===== Laporan Order / Transaksi =====
router.get('/summary', guard, ctrl.summaryByPeriod);
router.get('/transactions/paid', guard, ctrl.totalPaidTransactions);
router.get('/transactions/cancelled', guard, ctrl.totalCancelledTransactions);

// ===== Laporan Keuangan =====
router.get('/finance/sales', guard, ctrl.financeSales); // metric=omzet|pendapatan
router.get('/finance/expenses', guard, ctrl.financeExpenses); // pengeluaran
router.get('/finance/profit-loss', guard, ctrl.profitLoss); // laba/rugi

// ===== Detail & Delete =====
router.get('/:id', guard, ctrl.getHistoryDetail);
router.delete('remove/:id', requireRole('owner'), ctrl.deleteHistory);

module.exports = router;
