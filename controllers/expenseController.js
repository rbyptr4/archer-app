const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Expense = require('../models/expenseModel');
const ExpenseType = require('../models/expenseTypeModel');
const throwError = require('../utils/throwError');
const {
  uploadBuffer,
  deleteFile,
  extractDriveIdFromUrl
} = require('../utils/googleDrive');
const { buildExpenseProofFileName } = require('../utils/makeFileName');
const { parseRange } = require('../utils/periodRange');
const { getDriveFolder } = require('../utils/driveFolders');

function getRangeFromQuery(q = {}) {
  const rangeKey = q.range || q.period || 'today';
  const weekStartsOn = Number.isFinite(+q.weekStartsOn) ? +q.weekStartsOn : 1;
  const { start, end } = parseRange({
    range: rangeKey,
    from: q.from,
    to: q.to,
    weekStartsOn
  });
  return { start, end };
}

exports.createType = asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) throwError('Nama jenis pengeluaran wajib diisi', 400);

  const exists = await ExpenseType.exists({ name: name.trim() });
  if (exists) throwError('Nama jenis pengeluaran sudah digunakan', 409);

  const doc = await ExpenseType.create({
    name: name.trim(),
    description: description || ''
  });

  res.status(201).json({ data: doc });
});

exports.listTypes = asyncHandler(async (req, res) => {
  const types = await ExpenseType.find({}).sort({ name: 1 }).lean();
  res.json({ data: types });
});

exports.getTypeById = asyncHandler(async (req, res) => {
  const doc = await ExpenseType.findById(req.params.id).lean();
  if (!doc) throwError('Jenis pengeluaran tidak ditemukan', 404);
  res.json({ data: doc });
});

exports.updateType = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body || {};

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

  await doc.save();
  res.json({ data: doc });
});

exports.removeType = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await ExpenseType.findById(id);
  if (!doc) throwError('Jenis pengeluaran tidak ditemukan', 404);
  await doc.deleteOne();
  res.json({ ok: true });
});

/* ======================
 * ===== EXPENSES =======
 * ====================== */
exports.createExpense = asyncHandler(async (req, res) => {
  const { typeId, amount, note, date } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(typeId))
    throwError('typeId tidak valid', 400);
  const typeExists = await ExpenseType.exists({ _id: typeId });
  if (!typeExists) throwError('Jenis pengeluaran tidak ditemukan', 404);

  if (!Number.isFinite(+amount) || +amount <= 0)
    throwError('Nominal tidak valid', 400);

  // wajibkan ada file bukti (karena schema Expense.imageUrl required)
  if (!req.file) throwError('Bukti pengeluaran (file) wajib diunggah', 400);

  // hitung tanggal expense
  const dateObj = date ? new Date(date) : new Date();
  if (isNaN(dateObj.getTime())) throwError('Tanggal tidak valid', 400);

  // upload file bukti terlebih dahulu
  let imageUrl = '';
  try {
    const folderId = getDriveFolder('expense'); // folder untuk expense
    const desiredName = buildExpenseProofFileName(
      // tipe pengeluaran: bisa ambil dari ExpenseType jika ingin nama yang friendly,
      // di sini kita pakai string dari body atau fallback ke id
      req.body.typeName || typeId, // kalau kamu punya nama type di body bisa pakai itu; kalau tidak gunakan typeId
      dateObj,
      req.file.originalname,
      req.file.mimetype
    );

    const uploaded = await uploadBuffer(
      req.file.buffer,
      desiredName,
      req.file.mimetype,
      folderId
    );

    imageUrl = `https://drive.google.com/uc?export=view&id=${uploaded.id}`;
  } catch (err) {
    console.error('[createExpense][upload]', err);
    throwError('Gagal mengunggah bukti pengeluaran', 500);
  }

  // buat expense dengan imageUrl
  const expense = await Expense.create({
    type: typeId,
    amount: +amount,
    note: note || '',
    date: dateObj,
    imageUrl,
    createdBy: req.user.id
  });

  res.status(201).json({ data: expense });
});

