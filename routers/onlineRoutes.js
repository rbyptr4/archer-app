const router = require('express').Router();
const authMemberOptional = require('../middlewares/authMemberOptional');
const parseFormData = require('../middlewares/parseFormData');
const fileUploader = require('../utils/fileUploader');
const onlineCtrl = require('../controllers/onlineController');

router.use(authMemberOptional);

router.get('/cart', onlineCtrl.getCart);
router.post('/cart/add', onlineCtrl.addToCart);
router.patch('/cart/update/:itemId', onlineCtrl.updateCartItem);
router.delete('/cart/remove/:itemId', onlineCtrl.removeCartItem);
router.delete('/cart/clear', onlineCtrl.clearCart);

router.get('/delivery/estimate', onlineCtrl.estimateDelivery);

router.post(
  '/checkout',
  fileUploader.single('payment_proof'),
  parseFormData,
  onlineCtrl.checkoutOnline
);

module.exports = router;
