const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Menu = require('../../models/menuModel');
const {
  MenuSubcategory,
  BIG_CATEGORIES
} = require('../../models/menuSubcategoryModel.js');
const throwError = require('../../utils/throwError');
const { uploadBuffer, deleteFile } = require('../../utils/googleDrive');
const { getDriveFolder } = require('../../utils/driveFolders');
const { buildMenuFileName } = require('../../utils/makeFileName');
const { extractDriveFileId } = require('../../utils/driveFileId');
const { parsePpnRate } = require('../../utils/money');

/* ========== Utils dasar ========== */
const asId = (x) => new mongoose.Types.ObjectId(String(x));
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const toInt = (v, d = 0) => (Number.isFinite(+v) ? Math.trunc(+v) : d);
const asArray = (v) =>
  Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
const asInt = (v, def = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : def;
};
const parseMaybeJson = (v, fallback) => {
  if (Array.isArray(v) || (v && typeof v === 'object')) return v;
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

const toBool = (v, def = true) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  }
  return def;
};

/* ========== Helper addons ========== */
const sanitizeNewAddon = (a = {}) => ({
  name: String(a?.name || '').trim(),
  price: Math.round(Number(a?.price || 0)),
  isActive: a?.isActive !== undefined ? toBool(a.isActive, true) : true
});

const sanitizePatchAddon = (a = {}) => {
  const out = {};
  if (a.name !== undefined) out.name = String(a.name).trim();
  if (a.price !== undefined) out.price = Math.round(Number(a.price || 0));
  if (a.isActive !== undefined) out.isActive = toBool(a.isActive, true);
  return out;
};

/* ---------- Helper: build package snapshot (dipakai di controller paket) ---------- */
async function buildPackageItemsFromIds(items = []) {
  const cleaned = (items || [])
    .map((it) => ({
      menuId: String(it.menuId || it.menu || ''),
      qty: toInt(it.qty, 1) || 1
    }))
    .filter((it) => isValidId(it.menuId));
  if (!cleaned.length) return [];

  const ids = cleaned.map((it) => asId(it.menuId));
  const docs = await Menu.find({ _id: { $in: ids }, isActive: true }).select(
    '_id name price'
  );
  const mapDoc = new Map(docs.map((d) => [String(d._id), d]));

  return cleaned.map(({ menuId, qty }) => {
    const base = mapDoc.get(String(menuId));
    if (!base) throw new Error(`Menu tidak ditemukan / non-aktif: ${menuId}`);
    return Menu.makePackageItemFromMenu(base, qty);
  });
}

/* ========== CREATE (non-package) ========== */
// POST /menu/create-menu
exports.createMenu = asyncHandler(async (req, res) => {
  const {
    menu_code,
    name,
    bigCategory,
    subcategoryId,
    isRecommended = false,
    description = '',
    price = {},
    addons = [],
    isActive = true
  } = req.body || {};

  if (!menu_code || !name || !bigCategory) {
    throwError('menu_code, name, dan bigCategory wajib diisi', 400);
  }
  if (!BIG_CATEGORIES.includes(String(bigCategory))) {
    throwError('bigCategory tidak valid', 400);
  }
  if (String(bigCategory) === 'package') {
    throwError('Endpoint ini hanya untuk menu non-package', 400, 'bigCategory');
  }

  // Validasi subcategory opsional & konsistensi bigCategory
  let subRef = null;
  if (subcategoryId) {
    if (!isValidId(subcategoryId)) throwError('subcategoryId tidak valid', 400);
    const sub = await MenuSubcategory.findById(subcategoryId).lean();
    if (!sub) throwError('Subcategory tidak ditemukan', 404);
    if (String(sub.bigCategory) !== String(bigCategory)) {
      throwError('subcategory tidak sesuai dengan bigCategory', 400);
    }
    subRef = sub._id;
  }

  // Upload image (opsional)
  let newFileId = null;
  let imageUrl = '';
  if (req.file) {
    const folderId = getDriveFolder('menu');
    const desiredName = buildMenuFileName(
      menu_code,
      name,
      req.file.originalname,
      req.file.mimetype
    );
    const uploaded = await uploadBuffer(
      req.file.buffer,
      desiredName,
      req.file.mimetype,
      folderId
    );
    newFileId = uploaded.id;
    imageUrl = `https://drive.google.com/uc?export=view&id=${newFileId}`;
  }

  const session = await mongoose.startSession();
  let createdDoc;
  try {
    await session.withTransaction(async () => {
      const code = String(menu_code).toUpperCase();
      const exists = await Menu.findOne({ menu_code: code })
        .session(session)
        .lean();
      if (exists) throwError('Kode menu sudah digunakan', 409, 'menu_code');

      const addonsSrc = Array.isArray(addons)
        ? addons
        : parseMaybeJson(addons, []); // parseMaybeJson ada di file controller
      const addonsNorm = Array.isArray(addonsSrc)
        ? addonsSrc.map(sanitizeNewAddon).filter((x) => x.name)
        : [];

      const payload = {
        menu_code: code,
        name: String(name).trim(),
        bigCategory: String(bigCategory),
        subcategory: subRef,
        isRecommended: Boolean(isRecommended),
        description: String(description || ''),
        imageUrl: imageUrl || '',
        price: {
          original: Number(price.original || 0),
          discountMode: price.discountMode || 'none',
          discountPercent: Number(price.discountPercent || 0),
          manualPromoPrice: Number(price.manualPromoPrice || 0)
        },
        addons: addonsNorm, // _id akan di-generate otomatis oleh Mongoose
        packageItems: [],
        isActive:
          typeof isActive === 'boolean' ? isActive : toBool(isActive, true)
      };

      const [doc] = await Menu.create([payload], { session });
      createdDoc = doc;
    });

    res.status(201).json({
      success: true,
      message: 'Menu berhasil dibuat',
      menu: createdDoc
    });
  } catch (err) {
    if (newFileId) deleteFile(newFileId).catch(() => {});
    throw err;
  } finally {
    session.endSession();
  }
});

