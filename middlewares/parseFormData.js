// middlewares/coerceMultipartFields.js
module.exports = (req, res, next) => {
  const parseMaybeJSON = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v; // sudah object
    const s = String(v).trim();
    if (!s) return fallback;
    // hanya parse jika terlihat seperti JSON
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return JSON.parse(s);
      } catch {
        return fallback;
      }
    }
    return fallback;
  };

  const toBool = (v, d = false) => {
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    return d;
  };

  const toInt = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : d;
  };

  // ======== Common fields ========
  // price dikirim sebagai JSON string di multipart -> parse ke object
  if ('price' in req.body) {
    req.body.price = parseMaybeJSON(req.body.price, {});
    // guard: coerce bidang numerik kalau ada
    if (req.body.price && typeof req.body.price === 'object') {
      if ('original' in req.body.price)
        req.body.price.original = toInt(req.body.price.original, 0);
      if ('discountPercent' in req.body.price)
        req.body.price.discountPercent = toInt(
          req.body.price.discountPercent,
          0
        );
      if ('manualPromoPrice' in req.body.price)
        req.body.price.manualPromoPrice = toInt(
          req.body.price.manualPromoPrice,
          0
        );
      if (
        'discountMode' in req.body.price &&
        typeof req.body.price.discountMode === 'string'
      ) {
        req.body.price.discountMode = req.body.price.discountMode.trim();
      }
    }
  }

  // boolean flags
  if ('isActive' in req.body)
    req.body.isActive = toBool(req.body.isActive, true);
  if ('isRecommended' in req.body)
    req.body.isRecommended = toBool(req.body.isRecommended, false);

  // addons bisa dikirim string JSON "[]"
  if ('addons' in req.body) {
    req.body.addons = parseMaybeJSON(req.body.addons, []);
    // opsi: pastikan price di setiap addon adalah number
    if (Array.isArray(req.body.addons)) {
      req.body.addons = req.body.addons.map((a) => ({
        ...a,
        price: toInt(a?.price, 0),
        name: String(a?.name || '').trim()
      }));
    }
  }

  // ======== Khusus Paket: items (array of { menu, qty }) ========
  if ('items' in req.body) {
    req.body.items = parseMaybeJSON(req.body.items, []);
    if (Array.isArray(req.body.items)) {
      req.body.items = req.body.items
        .map((it) => ({
          menu: it?.menu ? String(it.menu) : undefined,
          name: it?.name ? String(it.name).trim() : undefined,
          qty: toInt(it?.qty, 1) || 1
        }))
        .filter((it) => it.menu || it.name);
    }
  }

  next();
};
