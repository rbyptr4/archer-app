const express = require('express');
const menu = require('../../controllers/owner/menuController');
const authMember = require('../../middlewares/authMember');

const router = express.Router();

router.get('/list', authMember, menu.listMenus);
router.get('/:id', authMember, menu.getMenuById);

module.exports = router;
