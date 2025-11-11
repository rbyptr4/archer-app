const express = require('express');
const {
  loginMember,
  registerMember,
  logoutMember,
  member,
  refreshMember,
  verifyLoginOtp,
  verifyRegisterOtp,
  devLoginMember
} = require('../../controllers/member/authMemberController');
const authMember = require('../../middlewares/authMember');
const {
  requestChangeName,
  requestChangePhone,
  verifyChangeName,
  verifyChangePhone,
  resendOtp
} = require('../../controllers/member/waOtpController');
const router = express.Router();

router.post('/dev-login', devLoginMember);
router.post('/request-change-phone', requestChangePhone);
router.post('/verify-change-phone', verifyChangePhone);
router.post('/request-change-name', requestChangeName);
router.post('/verify-change-name', verifyChangeName);
router.post('/login', loginMember);
router.post('/login/verify', verifyLoginOtp);
router.post('/register', registerMember);
router.post('/register/verify', verifyRegisterOtp);
router.post('/refresh-token', refreshMember);
router.get('/me', authMember, member);
router.post('/logout', logoutMember);
router.post('/resend-otp', resendOtp);

module.exports = router;
