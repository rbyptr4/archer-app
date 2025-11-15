const router = require('express').Router();
const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');
const ctl = require('../controllers/expenseController');

router.use(
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('expense')
);
/* ====== Expense Types (subpath: /expenses/types) ====== */
router.post('/types/create', ctl.createType);
router.get('/types/list', ctl.listTypes);
router.get('/types/:id', ctl.getTypeById);
router.patch('/types/update/:id', ctl.updateType);
router.delete('/types/remove/:id', ctl.removeType);

/* ============== Expenses (root: /expenses) ============== */
router.post('/create', ctl.createExpense);
router.get('/list', ctl.getExpenses);
router.get('/:id', ctl.getExpenseById);
router.patch('/update/:id', ctl.updateExpense);
router.delete('/remove/:id', ctl.removeExpense);

module.exports = router;
