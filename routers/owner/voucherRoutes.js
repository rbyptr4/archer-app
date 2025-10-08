const express = require('express');
const validateToken = require('../../utils/tokenHandler'); // pastikan ada
const requireRole = require('../../utils/requireRole'); // pastikan ada
const ctrl = require('../../controllers/owner/voucherController');
const router = express.Router();

router.use(validateToken, requireRole('owner'));

router.post('/create-voucher', ctrl.createVoucher);
router.get('/all-voucher', ctrl.listVoucher);
router.get('/:id', ctrl.getVoucher);
router.patch('/update/:id', ctrl.updateVoucher);
router.patch('/:id/activate', ctrl.activateVoucher);
router.patch('/:id/deactivate', ctrl.deactivateVoucher);
router.delete('/remove/:id', ctrl.removeVoucher);
router.delete('/remove/:id/permanent', ctrl.permanentRemoveVoucher);

module.exports = router;