/* ========== UPDATE (non-package) ========== */
exports.updateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const current = await Menu.findById(id);
  if (!current) throwError('Menu tidak ditemukan', 404);
  if (String(current.bigCategory) === 'package') {
    throwError('Menu ini bertipe package. Gunakan endpoint paket.', 400);
  }

  let newFileId = null;
  const payload = { ...req.body };

  // Hanya untuk non-package
  if (payload.bigCategory && String(payload.bigCategory) === 'package') {
    throwError('Endpoint ini hanya untuk menu non-package', 400, 'bigCategory');
  }

  /* ===== Upload image (opsional) ===== */
  if (req.file) {
    const folderId = getDriveFolder('menu');
    const finalCode = String(
      payload.menu_code || current.menu_code || ''
    ).toUpperCase();
    const finalName = String(payload.name || current.name || '');
    const desiredName = buildMenuFileName(
      finalCode,
      finalName,
      req.file.originalname,
      req.file.mimetype
    );

    const uploaded = await uploadBuffer(
      req.file.buffer,
      desiredName,
      req.file.mimetype,
      folderId
    );
    newFileId = uploaded.id;
    payload.imageUrl = `https://drive.google.com/uc?export=view&id=${newFileId}`;
  }

  /* ===== Normalisasi dan validasi dasar ===== */
  if (payload.menu_code)
    payload.menu_code = String(payload.menu_code).toUpperCase();

  if (
    payload.bigCategory &&
    !BIG_CATEGORIES.includes(String(payload.bigCategory))
  ) {
    throwError('bigCategory tidak valid', 400);
  }

  const nextBig = String(payload.bigCategory || current.bigCategory);
  if (payload.subcategoryId) {
    if (!isValidId(payload.subcategoryId))
      throwError('subcategoryId tidak valid', 400);
    const sub = await MenuSubcategory.findById(payload.subcategoryId).lean();
    if (!sub) throwError('Subcategory tidak ditemukan', 404);
    if (String(sub.bigCategory) !== nextBig) {
      throwError('subcategory tidak sesuai dengan bigCategory', 400);
    }
    payload.subcategory = sub._id;
  } else if (payload.bigCategory && nextBig !== String(current.bigCategory)) {
    payload.subcategory = null; // reset jika category berubah
  }

  /* ===== Price rebuild bila dikirim ===== */
  if (payload.price) {
    payload.price = {
      original: Number(payload.price.original ?? current.price?.original ?? 0),
      discountMode:
        payload.price.discountMode ?? current.price?.discountMode ?? 'none',
      discountPercent: Number(
        payload.price.discountPercent ?? current.price?.discountPercent ?? 0
      ),
      manualPromoPrice: Number(
        payload.price.manualPromoPrice ?? current.price?.manualPromoPrice ?? 0
      )
    };
  }

  // pastikan packageItems tidak ikut diubah dari endpoint ini
  if (Array.isArray(payload.packageItems)) delete payload.packageItems;

  // addons juga diabaikan di endpoint ini
  if (payload.addons !== undefined) delete payload.addons;

  /* ===== Validasi duplikat kode menu ===== */
  if (payload.menu_code) {
    const dup = await Menu.findOne({
      menu_code: payload.menu_code,
      _id: { $ne: id }
    }).lean();
    if (dup) throwError('Kode menu sudah digunakan', 409, 'menu_code');
  }

  /* ===== Update dokumen utama ===== */
  const updated = await Menu.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true
  });
  if (!updated) throwError('Menu tidak ditemukan', 404);

  /* ===== Bersihkan file lama jika ada upload baru ===== */
  if (newFileId) {
    const oldId = extractDriveFileId(current.imageUrl);
    if (oldId) deleteFile(oldId).catch(() => {});
  }

  /* ===== Kembalikan dokumen akhir ===== */
  const finalDoc = await Menu.findById(id).lean({ virtuals: true });
  res.json({ success: true, message: 'Menu diperbarui', menu: finalDoc });
});

