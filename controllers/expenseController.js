const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Expense = require('../models/expenseModel');
const ExpenseType = require('../models/expenseTypeModel');
const throwError = require('../utils/throwError');
const { parsePeriod } = require('../utils/periodRange');

/* =========================
 * ===== EXPENSE TYPE ======
 * ========================= */
exports.createType = asyncHandler(async (req, res) => {
  const { name, description, isActive } = req.body || {};
  if (!name?.trim()) throwError('Nama jenis pengeluaran wajib diisi', 400);

  const exists = await ExpenseType.exists({ name: name.trim() });
  if (exists) throwError('Nama jenis sudah digunakan', 409);

  const doc = await ExpenseType.create({
    name: name.trim(),
    description: description || '',
    isActive: typeof isActive === 'boolean' ? isActive : true,
    createdBy: req.user.id,
    updatedBy: req.user.id
  });

  res.status(201).json({ data: doc });
});

exports.listTypes = asyncHandler(async (req, res) => {
  const { activeOnly } = req.query;
  const filter = {};
  if (String(activeOnly).toLowerCase() === 'true' || activeOnly === '1') {
    filter.isActive = true;
  }
  const types = await ExpenseType.find(filter)
    .sort({ isActive: -1, name: 1 })
    .lean();
  res.json({ data: types });
});

exports.getTypeById = asyncHandler(async (req, res) => {
  const doc = await ExpenseType.findById(req.params.id).lean();
  if (!doc) throwError('Jenis pengeluaran tidak ditemukan', 404);
  res.json({ data: doc });
});

exports.updateType = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, isActive } = req.body || {};

  const doc = await ExpenseType.findById(id);
  if (!doc) throwError('Jenis pengeluaran tidak ditemukan', 404);

  if (typeof name === 'string' && name.trim()) {
    const dup = await ExpenseType.exists({
      _id: { $ne: id },
      name: name.trim()
    });
    if (dup) throwError('Nama jenis sudah digunakan', 409);
    doc.name = name.trim();
  }
  if (typeof description === 'string') doc.description = description;
  if (typeof isActive === 'boolean') doc.isActive = isActive;

  doc.updatedBy = req.user.id;
  await doc.save();
  res.json({ data: doc });
});

exports.removeType = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await ExpenseType.findById(id);
  if (!doc) throwError('Jenis pengeluaran tidak ditemukan', 404);
  if (doc.protected)
    throwError('Jenis ini dilindungi dan tidak bisa dihapus', 400);

  await doc.deleteOne();
  res.json({ ok: true });
});

/* ======================
 * ===== EXPENSES =======
 * ====================== */
exports.createExpense = asyncHandler(async (req, res) => {
  const { typeId, amount, note, date, attachments } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(typeId))
    throwError('typeId tidak valid', 400);
  const typeExists = await ExpenseType.exists({ _id: typeId, isActive: true });
  if (!typeExists)
    throwError('Jenis pengeluaran tidak ditemukan atau tidak aktif', 404);

  if (!Number.isFinite(+amount) || +amount <= 0)
    throwError('Nominal tidak valid', 400);

  const expense = await Expense.create({
    type: typeId,
    amount: +amount,
    note: note || '',
    date: date ? new Date(date) : new Date(),
    attachments: Array.isArray(attachments) ? attachments : [],
    createdBy: req.user.id,
    createdByRole: String(req.user.role || '').toLowerCase()
  });

  res.status(201).json({ data: expense });
});

exports.getExpenses = asyncHandler(async (req, res) => {
  const {
    period,
    start,
    end,
    mode,
    typeId,
    q,
    min,
    max,
    page = 1,
    limit = 20,
    summary
  } = req.query;

  const { start: s, end: e } = parsePeriod({
    period,
    start,
    end,
    mode,
    weekStartsOn: 1
  });

  const filter = { date: { $gte: s, $lte: e } };

  if (typeId && mongoose.Types.ObjectId.isValid(typeId))
    filter.type = new mongoose.Types.ObjectId(typeId);

  if (q?.trim()) filter.$text = { $search: q.trim() };
  if (min !== undefined)
    filter.amount = Object.assign(filter.amount || {}, { $gte: +min });
  if (max !== undefined)
    filter.amount = Object.assign(filter.amount || {}, { $lte: +max });

  const skip = (Math.max(1, +page) - 1) * Math.max(1, +limit);

  const [items, total] = await Promise.all([
    Expense.find(filter)
      .populate('type', 'name')
      .sort({ date: -1, _id: -1 })
      .skip(skip)
      .limit(Math.max(1, +limit))
      .lean(),
    Expense.countDocuments(filter)
  ]);

  const payload = { data: items, total, page: +page, limit: +limit };

  if (String(summary).toLowerCase() === 'true' || summary === '1') {
    const aggr = await Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);
    payload.summary = aggr[0] || { totalAmount: 0, count: 0 };
  }

  res.json(payload);
});

exports.getExpenseById = asyncHandler(async (req, res) => {
  const doc = await Expense.findById(req.params.id)
    .populate('type', 'name')
    .lean();
  if (!doc) throwError('Pengeluaran tidak ditemukan', 404);
  res.json({ data: doc });
});

exports.updateExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { typeId, amount, note, date, attachments } = req.body || {};
  const doc = await Expense.findById(id);
  if (!doc) throwError('Pengeluaran tidak ditemukan', 404);

  if (typeId) {
    if (!mongoose.Types.ObjectId.isValid(typeId))
      throwError('typeId tidak valid', 400);
    const ok = await ExpenseType.exists({ _id: typeId, isActive: true });
    if (!ok)
      throwError('Jenis pengeluaran tidak ditemukan atau tidak aktif', 404);
    doc.type = typeId;
  }

  if (amount !== undefined) {
    if (!Number.isFinite(+amount) || +amount <= 0)
      throwError('Nominal tidak valid', 400);
    doc.amount = +amount;
  }

  if (typeof note === 'string') doc.note = note;
  if (date) doc.date = new Date(date);
  if (attachments)
    doc.attachments = Array.isArray(attachments) ? attachments : [];

  await doc.save();
  res.json({ data: doc });
});

exports.removeExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await Expense.findById(id);
  if (!doc) throwError('Pengeluaran tidak ditemukan', 404);
  await doc.deleteOne();
  res.json({ ok: true });
});
