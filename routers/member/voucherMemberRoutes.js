// routers/member/voucherMemberRoutes.js
const express = require('express');
const authMember = require('../../middlewares/authMember');
const ctrl = require('../../controllers/member/voucherMemberController');
const router = express.Router();

router.get('/explore', authMember, ctrl.explore);
router.post('/:voucherId/claim', authMember, ctrl.claim);
router.get('/me/wallet', authMember, ctrl.myWallet);

module.exports = router;
