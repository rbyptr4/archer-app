const express = require('express');
const router = express.Router();
const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');
const ctrl = require('../controllers/closingShiftController');

router.use(
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('closing')
);

router.get('/open', ctrl.findOpen);
router.get('/list-employee', ctrl.listEmployeesDropdown);
router.get('/transactions-summary', ctrl.closingShiftSummary);
router.post('/shift-1', ctrl.createShift1);

router.post('/:id/send-wa', ctrl.sendClosingShiftLockedWa);
router.patch('/:id/shift-2', ctrl.fillShift2);
router.patch('/:id/lock', ctrl.lockReport);

module.exports = router;
