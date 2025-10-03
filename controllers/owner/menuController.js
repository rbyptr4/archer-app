const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Menu = require('../../models/menuModel');
const throwError = require('../../utils/throwError');
const { uploadBuffer, deleteFile } = require('../../utils/googleDrive');
const { getDriveFolder } = require('../../utils/driveFolders');
const { buildMenuFileName } = require('../../utils/makeFileName');
const { extractDriveFileId } = require('../../utils/driveFileId');

exports.createMenu = asyncHandler(async (req, res) => {
  const {
    menu_code,
    name,
    price,
    description = '',
    addons = [],
    isActive = true
  } = req.body;

  let newFileId = null;
  let imageUrl = '';

  // 1) Upload dulu (di luar txn)
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
    // 2) Tulis DB di dalam transaction
    await session.withTransaction(async () => {
      const exists = await Menu.findOne({ menu_code: menu_code.toUpperCase() })
        .session(session)
        .lean();
      if (exists) throwError('Kode menu sudah digunakan', 409, 'menu_code');

      const payload = {
        menu_code: menu_code.toUpperCase(),
        name,
        price,
        description,
        imageUrl,
        addons,
        isActive
      };

      const [doc] = await Menu.create([payload], { session });
      createdDoc = doc;
    });

    // 3) Sukses → kirim respons
    res.status(201).json({ message: 'Menu berhasil dibuat', menu: createdDoc });
  } catch (err) {
    // 4) Rollback file di Drive kalau DB gagal
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

  const current = await Menu.findById(id).lean();
  if (!current) throwError('Menu tidak ditemukan', 404);

  const payload = { ...req.body };

  let newFileId = null;
  if (req.file) {
    const folderId = getDriveFolder('menu');
    const finalCode = (
      payload.menu_code ||
      current.menu_code ||
      ''
    ).toUpperCase();
    const finalName = payload.name || current.name || '';
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
      if (payload.menu_code) {
        payload.menu_code = payload.menu_code.toUpperCase();
        const dup = await Menu.findOne({
          menu_code: payload.menu_code,
          _id: { $ne: id }
        })
          .session(session)
          .lean();
        if (dup) throwError('Kode menu sudah digunakan', 409, 'menu_code');
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

  res.json({ message: 'Menu diperbarui', menu: updated });
});

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

  res.json({ message: 'Menu dihapus' });
});

exports.listMenus = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || '20', 10), 1),
    100
  );
  const skip = (page - 1) * limit;
  const q = (req.query.q || '').trim();

  const isActiveParam = (req.query.isActive || 'true').toLowerCase();
  const filter = {};

  if (q) {
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { menu_code: { $regex: q, $options: 'i' } }
    ];
  }

  if (isActiveParam === 'true') filter.isActive = true;
  else if (isActiveParam === 'false') filter.isActive = false;

  const [items, total] = await Promise.all([
    Menu.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Menu.countDocuments(filter)
  ]);

  res.json({
    items,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1
  });
});

exports.getMenuById = asyncHandler(async (req, res) => {
  const menu = await Menu.findById(req.params.id).lean();
  if (!menu) throwError('Menu tidak ditemukan', 404);
  res.json({ menu });
});

exports.activateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updated = await Menu.findByIdAndUpdate(
    id,
    { $set: { isActive: true } },
    { new: true }
  );
  if (!updated) throwError('Menu tidak ditemukan', 404);
  res.json({ message: 'Menu diaktifkan', menu: updated });
});

exports.deactivateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updated = await Menu.findByIdAndUpdate(
    id,
    { $set: { isActive: false } },
    { new: true }
  );
  if (!updated) throwError('Menu tidak ditemukan', 404);
  res.json({ message: 'Menu dinonaktifkan', menu: updated });
});
