const express = require('express');
const {
  loginMember,
  registerMember,
  logoutMember,
  member,
  refreshMember,
  verifyLoginOtp,
  verifyRegisterOtp,
  devLoginMember,
  devRegister,
  updateBirthday,
  updateAddress
} = require('../../controllers/member/authMemberController');
const {
  listMyOrders,
  getMyOrder
} = require('../../controllers/orderController');
const authMember = require('../../middlewares/authMember');
const authMemberOptional = require('../../middlewares/authMemberOptional');
const {
  requestChangeName,
  requestChangePhone,
  verifyChangeName,
  verifyChangePhone,
  requestForgotUsername,
  verifyForgotUsername,
  setNewUsername,
  resendOtp
} = require('../../controllers/member/waOtpController');
const router = express.Router();

router.post('/dev-login', devLoginMember);
router.post('/dev-register', devRegister);
router.post('/request-change-phone', requestChangePhone);
router.post('/verify-change-phone', verifyChangePhone);
router.post('/request-change-name', requestChangeName);
router.post('/verify-change-name', verifyChangeName);
router.post('/forgot-username', requestForgotUsername);
router.post('/forgot-username/verify', verifyForgotUsername);
router.post('/forgot-username/set', setNewUsername);
router.post('/login', loginMember);
router.post('/login/verify', verifyLoginOtp);
router.post('/register', registerMember);
router.post('/register/verify', verifyRegisterOtp);
router.post('/refresh-token', refreshMember);
router.get('/me', authMember, member);

router.patch('/me/birthday', authMember, updateBirthday);
router.patch('/me/address', authMember, updateAddress);

router.post('/logout', logoutMember);
router.post('/resend-otp', resendOtp);

router.get('/my-order', authMemberOptional, listMyOrders);
router.get('/my-order/:id', authMember, getMyOrder);

module.exports = router;
