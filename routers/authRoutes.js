const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const validateToken = require('../utils/tokenHandler');

router.post('/internal/access/verify', auth.verifyInternalAccess);
router.get('/internal/access/check', auth.checkInternalAccess);
router.post('/internal/access/revoke', auth.revokeInternalAccess);

// Login internal (butuh gate)
router.post('/internal/login', auth.loginInternal);
// public
// router.post('/login', auth.login);
router.post('/refresh-token', auth.refreshToken);
router.post('/logout', auth.logout);

// protected
router.get('/me', validateToken, auth.me);

module.exports = router;
