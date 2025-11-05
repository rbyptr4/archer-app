const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const validateToken = require('../utils/tokenHandler');

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

module.exports = router;
