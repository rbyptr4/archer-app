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
  requireRole('owner', 'employee'), // role check dulu
  requirePageAccess('menu'), // baru cek pages.menu
  imageUploader.single('menu-image'),
  parseFormData,
  validate(createMenuSchema),
  menu.createMenu
);

router.get(
  '/list',
  requireRole('owner', 'employee'), // misal member juga bisa lihat
  requirePageAccess('menu'),
  menu.listMenus
);

router.get('/:id', requirePageAccess('menu'), menu.getMenuById);

router.patch(
  '/update/:id',
  requireRole('owner', 'employee'),
  requirePageAccess('menu'),
  imageUploader.single('menu-image'),
  parseFormData,
  validate(updateMenuSchema),
  menu.updateMenu
);

router.delete(
  '/remove/:id',
  requireRole('owner'),
  requirePageAccess('menu'),
  menu.deleteMenu
);

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

module.exports = router;
