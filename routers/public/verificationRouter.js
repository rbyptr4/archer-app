const express = require('express');
const router = express.Router();
const order = require('../../controllers/orderController');

router.get('/owner-verify', order.verifyOwnerByToken);

module.exports = router;
