const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const userCtrl = require('../controllers/userAccountController');
const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');

router.post('/internal/access/verify', auth.verifyInternalAccess);
router.get('/internal/access/check', auth.checkInternalAccess);
// router.post('/internal/access/revoke', auth.revokeInternalAccess);

router.post('/internal/login', auth.loginInternal);

router.put(
  '/internal/access/change-access-code',
  validateToken,
  auth.updateInternalAccessCode
);
router.post('/login', auth.login);
router.post('/refresh-token', auth.refreshToken);
router.post('/logout', auth.logout);

// protected
router.get('/me', validateToken, auth.me);
router.post(
  '/change-password',
  validateToken,
  userCtrl.changePasswordAuthenticated
);

router.post(
  '/change-email',
  validateToken,
  requireRole('owner'),
  userCtrl.changeEmailOwner
);

router.patch(
  '/change-profile',
  validateToken,
  userCtrl.changeProfileAuthenticated
);

router.post('/forgot-password', userCtrl.requestForgotPassword);
router.post('/forgot-password/verify', userCtrl.verifyForgotPasswordOtp);
router.post('/forgot-password/set', userCtrl.setNewPasswordAfterOtp);

router.post('/forgot-password/resend', userCtrl.resendUserOtp);

module.exports = router;
