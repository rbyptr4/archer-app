// routers/paymentInAppRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/paymentSessionController');
const wh = require('../controllers/payments/xenditWebhookController');

// in-app start session
router.get('/status/:id', ctrl.getSessionStatus);

router.post(
  '/webhooks/xendit',
  express.json({ type: '*/*' }),
  wh.xenditQrisWebhook
);

module.exports = router;
