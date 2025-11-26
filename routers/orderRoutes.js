const express = require('express');
const router = express.Router();

const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');
const authMemberRequired = require('../middlewares/authMember');
const authMemberOptional = require('../middlewares/authMemberOptional');

const order = require('../controllers/orderController');

// === Multipart hanya untuk route yang butuh (checkout transfer) ===
let parseFormData;
try {
  parseFormData = require('../middlewares/parseFormData');
} catch {
  parseFormData = (_req, _res, next) => next();
}

let fileUploader;
try {
  fileUploader = require('../utils/fileUploader');
} catch {
  fileUploader = {
    single: () => (_req, _res, next) => next()
  };
}

router.use(order.modeResolver);

router.get('/get-cart', order.getCart);
router.post('/new-items', order.addItem);
router.delete('/clear', order.clearCart);
router.post('/table', order.assignTable);
router.patch('/change-table', order.changeTable);
router.patch('/change-order-type', order.setFulfillmentType);
router.get('/delivery/estimate', order.estimateDelivery);
router.post(
  '/assign-batch',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.assignBatch
);

router.post(
  '/dine-in/cashier/register',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.cashierRegisterMember
);

router.post(
  '/checkout',
  authMemberOptional,
  fileUploader.single('payment_proof'),
  parseFormData,
  order.checkout
);

router.get('/delivery-slots', order.deliverySlots);
router.post('/checkout/qris', authMemberOptional, order.createQrisFromCart);
router.get(
  '/delivery-board',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.deliveryBoard
);

router.get(
  '/courier/assigned',
  validateToken,
  requireRole('owner', 'courier'),
  requirePageAccess('courier'),
  order.getAssignedDeliveries
);

router.get(
  '/list-employee',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.listEmployeesDropdown
);

router.get(
  '/list-member',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.listMembers
);

router.get(
  '/transactions-summary',
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('orders'),
  order.closingShiftSummary
);

router.get('/my-order', authMemberRequired, order.listMyOrders);
router.post('/price-preview', authMemberOptional, order.previewPrice);

router.post(
  '/dine-in/cashier',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.createPosDineIn
);
router.post(
  '/dine-in/cashier/preview',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.previewPosOrder
);
router.post(
  '/evaluate-pos',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.evaluatePos
);

router.get(
  '/list-order',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.listOrders
);

router.get(
  '/kitchen',
  validateToken,
  requireRole('owner', 'kitchen'),
  requirePageAccess('kitchen'),
  order.listKitchenOrders
);

router.get(
  '/pickup',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.getPickupOrders
);

router.get(
  '/dashboard',
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  order.homeDashboard
);

router.get(
  '/owner/verify-pending',
  validateToken,
  requireRole('owner'),
  order.ownerVerifyPendingList
);

router.get(
  '/:id',
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('orders'),
  order.getDetailOrder
);

router.get('/:id/receipt', order.getOrderReceipt);

router.post(
  '/:id/verify-payment',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.acceptAndVerify
);

router.patch(
  '/owner/verify/:id',
  validateToken,
  requireRole('owner'),
  order.verifyOwnerDashboard
);

router.patch(
  '/:id/mark-delivered',
  validateToken,
  requireRole('owner', 'courier'),
  requirePageAccess('courier'),
  order.markAssignedToDelivered
);

router.post(
  '/:id/complete-order',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.completeOrder
);

router.post(
  '/:id/delivery/assign',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.assignDelivery
);

router.patch(
  '/:id/delivery/status',
  validateToken,
  requireRole('owner', 'courier'),
  requirePageAccess('orders'),
  order.updateDeliveryStatus
);

router.delete(
  '/:id/cancel',
  validateToken,
  requireRole('owner', 'cashier'),
  requirePageAccess('orders'),
  order.cancelOrder
);

router.get('/member/my-order/:id', authMemberRequired, order.getMyOrder);

router.patch('/update/:itemId', order.updateItem);
router.delete('/remove/:itemId', order.removeItem);

module.exports = router;
