// middlewares/coerceMultipartFields.js
module.exports = (req, res, next) => {
  const parseMaybeJSON = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v; // sudah object
    const s = String(v).trim();
    if (!s) return fallback;
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

  /* ===== Common flags ===== */
  if ('isActive' in req.body)
    req.body.isActive = toBool(req.body.isActive, true);
  if ('isRecommended' in req.body)
    req.body.isRecommended = toBool(req.body.isRecommended, false);

  /* ===== Price (JSON string -> object) + PRUNE sesuai mode ===== */
  if ('price' in req.body) {
    const p = (req.body.price = parseMaybeJSON(req.body.price, {}));

    if (p && typeof p === 'object') {
      // normalisasi mode
      let mode = (p.discountMode || 'none').toString().toLowerCase();
      if (!['none', 'percent', 'manual'].includes(mode)) mode = 'none';
      p.discountMode = mode;

      // buang field yang tak relevan dengan mode
      if (mode !== 'percent' && 'discountPercent' in p)
        delete p.discountPercent;
      if (mode !== 'manual' && 'manualPromoPrice' in p)
        delete p.manualPromoPrice;

      // koersi numerik
      if ('original' in p) p.original = toInt(p.original, 0);
      if ('discountPercent' in p)
        p.discountPercent = toInt(p.discountPercent, 0);
      if ('manualPromoPrice' in p)
        p.manualPromoPrice = toInt(p.manualPromoPrice, 0);
    }
  }

  /* ===== Addons (JSON string -> array) ===== */
  if ('addons' in req.body) {
    req.body.addons = parseMaybeJSON(req.body.addons, []);
    if (Array.isArray(req.body.addons)) {
      req.body.addons = req.body.addons
        .map((a) => {
          const name = String(a?.name || '').trim();
          const oldName = String(a?.oldName || '').trim(); // opsional, utk rename
          const shaped = {
            // pakai oldName sebagai key referensi kalau ada (rename case)
            ...(oldName ? { oldName } : {}),
            name, // nama baru (atau tetap)
            price: toInt(a?.price, 0)
          };
          // isActive: hanya set kalau dikirim, supaya tidak menimpa tanpa sengaja
          if (Object.prototype.hasOwnProperty.call(a, 'isActive')) {
            shaped.isActive = toBool(a.isActive, true);
          }
          return shaped;
        })
        .filter((a) => a.name || a.oldName); // minimal salah satu ada
    } else {
      req.body.addons = [];
    }
  }

  /* ===== Items (khusus paket) (JSON string -> array) ===== */
  if ('items' in req.body) {
    req.body.items = parseMaybeJSON(req.body.items, []);
    if (Array.isArray(req.body.items)) {
      req.body.items = req.body.items
        .map((it) => ({
          menu: it?.menu ? String(it.menu) : undefined, // ObjectId string
          name: it?.name ? String(it.name).trim() : undefined, // optional fallback
          qty: toInt(it?.qty, 1) || 1
        }))
        .filter((it) => it.menu || it.name);
    } else {
      req.body.items = [];
    }
  }

  next();
};
