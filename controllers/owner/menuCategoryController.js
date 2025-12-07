const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const {
  MenuSubcategory,
  BIG_CATEGORIES
} = require('../../models/menuSubcategoryModel.js');
const Menu = require('../../models/menuModel');
const throwError = require('../../utils/throwError');

const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const asInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

/* CREATE: POST /menu-categories/create */
exports.createSubcategory = asyncHandler(async (req, res) => {
  const { bigCategory, name, sortOrder = 0 } = req.body || {};
  if (!bigCategory || !name)
    throwError('bigCategory dan name wajib diisi', 400);
  if (!BIG_CATEGORIES.includes(String(bigCategory)))
    throwError('bigCategory tidak valid', 400);

  const doc = await MenuSubcategory.create({
    bigCategory,
    name,
    sortOrder: Number(sortOrder || 0)
  });

  res.status(201).json({ success: true, subcategory: doc });
});

exports.listSubcategories = asyncHandler(async (req, res) => {
  const big = (req.query.big || '').trim().toLowerCase();
  const q = (req.query.q || '').trim();
  const sortDir =
    String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  const limit = Math.min(Math.max(asInt(req.query.limit || 100, 100), 1), 500);
  const cursor = req.query.cursor;

  const filter = {};
  if (big) {
    if (!BIG_CATEGORIES.includes(big)) throwError('big tidak valid', 400);
    filter.bigCategory = big;
  }
  if (q) filter.$or = [{ name: { $regex: q, $options: 'i' } }];

  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) filter.createdAt = { $lt: d };
  }

  const items = await MenuSubcategory.find(filter)
    .sort({ sortOrder: sortDir, name: 1, _id: 1 })
    .limit(limit + 1)
    .lean();

  const total = await MenuSubcategory.countDocuments(filter);

  const rows = items.slice(0, limit);
  const next_cursor =
    items.length > limit && items[limit] && items[limit].createdAt
      ? new Date(items[limit].createdAt).toISOString()
      : null;

  res.json({
    limit,
    next_cursor,
    total,
    data: rows
  });
});

/* UPDATE: PATCH /menu-categories/update/:id */
exports.updateSubcategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const payload = { ...req.body };
  if (
    payload.bigCategory &&
    !BIG_CATEGORIES.includes(String(payload.bigCategory))
  ) {
    throwError('bigCategory tidak valid', 400);
  }
  // jaga nameLower saat rename (karena update validators tidak panggil pre('validate'))
  if (typeof payload.name === 'string') {
    payload.nameLower = String(payload.name).trim().toLowerCase();
  }

  const updated = await MenuSubcategory.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true
  });
  if (!updated) throwError('Subcategory tidak ditemukan', 404);

  res.json({ success: true, subcategory: updated });
});

/* DELETE: DELETE /menu-categories/remove/:id  (blokir jika dipakai menu) */
exports.deleteSubcategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) throwError('ID tidak valid', 400);

  const usedCount = await Menu.countDocuments({ subcategory: id });
  if (usedCount > 0) {
    throwError(
      409,
      `Tidak bisa menghapus: Subcategory sedang dipakai ${usedCount} menu.`
    );
  }

  await MenuSubcategory.deleteOne({ _id: id });
  res.json({ success: true, message: 'Subcategory dihapus' });
});
