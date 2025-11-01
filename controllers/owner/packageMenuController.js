// controllers/packageMenu.controller.js
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

/* ======================= Helpers kecil ======================= */
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const asId = (v) => new mongoose.Types.ObjectId(String(v));
const toInt = (v, d = 1) =>
  Number.isFinite(+v) ? Math.max(1, Math.trunc(+v)) : d;
const toNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const toBool = (v, d = false) =>
  typeof v === 'boolean' ? v : ['true', '1', 1, 'on', 'yes'].includes(v) || d;

const buildPrice = (raw = {}, fallback = {}) => ({
  original: toNum(raw.original ?? fallback.original ?? 0),
  discountMode: String(raw.discountMode ?? fallback.discountMode ?? 'none'),
  discountPercent: toNum(raw.discountPercent ?? fallback.discountPercent ?? 0),
  manualPromoPrice: toNum(
    raw.manualPromoPrice ?? fallback.manualPromoPrice ?? 0
  )
});

async function uploadMenuImageFromReqFile(file, code, name) {
  if (!file) return { fileId: null, imageUrl: '' };
  const folderId = getDriveFolder('menu');
  const desiredName = buildMenuFileName(
    code,
    name,
    file.originalname,
    file.mimetype
  );
  const uploaded = await uploadBuffer(
    file.buffer,
    desiredName,
    file.mimetype,
    folderId
  );
  const fileId = uploaded?.id || null;
  const imageUrl = fileId
    ? `https://drive.google.com/uc?export=view&id=${fileId}`
    : '';
  return { fileId, imageUrl };
}

/* ======================= Utils ======================= */
async function resolveSubcategoryId(subcategoryId, bigCategory) {
  if (!subcategoryId) return null;
  if (!isValidId(subcategoryId)) throwError('subcategoryId tidak valid', 400);
  const sub = await MenuSubcategory.findById(subcategoryId).lean();
  if (!sub) throwError('Subcategory tidak ditemukan', 404);
  if (String(sub.bigCategory) !== String(bigCategory))
    throwError('subcategory tidak sesuai dengan bigCategory', 400);
  return sub._id;
}

/**
 * items normalizer & hydrator:
 * Input:  array/object/string JSON dari FE berisi { menu|menuId|_id, name?, qty? }
 * Output: [{ menu, qty, nameSnapshot, priceSnapshot }]
 * - Hanya memperbolehkan komponen dari menu non-paket.
 * - Bisa matching by ID (prioritas) atau by name (fallback).
 */
async function normalizeItemsHydrate(rawItems = [], session = null) {
  // dukung string JSON
  let src = rawItems;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch {
      src = [];
    }
  }
  const cleaned = (Array.isArray(src) ? src : [])
    .map((it) => ({
      menuId: it.menuId || it.menu || it._id || null,
      name: String(it.name || '').trim(),
      qty: toInt(it.qty ?? it.quantity ?? 1, 1)
    }))
    .filter((it) => it.menuId || it.name);

  if (!cleaned.length) throwError('Paket butuh minimal 1 item', 400);

  // match-by-id (valid ObjectId) untuk akurasi
  const byId = cleaned.filter((x) => x.menuId && isValidId(x.menuId));
  const idMap = new Map();
  if (byId.length) {
    const ids = byId.map((x) => asId(x.menuId));
    const docs = await Menu.find({
      _id: { $in: ids },
      isActive: true,
      bigCategory: { $ne: 'package' } // komponen hanya dari menu non-paket
    })
      .session(session || null)
      .select('_id name price nameLower');
    docs.forEach((d) => idMap.set(String(d._id), d));
  }

  // sisanya fallback by name (case-insensitive) bila tersedia
  const needByName = cleaned.filter(
    (x) => !(x.menuId && isValidId(x.menuId)) && x.name
  );
  const nameMap = new Map();
  if (needByName.length) {
    const names = [
      ...new Set(needByName.map((x) => x.name.toLowerCase()).filter(Boolean))
    ];
    if (names.length) {
      const docs = await Menu.find({
        isActive: true,
        bigCategory: { $ne: 'package' },
        // pakai field nameLower kalau schema kamu punya; fallback regex jika tidak ada
        $or: [{ nameLower: { $in: names } }, { name: { $in: names } }]
      })
        .session(session || null)
        .select('_id name price nameLower');
      docs.forEach((d) =>
        nameMap.set(String(d.nameLower || d.name).toLowerCase(), d)
      );
    }
  }

  const hydrated = cleaned.map((x) => {
    let base = null;
    if (x.menuId && isValidId(x.menuId)) base = idMap.get(String(x.menuId));
    if (!base && x.name) base = nameMap.get(x.name.toLowerCase());
    if (!base) {
      throwError(
        `Item paket tidak valid/ tidak ditemukan: ${x.name || x.menuId}`,
        400
      );
    }
    const priceSnap = toNum(
      base?.price?.final ?? base?.price?.original ?? 0,
      0
    );
    return {
      menu: base._id,
      qty: x.qty,
      nameSnapshot: base.name,
      priceSnapshot: priceSnap
    };
  });

  return hydrated;
}

