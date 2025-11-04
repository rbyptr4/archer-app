const express = require('express');
const {
  loginMember,
  registerMember,
  logoutMember,
  member,
  refreshMember
} = require('../../controllers/member/authMemberController');
const authMember = require('../../middlewares/authMember');
const {
  requestWaOtp,
  verifyWaOtp,
  requestChangeName,
  requestChangePhone,
  verifyChangeName,
  verifyChangePhone
} = require('../../controllers/member/waOtpController');
const router = express.Router();

router.post('/request-otp', requestWaOtp);
router.post('/verify-otp', verifyWaOtp);
router.post('/request-change-phone', requestChangePhone);
router.post('/verify-change-phone', verifyChangePhone);
router.post('/request-change-name', requestChangeName);
router.post('/verify-change-name', verifyChangeName);
router.post('/login', loginMember);
router.post('/refresh-token', refreshMember);
router.post('/register', registerMember);
router.get('/me', authMember, member);
router.post('/logout', logoutMember);

module.exports = router;
