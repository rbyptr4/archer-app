const express = require('express');
const router = express.Router();
const category = require('../../controllers/owner/menuCategoryController');
const requireRole = require('../../utils/requireRole');
const requirePageAccess = require('../../utils/requirePageAccess');

router.get(
  '/all-sub',
  requireRole('owner', 'employee'), // atau tambahkan 'member'
  requirePageAccess('menu'), // atau 'menuManagement' sesuai key-mu
  category.listSubcategories
);

router.post(
  '/create-sub',
  requireRole('owner'),
  requirePageAccess('menu'),
  category.createSubcategory
);

router.patch(
  '/update/:id',
  requireRole('owner'),
  requirePageAccess('menu'),
  category.updateSubcategory
);

router.delete(
  '/remove/:id',
  requireRole('owner'),
  requirePageAccess('menu'),
  category.deleteSubcategory
);

module.exports = router;
