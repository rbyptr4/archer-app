// controllers/menuController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Menu = require('../../models/menuModel');
const throwError = require('../../utils/throwError');
const { uploadBuffer, deleteFile } = require('../../utils/googleDrive');
const { getDriveFolder } = require('../../utils/driveFolders');
const { buildMenuFileName } = require('../../utils/makeFileName');
const { extractDriveFileId } = require('../../utils/driveFileId');

/* ====================== Utils ====================== */
const asId = (x) => new mongoose.Types.ObjectId(String(x));
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const truthy = (v) =>
  ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

/**
 * Build snapshot packageItems dari array { menuId, qty }
 * - Menggunakan Menu.makePackageItemFromMenu (final price snapshot)
 */
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
// Body fields utama:
//  - menu_code, name, category, description, price{original,discountMode,discountPercent,manualPromoPrice}, addons[]
//  - packageItems[] (snapshots langsung) ATAU packageBuilder: [{menuId, qty}]
//  - isActive (default true)
//  - file image: req.file (opsional, tapi disarankan diisi untuk gambar menu/paket)
exports.createMenu = asyncHandler(async (req, res) => {
  const {
    menu_code,
    name,
    category,
    description = '',
    price = {},
    addons = [],
    packageItems = [],
    packageBuilder = [],
    isActive = true
  } = req.body || {};

  if (!menu_code || !name || !category) {
    throwError('menu_code, name, dan category wajib diisi', 400);
  }

  // ==== Upload image terlebih dahulu (di luar transaksi) ====
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
      // Cek duplikat kode
      const exists = await Menu.findOne({
        menu_code: String(menu_code).toUpperCase()
      })
        .session(session)
        .lean();
      if (exists) throwError('Kode menu sudah digunakan', 409, 'menu_code');

      const payload = {
        menu_code: String(menu_code).toUpperCase(),
        name: String(name).trim(),
        category: String(category),
        description: String(description || ''),
        imageUrl: imageUrl || '', // boleh kosong, tapi sebaiknya diisi
        price: {
          original: Number(price.original || 0),
          discountMode: price.discountMode || 'none',
          discountPercent: Number(price.discountPercent || 0),
          manualPromoPrice: Number(price.manualPromoPrice || 0)
        },
        // Guard: addons hanya untuk non-package
        addons:
          String(category) === 'package'
            ? []
            : Array.isArray(addons)
            ? addons
            : [],
        // packageItems hanya untuk package
        packageItems:
          String(category) === 'package' && Array.isArray(packageItems)
            ? packageItems
            : [],
        isActive: typeof isActive === 'boolean' ? isActive : true
      };

      // Jika kategori package dan ada packageBuilder → build snapshot
      if (
        String(category) === 'package' &&
        Array.isArray(packageBuilder) &&
        packageBuilder.length
      ) {
        payload.packageItems = await buildPackageItemsFromIds(packageBuilder);
      }

      // NOTE: Auto-set price.original utk package bila 0 dilakukan juga di pre('validate') model
      const [doc] = await Menu.create([payload], { session });
      createdDoc = doc;
    });

    res.status(201).json({
      success: true,
      message: 'Menu berhasil dibuat',
      menu: createdDoc
    });
  } catch (err) {
    // Rollback file baru jika DB gagal
    if (newFileId) {
      try {
        await deleteFile(newFileId);
      } catch (e2) {
        console.warn(
          '[menu][rollback] gagal hapus file baru:',
          e2?.message || e2
        );
      }
    }
    throw err;
  } finally {
    session.endSession();
  }
});

