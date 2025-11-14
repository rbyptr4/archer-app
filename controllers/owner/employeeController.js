const asyncHandler = require('express-async-handler');
const bcrypt = require('bcrypt');
const User = require('../../models/userModel');
const throwError = require('../../utils/throwError');

const ALLOWED_PAGES = [
  'menu',
  'employees',
  'members',
  'orders',
  'kitchen',
  'reports',
  'delivery',
  'expense',
  'closing',
  'courier'
];

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const normalizePagesOut = (pages) =>
  pages instanceof Map ? Object.fromEntries(pages) : pages || {};

const validatePages = (pagesObj) => {
  for (const [k, v] of Object.entries(pagesObj || {})) {
    if (!ALLOWED_PAGES.includes(k))
      throwError(`Halaman "${k}" tidak diizinkan`, 400);
    if (typeof v !== 'boolean')
      throwError(`Nilai halaman "${k}" harus boolean`, 400);
  }
};

exports.createEmployee = asyncHandler(async (req, res) => {
  const { name, email, password, phone, pages } = req.body || {};
  if (!name || !email || !password)
    throwError('name, email, password wajib diisi', 400);

  const lower = String(email).toLowerCase();

  const emailUsed = await User.exists({ email: lower });
  if (emailUsed) throwError('Email sudah terpakai', 409);

  if (phone) {
    const phoneUsed = await User.exists({ phone });
    if (phoneUsed) throwError('Nomor telepon sudah terpakai', 409);
  }

  let initialPages = {};
  if (isPlainObject(pages)) {
    validatePages(pages);
    initialPages = pages;
  }

  const hash = await bcrypt.hash(password, 10);

  const emp = await User.create({
    name,
    email: lower,
    role: 'employee',
    password: hash,
    phone: phone || undefined,
    pages: initialPages // boleh kosong
  });

  res.status(201).json({
    message: 'Karyawan dibuat',
    employee: {
      id: emp._id,
      name: emp.name,
      email: emp.email,
      phone: emp.phone,
      role: emp.role,
      pages: normalizePagesOut(emp.pages),
      createdAt: emp.createdAt
    }
  });
});

exports.listEmployees = asyncHandler(async (req, res) => {
  let {
    limit = 10,
    search = '',
    sortBy = 'createdAt',
    sortDir = 'desc',
    cursor
  } = req.query;
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

  const filter = { role: 'employee' };
  if (search) {
    const re = new RegExp(String(search), 'i');
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }

  const sortDirection = String(sortDir).toLowerCase() === 'asc' ? 1 : -1;
  // we'll still use createdAt cursor even jika sortBy berbeda, for consistency
  const matchCursor = {};
  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) matchCursor.createdAt = { $lt: d };
  }

  const q = { ...filter, ...matchCursor };

  const items = await User.find(q)
    .select('name email phone role pages createdAt updatedAt')
    .sort({ createdAt: -1, _id: -1 }) // keep stable order for cursor
    .limit(limit + 1)
    .lean();

  const normalized = items.slice(0, limit).map((u) => ({
    ...u,
    pages: normalizePagesOut(u.pages)
  }));

  const next_cursor =
    items.length > limit
      ? new Date(items[limit - 1].createdAt).toISOString()
      : null;

  res.json({
    message: 'Daftar karyawan',
    limit,
    next_cursor,
    items: normalized
  });
});

exports.getEmployee = asyncHandler(async (req, res) => {
  const emp = await User.findOne({ _id: req.params.id, role: 'employee' })
    .select('name email phone role pages createdAt updatedAt')
    .lean();
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  emp.pages = normalizePagesOut(emp.pages);
  res.json({ employee: emp });
});

exports.updateEmployee = asyncHandler(async (req, res) => {
  const { name, email, phone, newPassword } = req.body || {};

  const emp = await User.findOne({
    _id: req.params.id,
    role: 'employee'
  }).select('+password');

  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  if (email && email.toLowerCase() !== emp.email) {
    const lower = String(email).toLowerCase();
    const used = await User.exists({ email: lower, _id: { $ne: emp._id } });
    if (used) throwError('Email sudah digunakan', 409, 'email');
    emp.email = lower;
  }

  if (name) emp.name = name;

  if (phone !== undefined) {
    if (phone) {
      const usedPhone = await User.exists({ phone, _id: { $ne: emp._id } });
      if (usedPhone) throwError('Nomor telepon sudah digunakan', 409, 'phone');
      emp.phone = phone;
    } else {
      emp.phone = undefined;
    }
  }

  if (newPassword) {
    const hash = await bcrypt.hash(newPassword, 10);
    emp.password = hash;
  }

  await emp.save();

  const out = emp.toObject();
  delete out.password; // jangan expose password

  res.json({ message: 'Profil karyawan diperbarui', employee: out });
});

exports.setEmployeePages = asyncHandler(async (req, res) => {
  const { pages, merge = true } = req.body || {};
  if (!isPlainObject(pages))
    throwError('pages wajib berupa object boolean', 400);
  validatePages(pages);

  const emp = await User.findOne({ _id: req.params.id, role: 'employee' });
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  if (merge) {
    const setOps = {};
    for (const [k, v] of Object.entries(pages)) setOps[`pages.${k}`] = v;
    await User.updateOne({ _id: emp._id }, { $set: setOps });
  } else {
    const cur = normalizePagesOut(emp.pages);
    const unsetOps = {};
    for (const k of Object.keys(cur)) unsetOps[`pages.${k}`] = '';
    const setOps = {};
    for (const [k, v] of Object.entries(pages)) setOps[`pages.${k}`] = v;

    const ops = {};
    if (Object.keys(unsetOps).length) ops.$unset = unsetOps;
    if (Object.keys(setOps).length) ops.$set = setOps;

    await User.updateOne({ _id: emp._id }, ops);
  }

  const fresh = await User.findById(emp._id).lean();
  res.json({
    message: 'Halaman karyawan diperbarui',
    pages: normalizePagesOut(fresh.pages)
  });
});

exports.deleteEmployee = asyncHandler(async (req, res) => {
  const emp = await User.findOne({ _id: req.params.id, role: 'employee' });
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  await User.findByIdAndDelete(emp._id);
  res.json({ message: 'Karyawan dihapus' });
});
