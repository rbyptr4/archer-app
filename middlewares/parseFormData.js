module.exports = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  const isMultipart = ct.includes('multipart/form-data');

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
  // Pastikan urutan router: multer -> normalizeBody -> handler.
  if (isMultipart && (req.body == null || typeof req.body !== 'object')) {
    return next();
  }

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
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on')
      return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'off')
      return false;
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

      if (mode !== 'percent' && hasOwn(p, 'discountPercent'))
        delete p.discountPercent;
      if (mode !== 'manual' && hasOwn(p, 'manualPromoPrice'))
        delete p.manualPromoPrice;

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
          menu: it?.menu ? String(it.menu) : undefined,
          name: it?.name ? String(it.name).trim() : undefined,
          qty: toInt(it?.qty, 1) || 1
        }))
        .filter((it) => it.menu || it.name);
    } else {
      req.body.items = [];
    }
  }

  /* ===== Addons (JSON string / object -> normalized array) ===== */
  if (hasOwn(req.body, 'addons')) {
    const raw = parseMaybeJSON(req.body.addons, []);
    let arr = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
      ? [raw]
      : [];
    arr = arr
      .map((a) => {
        if (!a || typeof a !== 'object') return null;
        const out = {};
        if ('name' in a) out.name = String(a.name || '').trim();
        if ('price' in a) out.price = toInt(a.price, 0);
        if ('isActive' in a) out.isActive = toBool(a.isActive, true);
        // juga dukung field is_active / is_active string kalau perlu:
        if (!('isActive' in a) && 'is_active' in a) {
          out.isActive = toBool(a.is_active, true);
        }
        return out;
      })
      .filter(Boolean)
      .filter((x) => x.name); // buang addon tanpa name
    req.body.addons = arr;
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
