// routers/orderRoutes.js
const express = require('express');
const router = express.Router();

const validateToken = require('../utils/tokenHandler'); // staff token middleware
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');

const authMemberRequired = require('../middlewares/authMember');
const orderCtrl = require('../controllers/orderController');

/* ===== Member ===== */
router.get('/my-order', authMemberRequired, orderCtrl.listMyOrders);
router.post('/price-preview', authMemberRequired, orderCtrl.previewPrice); // <— NEW

// POS dine-in (tanpa voucher jika tidak ada member)
router.post(
  '/dine-in/cashier',
  requireRole(['owner', 'employee']),
  orderCtrl.createPosDineIn
);

/* ===== Staff: list/kitchen/detail/status ===== */
router.get(
  '/list-order',
  validateToken,
  requireRole(['owner', 'employee']),
  requirePageAccess('orders'),
  orderCtrl.listOrders
);
router.get(
  '/kitchen',
  validateToken,
  requireRole(['owner', 'employee']),
  requirePageAccess('kitchen'),
  orderCtrl.listKitchenOrders
);

router.post('/:id/cancel', authMemberRequired, orderCtrl.cancelOrder);

router.get(
  '/:id',
  validateToken,
  requireRole(['owner', 'employee']),
  requirePageAccess('orders'),
  orderCtrl.getDetailOrder
);

router.patch(
  '/:id/status',
  validateToken,
  requireRole(['owner', 'employee']),
  requirePageAccess('orders'),
  orderCtrl.updateStatus
);

router.get('/member/my-order/:id', authMemberRequired, orderCtrl.getMyOrder);

module.exports = router;
