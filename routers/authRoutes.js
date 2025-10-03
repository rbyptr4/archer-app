// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const validateToken = require('../utils/tokenHandler');
const validate = require('../middlewares/validate');
const { registerSchema } = require('../middlewares/validators/userValidation');

// public
router.post('/register-member', validate(registerSchema), auth.registerMember);
router.post('/login', auth.login);
router.post('/refresh-token', auth.refreshToken);
router.post('/logout', auth.logout);

// protectedd
router.get('/me', validateToken, auth.me);

module.exports = router;