exports.updateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const current = await Menu.findById(id);
  if (!current) throwError('Menu tidak ditemukan', 404);

  // ==== Upload gambar baru (opsional) sebelum transaksi ====
  let newFileId = null;
  const payload = { ...req.body };

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

  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      // Normalisasi & validasi dasar
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
      const newCategory = payload.category
        ? String(payload.category)
        : String(current.category);

      if (newCategory === 'package') {
        if (Array.isArray(payload.addons)) {
          payload.addons = []; // enforce
        }
        // packageItems via body
        if (!Array.isArray(payload.packageItems)) {
          // kalau tidak dikirim, jangan overwrite; biarkan seperti sebelumnya
          payload.packageItems = current.packageItems;
        }
        // atau packageBuilder → rebuild snapshot
        if (
          Array.isArray(payload.packageBuilder) &&
          payload.packageBuilder.length
        ) {
          payload.packageItems = await buildPackageItemsFromIds(
            payload.packageBuilder
          );
        }
      } else {
        // non-package
        if (Array.isArray(payload.packageItems)) {
          payload.packageItems = []; // enforce
        }
        // addons body boleh
        if (!Array.isArray(payload.addons)) {
          payload.addons = current.addons; // keep old if not provided
        }
      }

      // price: rebuild secara eksplisit bila dikirim
      if (payload.price) {
        payload.price = {
          original: Number(
            payload.price.original ?? current.price?.original ?? 0
          ),
          discountMode:
            payload.price.discountMode ?? current.price?.discountMode ?? 'none',
          discountPercent: Number(
            payload.price.discountPercent ?? current.price?.discountPercent ?? 0
          ),
          manualPromoPrice: Number(
            payload.price.manualPromoPrice ??
              current.price?.manualPromoPrice ??
              0
          )
        };
      }

      updated = await Menu.findByIdAndUpdate(id, payload, {
        new: true,
        runValidators: true,
        session
      });
      if (!updated) throwError('Menu tidak ditemukan', 404);
    });
  } catch (err) {
    // DB gagal → hapus file baru (rollback)
    if (newFileId) {
      try {
        await deleteFile(newFileId);
      } catch (e2) {
        console.warn(
          '[menu][rollback] gagal hapus file baru:',
          e2?.message || e2
        );
      }
    }
    throw err;
  } finally {
    session.endSession();
  }

  // Commit sukses → hapus file lama (best effort)
  if (newFileId) {
    const oldId = extractDriveFileId(current.imageUrl);
    if (oldId) {
      deleteFile(oldId).catch((e) =>
        console.warn('[menu] gagal hapus file lama:', e?.message || e)
      );
    }
  }

  res.json({ success: true, message: 'Menu diperbarui', menu: updated });
});

/* ====================== DELETE ====================== */
// DELETE /menu/remove/:id
exports.deleteMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;

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

  // Setelah commit, hapus file di Drive (best effort)
  if (oldFileId) {
    deleteFile(oldFileId).catch((e) =>
      console.warn('[menu] gagal hapus file di GDrive:', e?.message || e)
    );
  }

  res.json({ success: true, message: 'Menu dihapus' });
});

/* ====================== LIST ====================== */
// GET /menu/list
// Query:
//  - q: text search (name/menu_code/description via $text kalau mau), fallback regex
//  - category: filter kategori
//  - isActive: true/false
//  - page, limit
//  - sortBy: name | createdAt | price.final | price.original
//  - sortDir: asc|desc
exports.listMenus = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || '20', 10), 1),
    100
  );
  const isBackoffice =
    !!req.user && ['owner', 'employee'].includes(req.user.role);
  if (!isBackoffice) {
    req.query.isActive = 'true'; // paksa filter hanya aktif
  }
  const skip = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const sortBy = String(req.query.sortBy || 'name');
  const sortDir =
    String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;

  const isActiveParam = (req.query.isActive || '').toLowerCase();
  const filter = {};

  if (q) {
    // gunakan $text jika ada index text, fallback regex
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { menu_code: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } }
    ];
  }

  if (category) filter.category = category;

  if (isActiveParam === 'true') filter.isActive = true;
  else if (isActiveParam === 'false') filter.isActive = false;

  // Sorting by price.final perlu aggregation
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
      { $sort: { price_final: sortDir, name: 1, _id: 1 } },
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
      paging: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });
  }

  // Sorting biasa
  const sort = {};
  if (['name', 'createdAt', 'updatedAt', 'price.original'].includes(sortBy)) {
    sort[sortBy] = sortDir;
  } else {
    sort['name'] = 1;
  }

  const [items, total] = await Promise.all([
    // gunakan lean({ virtuals: true }) bila mongoose >= 7 agar price.final ikut
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
    paging: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1
    }
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
  if (!isBackoffice && !menu.isActive) {
    return throwError('Menu tidak ditemukan', 404);
  }
  res.json({ success: true, data: menu });
});

/* ====================== ACTIVATE/DEACTIVATE ====================== */
// PATCH /menu/:id/activate-menu
exports.activateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updated = await Menu.findByIdAndUpdate(
    id,
    { $set: { isActive: true } },
    { new: true }
  );
  if (!updated) throwError('Menu tidak ditemukan', 404);
  res.json({ success: true, message: 'Menu diaktifkan', menu: updated });
});

// PATCH /menu/:id/deactivate-menu
exports.deactivateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updated = await Menu.findByIdAndUpdate(
    id,
    { $set: { isActive: false } },
    { new: true }
  );
  if (!updated) throwError('Menu tidak ditemukan', 404);
  res.json({ success: true, message: 'Menu dinonaktifkan', menu: updated });
});
