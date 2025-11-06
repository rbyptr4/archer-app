const express = require('express');
const router = express.Router();

const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');

const validate = require('../../middlewares/validate');
const parseFormData = require('../../middlewares/parseFormData');

const {
  createMenuSchema,
  updateMenuSchema
} = require('../../middlewares/validators/menuValidation');
const menu = require('../../controllers/owner/menuController');
const imageUploader = require('../../utils/fileUploader');

router.use(validateToken);

router.post(
  '/create-menu',
  requireRole('owner'),
  imageUploader.single('menu-image'),
  parseFormData,
  validate(createMenuSchema),
  menu.createMenu
);

router.get(
  '/list',
  requireRole('owner', 'employee'),
  requirePageAccess('menu'),
  menu.listMenus
);

router.get(
  '/sub-options',
  requireRole('owner', 'employee'),
  requirePageAccess('menu'),
  menu.subcategoryOptions
);

router.get('/:id', requirePageAccess('menu'), menu.getMenuById);

router.patch(
  '/update/:id',
  requireRole('owner'),
  imageUploader.single('menu-image'),
  parseFormData,
  validate(updateMenuSchema),
  menu.updateMenu
);

router.delete('/remove/:id', requireRole('owner'), menu.deleteMenu);

router.patch(
  '/:id/deactivate-menu',
  requirePageAccess('menu'),
  menu.deactivateMenu
);
router.patch(
  '/:id/activate-menu',
  requirePageAccess('menu'),
  menu.activateMenu
);

router.post('/:id/create-addons', requireRole('owner'), menu.addAddon);
router.patch(
  '/:id/update-addons',
  requireRole('owner'),
  menu.batchUpdateAddons
);
router.delete('/:id/remove/:addonId', requireRole('owner'), menu.deleteAddon);

// Tetap pertahankan PATCH /menu/:id untuk field non-addon

module.exports = router;
