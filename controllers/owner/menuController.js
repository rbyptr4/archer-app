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

const asId = (x) => new mongoose.Types.ObjectId(String(x));
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const toInt = (v, d = 0) => (Number.isFinite(+v) ? Math.trunc(+v) : d);

/* ---------- Helper: build package snapshot ---------- */
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

/* ====================== CREATE ====================== */
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
        addons: Array.isArray(addons) ? addons : [],
        packageItems: [],
        isActive: typeof isActive === 'boolean' ? isActive : true
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

/* ====================== UPDATE ====================== */
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

  if (payload.bigCategory && String(payload.bigCategory) === 'package') {
    throwError('Endpoint ini hanya untuk menu non-package', 400, 'bigCategory');
  }

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

  // normalize & guards
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
    // Jika bigCategory berubah dan subcategory tidak dikirim ulang → kosongkan agar aman
    payload.subcategory = null;
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

  // enforce non-package: packageItems harus kosong; addons tetap dipakai
  if (Array.isArray(payload.packageItems)) payload.packageItems = [];
  if (!Array.isArray(payload.addons)) payload.addons = current.addons;
  delete payload.packageBuilder; // kalau ada kiriman liar, dibuang

  // unique menu_code
  if (payload.menu_code) {
    const dup = await Menu.findOne({
      menu_code: payload.menu_code,
      _id: { $ne: id }
    }).lean();
    if (dup) throwError('Kode menu sudah digunakan', 409, 'menu_code');
  }

  const updated = await Menu.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true
  });
  if (!updated) throwError('Menu tidak ditemukan', 404);

  // cleanup file lama
  if (newFileId) {
    const oldId = extractDriveFileId(current.imageUrl);
    if (oldId) deleteFile(oldId).catch(() => {});
  }

  res.json({ success: true, message: 'Menu diperbarui', menu: updated });
});

/* ====================== DELETE ====================== */
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

  // sort by price.final via aggregation
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
                  then: { $toInt: { $ifNull: ['$price.manualPromoPrice', 0] } }
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
                                    { $ifNull: ['$price.discountPercent', 0] },
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

    const [items, total] = await Promise.all([
      Menu.aggregate(pipeline),
      Menu.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      data: items,
      paging: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  }

  // sorting biasa
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

/* ====================== GET BY ID ====================== */
// GET /menu/:id
exports.getMenuById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);
  const menu = await Menu.findById(id).lean({ virtuals: true });
  if (!menu) throwError('Menu tidak ditemukan', 404);

  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  if (!isBackoffice && !menu.isActive) throwError('Menu tidak ditemukan', 404);

  res.json({ success: true, data: menu });
});

/* ====================== ACTIVATE/DEACTIVATE ====================== */
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
