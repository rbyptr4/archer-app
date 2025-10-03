const express = require('express');
const router = express.Router();

const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');

const validate = require('../../middlewares/validate');
const parseFormData = require('../../middlewares/parseFormData');

const {
  createMenuSchema,
  updateMenuSchema
} = require('../../middlewares/validators/menuValidation');
const menu = require('../../controllers/owner/menuController');
const imageUploader = require('../../utils/fileUploader');

// router.use(validateToken, requireRole('owner'));

router.post(
  '/create-menu',
  imageUploader.single('menu-image'),
  parseFormData,
  validate(createMenuSchema),
  menu.createMenu
);
router.get('/list', menu.listMenus);
router.get('/:id', menu.getMenuById);
router.patch(
  '/update/:id',
  imageUploader.single('menu-image'),
  parseFormData,
  validate(updateMenuSchema),
  menu.updateMenu
);
router.delete('/remove/:id', menu.deleteMenu);
router.patch('/:id/deactivate-menu', menu.deactivateMenu);
router.patch('/:id/activate-menu', menu.activateMenu);

module.exports = router;
