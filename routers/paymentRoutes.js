// routers/paymentInAppRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/paymentSessionController');
const wh = require('../controllers/payments/xenditWebhookController');

// in-app start session
router.get('/status/:id', ctrl.getSessionStatus);

router.post('/webhooks/xendit', express.raw({ type: '*/*' }), (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    wh.xenditQrisWebhook(body, req, res);
  } catch (e) {
    console.error('[Webhook raw parse failed]', e);
    res.status(400).json({ message: 'Bad JSON' });
  }
});

module.exports = router;
