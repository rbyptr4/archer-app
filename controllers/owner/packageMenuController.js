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

const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const asId = (v) => new mongoose.Types.ObjectId(String(v));
const toInt = (v, d = 1) =>
  Number.isFinite(+v) ? Math.max(1, Math.trunc(+v)) : d;

/** ======================= Utils ======================= */
async function resolveSubcategoryId(subcategoryId, bigCategory) {
  if (!subcategoryId) return null;
  if (!isValidId(subcategoryId)) throwError('subcategoryId tidak valid', 400);
  const sub = await MenuSubcategory.findById(subcategoryId).lean();
  if (!sub) throwError('Subcategory tidak ditemukan', 404);
  if (String(sub.bigCategory) !== String(bigCategory))
    throwError('subcategory tidak sesuai dengan bigCategory', 400);
  return sub._id;
}

/** items normalizer: [{ menuId? | name, qty }] -> [{ menuId, name, qty }] */
async function normalizeItems(rawItems = []) {
  const cleaned = (Array.isArray(rawItems) ? rawItems : [])
    .map((it) => ({
      menuId: it.menuId || it.menu || null,
      name: (it.name || '').trim(),
      qty: toInt(it.qty, 1)
    }))
    .filter((it) => it.menuId || it.name);

  if (!cleaned.length) return [];

  // Cari berdasarkan ID dulu (cepat & akurat). Sisanya fallback by name (non-package).
  const byId = cleaned.filter((x) => x.menuId && isValidId(x.menuId));
  const idMap = new Map();
  if (byId.length) {
    const ids = byId.map((x) => asId(x.menuId));
    const docs = await Menu.find({
      _id: { $in: ids },
      isActive: true,
      bigCategory: { $ne: 'package' } // komponen hanya dari menu non-paket
    }).select('_id name');
    docs.forEach((d) => idMap.set(String(d._id), d));
  }

  // Untuk yang tidak punya ID valid, match by name (case-insensitive).
  const needByName = cleaned.filter((x) => !(x.menuId && isValidId(x.menuId)));
  const nameMap = new Map();
  if (needByName.length) {
    const names = [
      ...new Set(needByName.map((x) => x.name.toLowerCase()).filter(Boolean))
    ];
    if (names.length) {
      const docs = await Menu.find({
        nameLower: { $in: names },
        isActive: true,
        bigCategory: { $ne: 'package' }
      }).select('_id name nameLower');
      docs.forEach((d) => nameMap.set(String(d.nameLower), d));
    }
  }

  return cleaned.map((x) => {
    let base = null;
    if (x.menuId && isValidId(x.menuId)) base = idMap.get(String(x.menuId));
    if (!base && x.name) base = nameMap.get(x.name.toLowerCase());
    if (!base)
      throwError(
        `Item paket tidak valid/ tidak ditemukan: ${x.name || x.menuId}`,
        400
      );
    return { menuId: base._id, name: base.name, qty: x.qty };
  });
}

/** ======================= CREATE ======================= */
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
  let created;
  try {
    await session.withTransaction(async () => {
      // unique code
      const code = String(menu_code).toUpperCase();
      const exists = await Menu.findOne({ menu_code: code })
        .session(session)
        .lean();
      if (exists) throwError('Kode menu sudah digunakan', 409, 'menu_code');

      // subcategory resolve (dikunci ke "package")
      const bigCategory = 'package';
      const subRef = await resolveSubcategoryId(subcategoryId, bigCategory);

      // normalize items
      const packageItems = await normalizeItems(items);

      const payload = {
        menu_code: code,
        name: String(name).trim(),
        bigCategory,
        subcategory: subRef,
        isRecommended: !!isRecommended,
        description: String(description || ''),
        imageUrl,
        price: {
          original: Number(price.original || 0),
          discountMode: price.discountMode || 'none',
          discountPercent: Number(price.discountPercent || 0),
          manualPromoPrice: Number(price.manualPromoPrice || 0)
        },
        addons: [], // paket tidak pakai addons
        packageItems, // << hasil normalize
        isActive: typeof isActive === 'boolean' ? isActive : true
      };

      const [doc] = await Menu.create([payload], { session });
      created = doc;
    });

    res
      .status(201)
      .json({ success: true, message: 'Paket berhasil dibuat', data: created });
  } catch (err) {
    if (newFileId) deleteFile(newFileId).catch(() => {});
    throw err;
  } finally {
    session.endSession();
  }
});

/** ======================= UPDATE ======================= */
// PATCH /packages/update/:id
exports.updatePackageMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const current = await Menu.findById(id);
  if (!current) throwError('Paket tidak ditemukan', 404);
  if (String(current.bigCategory) !== 'package')
    throwError('Bukan menu paket', 400);

  const payload = { ...req.body };
  let newFileId = null;

  // image (opsional)
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

  // harden: paksa tetap paket & addons kosong
  payload.bigCategory = 'package';
  if (Array.isArray(payload.addons)) payload.addons = [];

  // code uppercase & unique
  if (payload.menu_code) {
    payload.menu_code = String(payload.menu_code).toUpperCase();
    const dup = await Menu.findOne({
      menu_code: payload.menu_code,
      _id: { $ne: id }
    }).lean();
    if (dup) throwError('Kode menu sudah digunakan', 409, 'menu_code');
  }

  // subcategory guard
  if (payload.subcategoryId) {
    payload.subcategory = await resolveSubcategoryId(
      payload.subcategoryId,
      'package'
    );
  }

  // price rebuild bila dikirim
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

  // items normalize (kalau dikirim)
  if (Array.isArray(payload.items)) {
    payload.packageItems = await normalizeItems(payload.items);
    delete payload.items;
  }

  const updated = await Menu.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true
  });
  if (!updated) throwError('Paket tidak ditemukan', 404);

  // hapus file lama jika ada upload baru
  if (newFileId) {
    const oldId = extractDriveFileId(current.imageUrl);
    if (oldId) deleteFile(oldId).catch(() => {});
  }

  res.json({ success: true, message: 'Paket diperbarui', data: updated });
});

/** ======================= GET/LIST/DELETE ======================= */
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

  const q = (req.query.q || '').trim();
  const subId = (req.query.subId || '').trim();
  const isActiveParam = (req.query.isActive || '').toLowerCase();
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
