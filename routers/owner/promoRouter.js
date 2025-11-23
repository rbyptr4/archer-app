const express = require('express');
const validateToken = require('../../utils/tokenHandler'); // pastikan ada
const requireRole = require('../../utils/requireRole'); // pastikan ada
const requirePageAccess = require('../../utils/requirePageAccess'); // pastikan ada
const ctrl = require('../../controllers/owner/promoController');
const router = express.Router();

router.use(validateToken, requireRole('owner'), requirePageAccess('promo'));

router.post('/available-promo', ctrl.evaluate);
router.get('/list', ctrl.list);
router.patch('/:id/activate', ctrl.activate);
router.patch('/:id/deactivate', ctrl.deactivate);
router.patch('/update/:id', ctrl.evaluate);
router.delete('/remove/:id', ctrl.evaluate);

module.exports = router;
