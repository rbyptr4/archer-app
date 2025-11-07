// routers/paymentInAppRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/paymentSessionController');
const wh = require('../controllers/payments/xenditWebhookController');

router.post(
  '/webhooks/xendit',
  express.json({ type: '*/*' }),
  wh.xenditQrisWebhook
);
// in-app start session
router.get('/status/:id', ctrl.getSessionStatus);

module.exports = router;