/* ========== DELETE MENU ========== */
// DELETE /menu/remove/:id
exports.deleteMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const session = await mongoose.startSession();
  let oldFileId = null;
  try {
    await session.withTransaction(async () => {
      const doc = await Menu.findById(id).session(session);
      if (!doc) throwError('Menu tidak ditemukan', 404);
      oldFileId = extractDriveFileId(doc.imageUrl);
      await Menu.deleteOne({ _id: id }, { session });
    });
  } finally {
    session.endSession();
  }

  if (oldFileId) deleteFile(oldFileId).catch(() => {});
  res.json({ success: true, message: 'Menu dihapus' });
});

/* ========== LIST MENUS ========== */
exports.listMenuForMember = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || '20', 10), 1),
    100
  );

  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  if (!isBackoffice) req.query.isActive = 'true';

  const skip = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const big = (req.query.big || '').trim().toLowerCase();
  const subId = (req.query.subId || '').trim();
  const subName = (req.query.subName || '').trim();
  const recommendedParam = (req.query.recommended || '').toLowerCase();

  const sortBy = String(req.query.sortBy || 'name');
  const sortDir =
    String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;

  const isActiveParam = (req.query.isActive || '').toLowerCase();
  const filter = {};

  // ===== Helper lokal =====
  const calcFinalPrice = (price = {}) => {
    const original = Number(price.original || 0);
    const mode = price.discountMode || 'none';
    const discPercent = Number(price.discountPercent || 0);
    const manualPromo = Number(price.manualPromoPrice || 0);

    if (mode === 'manual' && manualPromo > 0) {
      return manualPromo;
    }

    if (mode === 'percent' && discPercent > 0 && discPercent < 100) {
      const after = original * (1 - discPercent / 100);
      return Math.round(after);
    }

    return original;
  };

  const ppnRateRaw = typeof parsePpnRate === 'function' ? parsePpnRate() : 0.11; // fallback kalau util nggak kepasang
  const ppnRate =
    Number.isFinite(ppnRateRaw) && ppnRateRaw >= 0 ? ppnRateRaw : 0.11;

  const attachDisplayPrices = (items) =>
    items.map((m) => {
      // kalau pipeline sortBy=price.final sudah punya price_final
      const baseFinal =
        typeof m.price_final === 'number'
          ? m.price_final
          : calcFinalPrice(m.price);

      const taxAmount = Math.round(Math.max(0, baseFinal * ppnRate));
      const priceWithTax = baseFinal + taxAmount;

      return {
        ...m,
        price_final: baseFinal,
        price_with_tax: priceWithTax
      };
    });

  // ===== Pencarian =====
  if (q) {
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { menu_code: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } }
    ];
  }

  if (big) {
    if (!BIG_CATEGORIES.includes(big)) throwError('big tidak valid', 400);
    filter.bigCategory = big;
  }

  if (recommendedParam === 'true') filter.isRecommended = true;
  else if (recommendedParam === 'false') filter.isRecommended = false;

  if (isActiveParam === 'true') filter.isActive = true;
  else if (isActiveParam === 'false') filter.isActive = false;

  // subcategory filter
  if (subId) {
    if (!isValidId(subId)) throwError('subId tidak valid', 400);
    filter.subcategory = asId(subId);
  } else if (subName) {
    const cond = { nameLower: subName.toLowerCase() };
    if (filter.bigCategory) cond.bigCategory = filter.bigCategory;
    const sub = await MenuSubcategory.findOne(cond).select('_id').lean();
    if (!sub) {
      return res.json({
        success: true,
        data: [],
        paging: { page, limit, total: 0, pages: 1 }
      });
    }
    filter.subcategory = sub._id;
  }

  // ===== Sort by price.final via aggregation =====
  if (sortBy === 'price.final') {
    const pipeline = [
      { $match: filter },
      {
        $addFields: {
          price_final: {
            $switch: {
              branches: [
                {
                  case: { $eq: ['$price.discountMode', 'manual'] },
                  then: {
                    $toInt: {
                      $ifNull: ['$price.manualPromoPrice', '$price.original']
                    }
                  }
                },
                {
                  case: { $eq: ['$price.discountMode', 'percent'] },
                  then: {
                    $toInt: {
                      $round: [
                        {
                          $multiply: [
                            { $ifNull: ['$price.original', 0] },
                            {
                              $subtract: [
                                1,
                                {
                                  $divide: [
                                    {
                                      $ifNull: ['$price.discountPercent', 0]
                                    },
                                    100
                                  ]
                                }
                              ]
                            }
                          ]
                        },
                        0
                      ]
                    }
                  }
                }
              ],
              default: { $toInt: { $ifNull: ['$price.original', 0] } }
            }
          }
        }
      },
      { $sort: { price_final: sortDir, isRecommended: -1, name: 1, _id: 1 } },
      { $skip: skip },
      { $limit: limit }
    ];

    const [rawItems, total] = await Promise.all([
      Menu.aggregate(pipeline),
      Menu.countDocuments(filter)
    ]);

    const items = attachDisplayPrices(rawItems);

    return res.json({
      success: true,
      data: items,
      paging: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  }

  // ===== Sorting biasa =====
  const sort = {};
  if (
    [
      'name',
      'createdAt',
      'updatedAt',
      'price.original',
      'isRecommended'
    ].includes(sortBy)
  ) {
    sort[sortBy] = sortDir;
  } else {
    sort['name'] = 1;
  }

  const [rawItems, total] = await Promise.all([
    Menu.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    Menu.countDocuments(filter)
  ]);

  const items = attachDisplayPrices(rawItems);

  res.json({
    success: true,
    data: items,
    paging: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
  });
});

