const router = require('express').Router();
const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');
const ops = require('../controllers/orderOpsController');

router.use(validateToken, requireRole(['owner', 'employee']));

router.get(
  '/delivery-board',
  requirePageAccess('delivery'),
  ops.listDeliveryBoard
);

// Payment
router.patch('/:id/pay', requirePageAccess('orders'), ops.markPaid);
router.patch(
  '/:id/payment',
  requirePageAccess('orders'),
  ops.updatePaymentStatus
);

// Delivery Ops
router.patch(
  '/:id/delivery/assign',
  requirePageAccess('delivery'),
  ops.assignCourier
);
router.patch(
  '/:id/delivery/status',
  requirePageAccess('delivery'),
  ops.updateDeliveryStatus
);

module.exports = router;
