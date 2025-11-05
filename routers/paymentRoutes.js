// routers/paymentInAppRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/payments/xenditController');
const wh = require('../controllers/payments/xenditWebhookController');

// in-app start session
router.post('/qris', ctrl.createQris);
router.post('/va', ctrl.createVA);
router.post('/ewallet', ctrl.createEwallet); // opsional
router.get('/status/:id', ctrl.getPaymentStatus);

router.post('/webhooks/xendit', express.json({ type: '*/*' }), wh.webhook);

module.exports = router;
