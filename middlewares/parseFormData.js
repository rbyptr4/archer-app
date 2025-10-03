module.exports = (req, res, next) => {
  // ubah price ke number
  if (req.body.price) {
    req.body.price = Number(req.body.price);
  }

  // ubah isActive ke boolean
  if (req.body.isActive !== undefined) {
    req.body.isActive =
      req.body.isActive === 'true' || req.body.isActive === true;
  }

  // ubah addons ke array kalau string JSON
  if (req.body.addons && typeof req.body.addons === 'string') {
    try {
      req.body.addons = JSON.parse(req.body.addons);
    } catch (e) {
      req.body.addons = [];
    }
  }

  next();
};
