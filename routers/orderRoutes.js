const express = require('express');
const router = express.Router();

const validateToken = require('../utils/tokenHandler'); // staff token middleware
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');

const authMemberRequired = require('../middlewares/authMember');

const fileUploader = require('../utils/fileUploader');

let parseFormData;
try {
  parseFormData = require('../middlewares/parseFormData');
} catch {
  parseFormData = (_req, _res, next) => next();
}

const order = require('../controllers/orderController');

router.use(order.modeResolver);

router.get('/get-cart', order.getCart);
router.post('/new-items', order.addItem);
router.patch('/update/:itemId', order.updateItem);
router.delete('/remove/:itemId', order.removeItem);
router.delete('/clear', order.clearCart);
router.post('/table', order.assignTable);
router.patch('/change-table', order.changeTable);

router.get('/delivery/estimate', order.estimateDelivery);

router.post(
  '/checkout',
  fileUploader.single('payment_proof'),
  parseFormData,
  order.checkout
);

router.get('/my-order', authMemberRequired, order.listMyOrders);
router.get('/member/my-order/:id', authMemberRequired, order.getMyOrder);
router.post('/price-preview', authMemberRequired, order.previewPrice);

router.post(
  '/dine-in/cashier',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.createPosDineIn
);

router.get(
  '/list-order',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.listOrders
);

router.get(
  '/kitchen',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('kitchen'),
  order.listKitchenOrders
);

router.get(
  '/:id',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.getDetailOrder
);

router.patch(
  '/:id/status',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.updateStatus
);

router.post(
  '/:id/verify-payment',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.acceptAndVerify
);

router.post(
  '/:id/refund',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.cancelAndRefund
);

// Delivery APIs
router.get(
  '/delivery-board',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.deliveryBoard
);

router.patch(
  '/:id/delivery/assign',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.assignDelivery
);

router.patch(
  '/:id/delivery/status',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.updateDeliveryStatus
);

router.post('/:id/cancel', authMemberRequired, order.cancelOrder);

module.exports = router;