exports.listMenus = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || '20', 10), 1),
    100
  );

  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  if (!isBackoffice) req.query.isActive = 'true';

  const skip = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const big = (req.query.big || '').trim().toLowerCase();
  const subId = (req.query.subId || '').trim();
  const subName = (req.query.subName || '').trim();
  const recommendedParam = (req.query.recommended || '').toLowerCase();

  const sortBy = String(req.query.sortBy || 'name');
  const sortDir =
    String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;

  const isActiveParam = (req.query.isActive || '').toLowerCase();
  const filter = {};

  /* ===== Helper harga ===== */
  const calcFinalPrice = (price = {}) => {
    const original = Number(price.original || 0);
    const mode = price.discountMode || 'none';
    const discPercent = Number(price.discountPercent || 0);
    const manualPromo = Number(price.manualPromoPrice || 0);

    if (mode === 'manual' && manualPromo > 0) {
      return manualPromo;
    }

    if (mode === 'percent' && discPercent > 0 && discPercent < 100) {
      const after = original * (1 - discPercent / 100);
      return Math.round(after);
    }

    return original;
  };

  const ppnRateRaw = typeof parsePpnRate === 'function' ? parsePpnRate() : 0.11;
  const ppnRate =
    Number.isFinite(ppnRateRaw) && ppnRateRaw >= 0 ? ppnRateRaw : 0.11;

  const attachDisplayPrices = (items) =>
    items.map((m) => {
      const baseFinal =
        typeof m.price_final === 'number'
          ? m.price_final
          : calcFinalPrice(m.price || {});

      const taxAmount = Math.round(Math.max(0, baseFinal * ppnRate));
      const priceWithTax = baseFinal + taxAmount;

      return {
        ...m,
        price_final: baseFinal,
        price_with_tax: priceWithTax
      };
    });

  /* ====== SEARCH (q) ====== */
  if (q) {
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { menu_code: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } }
    ];
  }

  /* ====== EXCLUDE PACKAGE BY DEFAULT ====== */
  let selectedBig = '';
  if (big) {
    if (!BIG_CATEGORIES.includes(big)) throwError('big tidak valid', 400);
    if (big === 'package') {
      // Endpoint ini khusus non-package
      throwError('Endpoint ini hanya untuk menu non-package', 400, 'big');
    }
    selectedBig = big;
    filter.bigCategory = selectedBig;
  } else {
    // Tidak memilih big => exclude package
    filter.bigCategory = { $ne: 'package' };
  }

  /* ====== FLAG-FLAG LAIN ====== */
  if (recommendedParam === 'true') filter.isRecommended = true;
  else if (recommendedParam === 'false') filter.isRecommended = false;

  if (isActiveParam === 'true') filter.isActive = true;
  else if (isActiveParam === 'false') filter.isActive = false;

  /* ====== SUBCATEGORY FILTER ====== */
  if (subId) {
    if (!isValidId(subId)) throwError('subId tidak valid', 400);
    filter.subcategory = asId(subId);
  } else if (subName) {
    const cond = { nameLower: subName.toLowerCase() };
    if (selectedBig) cond.bigCategory = selectedBig;

    const sub = await MenuSubcategory.findOne(cond).select('_id').lean();
    if (!sub) {
      return res.json({
        success: true,
        data: [],
        paging: { page, limit, total: 0, pages: 1 }
      });
    }
    filter.subcategory = sub._id;
  }

  /* ====== SORTING: price.final pakai aggregate ====== */
  if (sortBy === 'price.final') {
    const pipeline = [
      { $match: filter },
      {
        $addFields: {
          price_final: {
            $switch: {
              branches: [
                {
                  case: { $eq: ['$price.discountMode', 'manual'] },
                  then: {
                    $toInt: {
                      $ifNull: ['$price.manualPromoPrice', '$price.original']
                    }
                  }
                },
                {
                  case: { $eq: ['$price.discountMode', 'percent'] },
                  then: {
                    $toInt: {
                      $round: [
                        {
                          $multiply: [
                            { $ifNull: ['$price.original', 0] },
                            {
                              $subtract: [
                                1,
                                {
                                  $divide: [
                                    {
                                      $ifNull: ['$price.discountPercent', 0]
                                    },
                                    100
                                  ]
                                }
                              ]
                            }
                          ]
                        },
                        0
                      ]
                    }
                  }
                }
              ],
              default: { $toInt: { $ifNull: ['$price.original', 0] } }
            }
          }
        }
      },
      { $sort: { price_final: sortDir, isRecommended: -1, name: 1, _id: 1 } },
      { $skip: skip },
      { $limit: limit }
    ];

    const [rawItems, total] = await Promise.all([
      Menu.aggregate(pipeline),
      Menu.countDocuments(filter)
    ]);

    const items = attachDisplayPrices(rawItems);

    return res.json({
      success: true,
      data: items,
      paging: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  }

  /* ====== SORTING biasa ====== */
  const sort = {};
  if (
    [
      'name',
      'createdAt',
      'updatedAt',
      'price.original',
      'isRecommended'
    ].includes(sortBy)
  ) {
    sort[sortBy] = sortDir;
  } else {
    sort['name'] = 1;
  }

  const [rawItems, total] = await Promise.all([
    Menu.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    Menu.countDocuments(filter)
  ]);

  const items = attachDisplayPrices(rawItems);

  res.json({
    success: true,
    data: items,
    paging: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
  });
});

