const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const validateToken = require('../utils/tokenHandler');

// public
router.post('/login', auth.login);
router.post('/refresh-token', auth.refreshToken);
router.post('/logout', auth.logout);

// protected
router.get('/me', validateToken, auth.me);

module.exports = router;
