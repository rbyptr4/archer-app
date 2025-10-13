const express = require('express');
const router = express.Router();

const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');
const validateToken = require('../../utils/tokenHandler');
const fileUploader = require('../../utils/fileUploader');

const parseFormData = require('../../middlewares/parseFormData');
const validate = require('../../middlewares/validate');
const {
  createPackageMenuSchema,
  updatePackageMenuSchema
} = require('../../middlewares/validators/menuValidation');

const pkg = require('../../controllers/owner/packageMenuController');

router.use(
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('menu')
);

router.post(
  '/create-package',
  fileUploader.single('menu-image'),
  parseFormData,
  validate(createPackageMenuSchema),
  pkg.createPackageMenu
);
router.get('/list', pkg.listPackageMenus);
router.patch(
  '/update/:id',
  fileUploader.single('menu-image'),
  parseFormData,
  validate(updatePackageMenuSchema),
  pkg.updatePackageMenu
);
router.get('/:id', pkg.getPackageMenuById);
router.delete('/remove/:id', pkg.deletePackageMenu);
router.patch('/:id/activate', pkg.activatePackageMenu);
router.patch('/:id/deactivate', pkg.deactivatePackageMenu);

module.exports = router;
