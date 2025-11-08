// routers/paymentInAppRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/orderController');
const wh = require('../controllers/payments/xenditWebhookController');

router.post(
  '/webhooks/xendit',
  express.json({ type: '*/*' }),
  wh.xenditQrisWebhook
);
// in-app start session
router.get('/:id/status', ctrl.getSessionStatus);

module.exports = router;
