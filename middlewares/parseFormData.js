// middlewares/normalizeBody.js
/* Middleware normalisasi body yang aman untuk multipart */
module.exports = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  const isMultipart = ct.includes('multipart/form-data');

  // --- DEBUG tipis: kelihatan kapan middleware ini jalan & tipe konten
  if (process.env.DEBUG_NORMALIZE === '1') {
    console.error('[normalizeBody] hit', {
      isMultipart,
      method: req.method,
      url: req.originalUrl,
      hasBody: !!req.body,
      bodyType: typeof req.body
    });
  }

  // Kalau multipart & body belum object (artinya multer belum jalan), JANGAN utak-atik.
  // Pastikan urutan router: parseFormData (multer) -> normalizeBody -> handler.
  if (isMultipart && (req.body == null || typeof req.body !== 'object')) {
    return next();
  }

  // Untuk non-multipart atau kalau body sudah object (pasca multer), pastikan object.
  if (req.body == null || typeof req.body !== 'object') {
    req.body = {};
  }

  /* ===== Helpers ===== */
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

  const hasOwn = (obj, key) =>
    obj &&
    typeof obj === 'object' &&
    Object.prototype.hasOwnProperty.call(obj, key);

  /* ===== Common flags ===== */
  if (hasOwn(req.body, 'isActive')) {
    req.body.isActive = toBool(req.body.isActive, true);
  }
  if (hasOwn(req.body, 'isRecommended')) {
    req.body.isRecommended = toBool(req.body.isRecommended, false);
  }

  /* ===== Price (JSON string -> object) + PRUNE sesuai mode ===== */
  if (hasOwn(req.body, 'price')) {
    const p = (req.body.price = parseMaybeJSON(req.body.price, {}));

    if (p && typeof p === 'object') {
      let mode = (p.discountMode || 'none').toString().toLowerCase();
      if (!['none', 'percent', 'manual'].includes(mode)) mode = 'none';
      p.discountMode = mode;

      // buang field yang tak relevan dengan mode
      if (mode !== 'percent' && hasOwn(p, 'discountPercent'))
        delete p.discountPercent;
      if (mode !== 'manual' && hasOwn(p, 'manualPromoPrice'))
        delete p.manualPromoPrice;

      // koersi numerik
      if (hasOwn(p, 'original')) p.original = toInt(p.original, 0);
      if (hasOwn(p, 'discountPercent'))
        p.discountPercent = toInt(p.discountPercent, 0);
      if (hasOwn(p, 'manualPromoPrice'))
        p.manualPromoPrice = toInt(p.manualPromoPrice, 0);
    }
  }

  /* ===== Items (khusus paket) (JSON string -> array) ===== */
  if (hasOwn(req.body, 'items')) {
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

  // --- DEBUG tipis: lihat keys yang ada setelah normalisasi
  if (process.env.DEBUG_NORMALIZE === '1') {
    try {
      const keys = Object.keys(req.body || {});
      console.error('[normalizeBody] done', { keys });
    } catch {}
  }

  next();
};
