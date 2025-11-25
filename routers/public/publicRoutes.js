const express = require('express');
const router = express.Router();
const order = require('../../controllers/orderController');
const banner = require('../../controllers/bannerController');

router.get('/owner-verify', order.verifyOwnerByToken);
router.get('/active-banner', banner.publicHomeBanners);

module.exports = router;
