const router = require('express').Router();

const validateToken = require('../utils/tokenHandler');
const requireRole = require('../utils/requireRole');
const requirePageAccess = require('../utils/requirePageAccess');

const parseFormData = require('../middlewares/parseFormData');
const imageUploader = require('../utils/fileUploader');

const ctl = require('../controllers/bannerController');

// === Proteksi semua route banner ===
router.use(
  validateToken,
  requireRole('owner', 'courier', 'kitchen', 'cashier'),
  requirePageAccess('banner')
);

router.post(
  '/create-banner',
  imageUploader.single('banner_image'),
  parseFormData,
  ctl.createBanner
);

router.get('/list-banner', ctl.listBanners);

router.get('/:id', ctl.getBannerById);
router.post('/activate/:id', ctl.activateBanner);
router.post('/deactivate/:id', ctl.deactivateBanner);
router.patch(
  '/:id/update',
  imageUploader.single('banner-image'),
  parseFormData,
  ctl.updateBanner
);
router.delete('/:id/remove', ctl.removeBanner);

module.exports = router;
