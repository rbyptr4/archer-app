const router = require('express').Router();

const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');

const parseFormData = require('../middlewares/parseFormData');
const imageUploader = require('../utils/fileUploader');

const ctl = require('../controllers/expenseController');

router.use(
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('expense')
);

router.post('/types/create', ctl.createType);
router.get('/types/list', ctl.listTypes);
router.get('/types/:id', ctl.getTypeById);
router.patch('/types/update/:id', ctl.updateType);
router.delete('/types/remove/:id', ctl.removeType);

router.post(
  '/create',
  imageUploader.single('expense_proof'),
  parseFormData,
  ctl.createExpense
);

router.get('/list', ctl.getExpenses);

router.get('/:id', ctl.getExpenseById);

router.patch(
  '/update/:id',
  imageUploader.single('expense_proof'),
  parseFormData,
  ctl.updateExpense
);

router.delete('/remove/:id', ctl.removeExpense);

module.exports = router;
