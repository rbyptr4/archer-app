// routers/member/voucherMemberRoutes.js
const express = require('express');
const authMember = require('../../middlewares/authMember');
const ctrl = require('../../controllers/member/voucherMemberController');
const router = express.Router();

router.get('/me/wallet', authMember, ctrl.myWallet);
router.get('/me/my-voucher', authMember, ctrl.myVoucher);
router.get('/explore', authMember, ctrl.explore);

router.get('/me/my-voucher/:id', authMember, ctrl.myVoucher);
router.get('/explore/:id', authMember, ctrl.getVoucherById);

router.post('/:voucherId/claim', authMember, ctrl.claim);

module.exports = router;
