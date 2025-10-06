const express = require('express');
const router = express.Router();

const authMemberOptional = require('../middlewares/authMemberOptional');
const cartCtrl = require('../controllers/cartController');

const parseFormData = require('../middlewares/parseFormData');
const fileUploader = require('../utils/fileUploader');

router.use(authMemberOptional);

router.get('/cart', cartCtrl.getCart);
router.post('/cart/add', cartCtrl.addItem);
router.patch('/cart/update/:itemId', cartCtrl.updateItem);
router.delete('/cart/remove/:itemId', cartCtrl.removeItem);
router.delete('/cart/clear', cartCtrl.clearCart);

router.post(
  '/cart/checkout',
  fileUploader.single('payment_proof'),
  parseFormData,
  cartCtrl.checkout
);

module.exports = router;
