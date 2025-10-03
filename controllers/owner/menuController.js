const asyncHandler = require('express-async-handler');
const Menu = require('../../models/menuModel');
const throwError = require('../../utils/throwError');
const { uploadBuffer, deleteFile } = require('../../utils/googleDrive');
const { getDriveFolder } = require('../../utils/driveFolders');

/* CREATE MENU + Upload Gambar */
exports.createMenu = asyncHandler(async (req, res) => {
  const {
    menu_code,
    name,
    price,
    description = '',
    addons = [],
    isActive = true
  } = req.body;
  console.log('[DEBUG] req.file:', req.file);
  console.log('[DEBUG] MENU FOLDER ID:', process.env.MENU);
  console.log('[DEBUG] req.body:', req.body);
  // cek duplikat kode
  const exists = await Menu.findOne({
    menu_code: menu_code.toUpperCase()
  }).lean();
  if (exists) throwError('Kode menu sudah digunakan', 409, 'menu_code');

  let imageUrl = '';
  if (req.file) {
    const folderId = getDriveFolder('menu');
    const result = await uploadBuffer(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      folderId
    );
    imageUrl = `https://drive.google.com/uc?export=view&id=${result.id}`;
  }

  const doc = await Menu.create({
    menu_code: menu_code.toUpperCase(),
    name,
    price,
    description,
    imageUrl,
    addons,
    isActive
  });

  res.status(201).json({ message: 'Menu berhasil dibuat', menu: doc });
});

/* UPDATE MENU (optional update gambar) */
exports.updateMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payload = { ...req.body };

  if (payload.menu_code) {
    payload.menu_code = payload.menu_code.toUpperCase();
    const dup = await Menu.findOne({
      menu_code: payload.menu_code,
      _id: { $ne: id }
    }).lean();
    if (dup) throwError('Kode menu sudah digunakan', 409, 'menu_code');
  }

  if (req.file) {
    const folderId = getDriveFolder('menu');
    const result = await uploadBuffer(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      folderId
    );
    payload.imageUrl = `https://drive.google.com/uc?export=view&id=${result.id}`;
  }

  const updated = await Menu.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true
  });
  if (!updated) throwError('Menu tidak ditemukan', 404);

  res.json({ message: 'Menu diperbarui', menu: updated });
});

/* DELETE MENU + hapus file GDrive kalau ada */
exports.deleteMenu = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const menu = await Menu.findById(id);
  if (!menu) throwError('Menu tidak ditemukan', 404);

  if (menu.imageUrl) {
    const fileId = menu.imageUrl.split('id=')[1];
    if (fileId) {
      try {
        await deleteFile(fileId);
      } catch (e) {
        console.warn('[deleteMenu] gagal hapus file di GDrive:', e.message);
      }
    }
  }

  await menu.deleteOne();
  res.json({ message: 'Menu dihapus' });
});

/* LIST MENU */
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

/* GET DETAIL */
exports.getMenuById = asyncHandler(async (req, res) => {
  const menu = await Menu.findById(req.params.id).lean();
  if (!menu) throwError('Menu tidak ditemukan', 404);
  res.json({ menu });
});

/* ACTIVATE / DEACTIVATE */
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