exports.getMenuById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  // populate subcategory agar response berisi objek (bukan hanya id)
  const menu = await Menu.findById(id)
    .populate({ path: 'subcategory', select: '_id name bigCategory' })
    .lean({ virtuals: true });

  if (!menu) throwError('Menu tidak ditemukan', 404);

  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  if (!isBackoffice && !menu.isActive) throwError('Menu tidak ditemukan', 404);

  // ===== Helper kecil (konsisten dg listMenuForMember) =====
  const calcFinalPrice = (price = {}) => {
    const original = Number(price.original || 0);
    const mode = price.discountMode || 'none';
    const discPercent = Number(price.discountPercent || 0);
    const manualPromo = Number(price.manualPromoPrice || 0);

    if (mode === 'manual' && manualPromo > 0) return manualPromo;
    if (mode === 'percent' && discPercent > 0 && discPercent < 100) {
      return Math.round(original * (1 - discPercent / 100));
    }
    return original;
  };

  const ppnRateRaw = typeof parsePpnRate === 'function' ? parsePpnRate() : 0.11;
  const ppnRate =
    Number.isFinite(ppnRateRaw) && ppnRateRaw >= 0 ? ppnRateRaw : 0.11;

  const price_final = calcFinalPrice(menu.price);
  const taxAmount = Math.round(Math.max(0, price_final * ppnRate));
  const price_with_tax = price_final + taxAmount;

  res.json({
    success: true,
    data: {
      ...menu,
      price_final,
      price_with_tax
    }
  });
});

