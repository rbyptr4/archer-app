const express = require('express');
const router = express.Router();

const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const emp = require('../../controllers/owner/employeeController');

const validate = require('../../middlewares/validate');
const {
  registerSchema,
  updateEmployeeSchema
} = require('../../middlewares/validators/userValidation');

router.use(validateToken);

router.post(
  '/create-employee',
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('employees'),
  // validate(registerSchema),
  emp.createEmployee
);

router.get(
  '/all-employee',
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('employees'),
  emp.listEmployees
);

router.get(
  '/:id',
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('employees'),
  emp.getEmployee
);

router.patch(
  '/update/:id',
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('employees'),
  // validate(updateEmployeeSchema),
  emp.updateEmployee
);

router.patch('/:id/pages', requireRole('owner'), emp.setEmployeePages);
router.delete('/remove/:id', requireRole('owner'), emp.deleteEmployee);

module.exports = router;
