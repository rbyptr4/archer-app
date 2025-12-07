// routers/member/voucherMemberRoutes.js
const express = require('express');
const authMember = require('../../middlewares/authMember');
const ctrl = require('../../controllers/member/voucherMemberController');
const router = express.Router();

router.use(authMember);
router.get('/me/wallet', ctrl.myWallet);
router.get('/me/my-voucher', ctrl.myVoucher);
router.get('/explore', ctrl.explore);

router.get('/me/my-voucher/:id', ctrl.myVoucher);
router.get('/explore/:id', ctrl.getVoucherById);

router.post('/:voucherId/claim', ctrl.claim);

module.exports = router;