exports.getExpenses = asyncHandler(async (req, res) => {
  const { q, limit = 20, cursor } = req.query;
  const { start: s, end: e } = getRangeFromQuery(req.query);

  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

  // build pipeline
  const pipeline = [];

  // 1) match by date range
  pipeline.push({
    $match: {
      date: { $gte: s, $lte: e }
    }
  });

  // 2) optional cursor paging (based on createdAt descending)
  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) {
      pipeline.push({
        $match: { createdAt: { $lt: d } }
      });
    }
  }

  // 3) lookup type to enable searching by type.name
  pipeline.push({
    $lookup: {
      from: 'expensetypes', // koleksi ExpenseType (mongoose pluralize)
      localField: 'type',
      foreignField: '_id',
      as: 'type'
    }
  });
  pipeline.push({
    $unwind: { path: '$type', preserveNullAndEmptyArrays: true }
  });

  // 4) search q on note OR type.name (case-insensitive)
  if (q && String(q).trim()) {
    const regex = new RegExp(String(q).trim(), 'i');
    pipeline.push({
      $match: {
        $or: [{ note: { $regex: regex } }, { 'type.name': { $regex: regex } }]
      }
    });
  }

  // 5) sort & limit (lim+1 to detect next_cursor)
  pipeline.push({ $sort: { createdAt: -1 } });
  pipeline.push({ $limit: lim + 1 });

  // 6) project shape (include type.name)
  pipeline.push({
    $project: {
      _id: 1,
      date: 1,
      amount: 1,
      note: 1,
      imageUrl: 1,
      createdBy: 1,
      createdAt: 1,
      type: { _id: '$type._id', name: '$type.name' }
    }
  });

  const rows = await Expense.aggregate(pipeline).allowDiskUse(true);

  const hasMore = rows.length > lim;
  const data = rows.slice(0, lim);

  const next_cursor = hasMore
    ? new Date(rows[lim - 1].createdAt).toISOString()
    : null;

  res.json({
    period: { start: s, end: e },
    data,
    next_cursor,
    limit: lim
  });
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
  const { typeId, amount, note, date } = req.body || {};
  const doc = await Expense.findById(id);
  if (!doc) throwError('Pengeluaran tidak ditemukan', 404);

  if (typeId) {
    if (!mongoose.Types.ObjectId.isValid(typeId))
      throwError('typeId tidak valid', 400);
    const ok = await ExpenseType.exists({ _id: typeId, isActive: true });
    if (!ok) throwError('Jenis pengeluaran tidak ditemukan', 404);
    doc.type = typeId;
  }

  if (amount !== undefined) {
    if (!Number.isFinite(+amount) || +amount <= 0)
      throwError('Nominal tidak valid', 400);
    doc.amount = +amount;
  }

  if (typeof note === 'string') doc.note = note;
  if (date) doc.date = new Date(date);

  // jika ada file baru: upload, set imageUrl baru, hapus file lama
  if (req.file) {
    // upload dulu
    let uploaded;
    try {
      const folderId = getDriveFolder('expense'); // pastikan ada folder ini
      const desiredName = buildExpenseProofFileName(
        req.body.typeName || doc.type || 'expense',
        doc.date || new Date(),
        req.file.originalname,
        req.file.mimetype
      );

      uploaded = await uploadBuffer(
        req.file.buffer,
        desiredName,
        req.file.mimetype || 'image/jpeg',
        folderId
      );
    } catch (err) {
      console.error('[updateExpense][uploadBuffer]', err);
      throwError('Gagal mengunggah bukti pengeluaran', 500);
    }

    const newId = uploaded && (uploaded.id || uploaded.fileId || uploaded._id);
    if (!newId) throwError('Gagal mendapatkan file id setelah upload', 500);
    const newUrl = `https://drive.google.com/uc?export=view&id=${newId}`;

    // simpan url baru ke doc, commit ke DB
    const oldUrl = doc.imageUrl;
    doc.imageUrl = newUrl;
    await doc.save();

    // hapus file lama (jika ada) — jangan blokir response kalau gagal, cukup log
    if (oldUrl) {
      const oldFileId = extractDriveIdFromUrl(oldUrl);
      if (oldFileId) {
        try {
          await deleteFile(oldFileId);
        } catch (err) {
          console.error('[updateExpense][delete old file]', err);
          // optional: laporkan ke monitoring, tapi jangan throw agar user tidak kehilangan perubahan
        }
      }
    }

    // return dengan doc terbaru
    return res.json({ data: doc });
  }

  // jika tidak ada file baru, simpan perubahan biasa
  await doc.save();
  res.json({ data: doc });
});

exports.removeExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await Expense.findById(id);
  if (!doc) throwError('Data pengeluaran tidak ditemukan', 404);

  // hapus file terkait di Drive jika ada
  if (doc.imageUrl) {
    const fileId = extractDriveIdFromUrl(doc.imageUrl);
    if (fileId) {
      try {
        await deleteFile(fileId);
      } catch (err) {
        console.error('[removeExpense][deleteFile]', err);
        // kita tetap lanjut hapus dokumen agar tidak tersisa data, tapi log error
      }
    }
  }

  await doc.deleteOne();
  res.json({ ok: true });
});
