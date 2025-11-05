const express = require('express');
const router = express.Router();

const validateToken = require('../utils/tokenHandler'); // staff token middleware
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');

const authMemberRequired = require('../middlewares/authMember');

// const fileUploader = require('../utils/fileUploader');

// let parseFormData;
// try {
//   parseFormData = require('../middlewares/parseFormData');
// } catch {
//   parseFormData = (_req, _res, next) => next();
// }

const order = require('../controllers/orderController');

router.use(order.modeResolver);

router.get('/get-cart', order.getCart);
router.post('/new-items', order.addItem);
router.delete('/clear', order.clearCart);
router.post('/table', order.assignTable);
router.patch('/change-table', order.changeTable);
router.patch('/change-order-type', order.setFulfillmentType);
router.get('/delivery/estimate', order.estimateDelivery);
router.post('/checkout', order.checkout);
router.get(
  '/delivery-board',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.deliveryBoard
);
router.get(
  '/list-employee',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.listEmployeesDropdown
);
router.get('/my-order', authMemberRequired, order.listMyOrders);
router.post('/price-preview', authMemberRequired, order.previewPrice);

router.post(
  '/dine-in/cashier',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.createPosDineIn
);
router.post(
  '/dine-in/cashier/preview',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.previewPosOrder
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

router.post(
  '/:id/verify-payment',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.acceptAndVerify
);

router.post(
  '/:id/complete-order',
  validateToken,
  requireRole('owner', 'employee'),
  requirePageAccess('orders'),
  order.completeOrder
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

router.get('/member/my-order/:id', authMemberRequired, order.getMyOrder);

router.patch('/update/:itemId', order.updateItem);
router.delete('/remove/:itemId', order.removeItem);

module.exports = router;