/* ======================= CREATE ======================= */
// POST /packages/create
exports.createPackageMenu = asyncHandler(async (req, res) => {
  const {
    menu_code,
    name,
    subcategoryId = null,
    isRecommended = false,
    description = '',
    price = {},
    items = [],
    isActive = true
  } = req.body || {};

  if (!menu_code || !name) throwError('Kode menu dan nama wajib diisi', 400);

  const session = await mongoose.startSession();
  let created;
  let uploadedFileId = null;

  try {
    await session.withTransaction(async () => {
      // lock unique code
      const code = String(menu_code).toUpperCase();
      const exists = await Menu.findOne({ menu_code: code })
        .session(session)
        .lean();
      if (exists) throwError('Kode menu sudah digunakan', 409, 'menu_code');

      // upload image (opsional) — dilakukan di dalam tx, cleanup bila gagal
      const img = await uploadMenuImageFromReqFile(req.file, code, name);
      uploadedFileId = img.fileId;

      // kunci kategori ke package
      const bigCategory = 'package';
      const subRef = await resolveSubcategoryId(subcategoryId, bigCategory);

      // hydrate items → hasil: {menu, qty, nameSnapshot, priceSnapshot}
      const packageItems = await normalizeItemsHydrate(items, session);

      const payload = {
        menu_code: code,
        name: String(name).trim(),
        bigCategory,
        subcategory: subRef,
        isRecommended: toBool(isRecommended, false),
        description: String(description || ''),
        imageUrl: img.imageUrl,
        price: buildPrice(price),
        addons: [], // paket tidak pakai addons
        packageItems,
        isActive: typeof isActive === 'boolean' ? isActive : true
      };

      const [doc] = await Menu.create([payload], { session });
      created = doc;
    });

    res.status(201).json({
      success: true,
      message: 'Paket berhasil dibuat',
      data: created
    });
  } catch (err) {
    // rollback file jika gagal
    if (uploadedFileId) deleteFile(uploadedFileId).catch(() => {});
    throw err;
  } finally {
    session.endSession();
  }
});

/* ======================= UPDATE ======================= */
// PATCH /packages/update/:id
exports.updatePackageMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const session = await mongoose.startSession();
  let newFileId = null;
  let oldFileIdForCleanup = null;
  let updated;

  // util kecil
  const isEmptyObject = (o) =>
    o &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    Object.keys(o).length === 0;

  const hasAnyPriceKey = (o = {}) => {
    const keys = [
      'base_price',
      'original',
      'final',
      'discountMode',
      'discountPercent',
      'discountValue',
      'currency',
      'mode' // jika Anda punya mode 'auto' / 'manual'
    ];
    return keys.some((k) => o[k] !== undefined);
  };

  try {
    await session.withTransaction(async () => {
      const current = await Menu.findById(id).session(session);
      if (!current) throwError('Paket tidak ditemukan', 404);
      if (String(current.bigCategory) !== 'package')
        throwError('Bukan menu paket', 400);

      const payload = { ...req.body };

      // kunci tetap package & kosongkan addons
      payload.bigCategory = 'package';
      if (Array.isArray(payload.addons)) payload.addons = [];

      // code uppercase & unique
      if (payload.menu_code) {
        payload.menu_code = String(payload.menu_code).toUpperCase();
        const dup = await Menu.findOne({
          menu_code: payload.menu_code,
          _id: { $ne: id }
        })
          .session(session)
          .lean();
        if (dup) throwError('Kode menu sudah digunakan', 409, 'menu_code');
      }

      // subcategory guard
      if (payload.subcategoryId) {
        payload.subcategory = await resolveSubcategoryId(
          payload.subcategoryId,
          'package'
        );
      }

      // items normalize bila dikirim
      if (payload.items !== undefined) {
        payload.packageItems = await normalizeItemsHydrate(
          payload.items,
          session
        );
        delete payload.items;
      }

      // ==== PERBAIKAN INTI: penanganan price ====
      if ('price' in payload) {
        // Kalau price tidak dikirim (null/undefined) atau object kosong, JANGAN ubah harga
        if (!payload.price || isEmptyObject(payload.price)) {
          delete payload.price;
        } else {
          // Merge parsial: pertahankan field lama yang tidak dikirim
          const prevPrice =
            current.price && typeof current.price.toObject === 'function'
              ? current.price.toObject()
              : current.price || {};
          const merged = { ...prevPrice, ...payload.price };

          // Jika ingin dukung mode auto dari items → set base_price dari packageItems
          const wantAuto = merged.mode === 'auto' || merged.auto === true; // sesuaikan dengan skema Anda
          if (wantAuto && (payload.packageItems || current.packageItems)) {
            const items = payload.packageItems || current.packageItems || [];
            const base = items.reduce((acc, it) => {
              const qty = Number(it.quantity ?? it.qty ?? 1);
              const p = Number(it.priceSnapshot ?? 0);
              return acc + qty * p;
            }, 0);
            merged.base_price = base;
          }

          // Normalisasi akhir harga
          // Catatan: jika buildPrice(prev, curr) → sesuaikan urutan.
          // Di code Anda semula: buildPrice(payload.price, current.price || {})
          // Untuk mencegah default 0, kita kirim hasil merge saja.
          payload.price = buildPrice(merged);
        }
      } else if (payload.packageItems) {
        // Jika price tidak dikirim tetapi packageItems diganti dan kita ingin auto,
        // Anda bisa aktifkan blok opsional ini:
        // const prevPrice = current.price && typeof current.price.toObject === 'function'
        //   ? current.price.toObject()
        //   : (current.price || {});
        // if (prevPrice.mode === 'auto' || prevPrice.auto === true) {
        //   const base = payload.packageItems.reduce((acc, it) => {
        //     const qty = Number(it.quantity ?? it.qty ?? 1);
        //     const p = Number(it.priceSnapshot ?? 0);
        //     return acc + qty * p;
        //   }, 0);
        //   payload.price = buildPrice({ ...prevPrice, base_price: base });
        // }
      }
      // ==== END PERBAIKAN INTI ====

      // image (opsional)
      if (req.file) {
        const finalCode = String(
          payload.menu_code || current.menu_code || ''
        ).toUpperCase();
        const finalName = String(payload.name || current.name || '');
        const img = await uploadMenuImageFromReqFile(
          req.file,
          finalCode,
          finalName
        );
        newFileId = img.fileId;
        payload.imageUrl = img.imageUrl;

        // tandai file lama untuk dibersihkan setelah commit sukses
        oldFileIdForCleanup = extractDriveFileId(current.imageUrl);
      }

      updated = await Menu.findByIdAndUpdate(id, payload, {
        new: true,
        runValidators: true,
        session
      });
      if (!updated) throwError('Paket tidak ditemukan', 404);
    });

    // cleanup file lama di luar transaksi
    if (oldFileIdForCleanup) deleteFile(oldFileIdForCleanup).catch(() => {});

    res.json({ success: true, message: 'Paket diperbarui', data: updated });
  } catch (err) {
    if (newFileId) deleteFile(newFileId).catch(() => {});
    throw err;
  } finally {
    session.endSession();
  }
});

