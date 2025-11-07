// routers/paymentInAppRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/payments/xenditController');
const wh = require('../controllers/payments/xenditWebhookController');

// in-app start session
router.post('/qris', ctrl.createQris);
router.get('/status/:id', ctrl.getPaymentStatus);

router.post(
  '/webhooks/xendit',
  express.json({ type: '*/*' }),
  wh.xenditQrisWebhook
);

module.exports = router;