exports.activateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);
  const updated = await Menu.findByIdAndUpdate(
    id,
    { $set: { isActive: true } },
    { new: true }
  );
  if (!updated) throwError('Menu tidak ditemukan', 404);
  res.json({ success: true, message: 'Menu diaktifkan', menu: updated });
});

exports.deactivateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);
  const updated = await Menu.findByIdAndUpdate(
    id,
    { $set: { isActive: false } },
    { new: true }
  );
  if (!updated) throwError('Menu tidak ditemukan', 404);
  res.json({ success: true, message: 'Menu dinonaktifkan', menu: updated });
});

exports.subcategoryOptions = asyncHandler(async (req, res) => {
  const cat = String(req.query.cat || '')
    .trim()
    .toLowerCase();
  if (!cat) throwError('Parameter cat wajib diisi', 400);
  if (!BIG_CATEGORIES.includes(cat)) throwError('Kategori tidak valid', 400);

  const q = (req.query.q || '').trim();
  const sortDir =
    String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;

  const filter = { bigCategory: cat };
  if (q) {
    filter.nameLower = { $regex: q.toLowerCase(), $options: 'i' };
  }

  const items = await MenuSubcategory.find(filter)
    .select('_id name sortOrder')
    .sort({ sortOrder: sortDir, name: 1, _id: 1 })
    .lean();

  res.json({ success: true, data: items });
});

// POST /menu/:id/addons
exports.addAddon = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, price, isActive } = req.body || {};
  if (!isValidId(id)) throwError('ID tidak valid', 400);
  const addon = {
    name: String(name || '').trim(),
    price: Math.round(Number(price || 0)),
    isActive: isActive === undefined ? true : toBool(isActive, true)
  };
  if (!addon.name) throwError('Nama addon wajib diisi', 400);

  await Menu.updateOne({ _id: id }, { $push: { addons: addon } });
  const after = await Menu.findById(id).select('addons').lean();
  res
    .status(201)
    .json({ success: true, message: 'Addon ditambahkan', data: after.addons });
});

exports.batchUpdateAddons = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // ===== Helpers =====
  const asArray = (v) =>
    Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  const asInt = (v, def = 0) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : def;
  };

  let itemsRaw = req.body?.items ?? req.body?.addons ?? req.body;
  let items = asArray(itemsRaw);

  if (!isValidId(id)) throwError('ID menu tidak valid', 400);
  if (!items.length) {
    throwError(
      'Payload tidak valid (gunakan array langsung, atau {items:[...]} / {addons:[...]})',
      400
    );
  }

  const ops = [];
  for (const a of items) {
    if (!a || !a._id || !isValidId(a._id)) continue;

    const patch = {};
    let hasChange = false;

    if (a.name !== undefined) {
      patch['addons.$.name'] = String(a.name ?? '').trim();
      hasChange = true;
    }
    if (a.price !== undefined) {
      let p = asInt(a.price, 0);
      if (p < 0) p = 0;
      const MAX_PRICE = 50_000_000;
      if (p > MAX_PRICE) p = MAX_PRICE;
      patch['addons.$.price'] = p;
      hasChange = true;
    }
    if (a.isActive !== undefined) {
      patch['addons.$.isActive'] = toBool(a.isActive, true);
      hasChange = true;
    }

    if (!hasChange) continue;

    ops.push({
      updateOne: {
        filter: { _id: id, 'addons._id': a._id },
        update: { $set: patch }
      }
    });
  }

  if (!ops.length) {
    throwError('Tidak ada data addon valid untuk diupdate', 400);
  }

  await Menu.bulkWrite(ops);
  const menu = await Menu.findById(id).select('addons').lean();

  res.json({
    success: true,
    message: `Beberapa addon berhasil diupdate (${ops.length} perubahan)`,
    data: menu?.addons || []
  });
});

// DELETE /menu/:id/addons/:addonId
exports.deleteAddon = asyncHandler(async (req, res) => {
  const { id, addonId } = req.params;
  if (!isValidId(id) || !isValidId(addonId)) throwError('ID tidak valid', 400);
  const r = await Menu.updateOne(
    { _id: id },
    { $pull: { addons: { _id: addonId } } }
  );
  if (r.modifiedCount === 0) throwError('Menu/addon tidak ditemukan', 404);
  res.json({ success: true, message: 'Addon dihapus' });
});