/* ======================= GET/LIST/DELETE ======================= */
// GET /packages/:id
exports.getPackageMenuById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const doc = await Menu.findOne({ _id: id, bigCategory: 'package' }).lean({
    virtuals: true
  });
  if (!doc) throwError('Paket tidak ditemukan', 404);

  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  if (!isBackoffice && !doc.isActive) throwError('Paket tidak ditemukan', 404);

  res.json({ success: true, data: doc });
});

// GET /packages/list
// Query: q, subId, isActive, page, limit, sortBy(name|createdAt|price.original|isRecommended), sortDir(asc|desc)
exports.listPackageMenus = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || '20', 10), 1),
    100
  );
  const skip = (page - 1) * limit;

  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  const filter = { bigCategory: 'package' };
  if (!isBackoffice) filter.isActive = true;

  const q = String(req.query.q || '').trim();
  const subId = String(req.query.subId || '').trim();
  const isActiveParam = String(req.query.isActive || '').toLowerCase();
  const sortBy = String(req.query.sortBy || 'name');
  const sortDir =
    String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;

  if (q) {
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { menu_code: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } }
    ];
  }

  if (subId) {
    if (!isValidId(subId)) throwError('subId tidak valid', 400);
    filter.subcategory = asId(subId);
  }

  if (isActiveParam === 'true') filter.isActive = true;
  else if (isActiveParam === 'false') filter.isActive = false;

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

  const [items, total] = await Promise.all([
    Menu.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    Menu.countDocuments(filter)
  ]);

  res.json({
    success: true,
    data: items,
    paging: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
  });
});

// DELETE /packages/remove/:id
exports.deletePackageMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const session = await mongoose.startSession();
  let oldFileId = null;

  try {
    await session.withTransaction(async () => {
      const doc = await Menu.findOne({
        _id: id,
        bigCategory: 'package'
      }).session(session);
      if (!doc) throwError('Paket tidak ditemukan', 404);
      oldFileId = extractDriveFileId(doc.imageUrl);
      await Menu.deleteOne({ _id: id }, { session });
    });
  } finally {
    session.endSession();
  }

  if (oldFileId) deleteFile(oldFileId).catch(() => {});
  res.json({ success: true, message: 'Paket dihapus' });
});

// PATCH /packages/:id/activate
exports.activatePackageMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const doc = await Menu.findOneAndUpdate(
    { _id: id, bigCategory: 'package' },
    { $set: { isActive: true } },
    { new: true }
  );

  if (!doc) throwError('Paket tidak ditemukan', 404);
  res.json({ success: true, message: 'Paket diaktifkan', data: doc });
});

// PATCH /packages/:id/deactivate
exports.deactivatePackageMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const doc = await Menu.findOneAndUpdate(
    { _id: id, bigCategory: 'package' },
    { $set: { isActive: false } },
    { new: true }
  );

  if (!doc) throwError('Paket tidak ditemukan', 404);
  res.json({ success: true, message: 'Paket dinonaktifkan', data: doc });
});
