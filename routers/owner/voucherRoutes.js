const express = require('express');
const validateToken = require('../../utils/tokenHandler'); // pastikan ada
const requireRole = require('../../utils/requireRole'); // pastikan ada
const requirePageAccess = require('../../utils/requirePageAccess'); // pastikan ada
const ctrl = require('../../controllers/owner/voucherController');
const router = express.Router();

router.use(validateToken, requireRole('owner'), requirePageAccess('voucher'));

router.post('/percent', ctrl.createPercentVoucher);
router.post('/bundling', ctrl.createBundlingVoucher);
router.post('/amount', ctrl.createAmountVoucher);
router.post('/shipping', ctrl.createShippingVoucher);
router.get('/all-voucher', ctrl.listVoucher);
router.get('/:id', ctrl.getVoucher);
router.patch('/update/:id', ctrl.updateVoucher);
router.patch('/:id/activate', ctrl.activateVoucher);
router.patch('/:id/deactivate', ctrl.deactivateVoucher);
router.delete('/remove/:id', ctrl.removeVoucher);

module.exports = router;
