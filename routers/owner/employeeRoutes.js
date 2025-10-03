// routes/employeeRoutes.js
const express = require('express');
const router = express.Router();

const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');
const emp = require('../../controllers/owner/employeeController');

const validate = require('../../middlewares/validate');
const {
  registerSchema
} = require('../../middlewares/validators/userValidation');

router.use(validateToken, requireRole('owner'));

router.post('/create-employee', validate(registerSchema), emp.createEmployee);
router.get('/all-employee', emp.listEmployees);
router.get('/:id', emp.getEmployee);
router.patch('/update/:id', emp.updateEmployee);
router.patch('/:id/pages', emp.setEmployeePages);
router.delete('/remove/:id', emp.deleteEmployee);

module.exports = router;
