// controllers/employeeController.js
const asyncHandler = require('express-async-handler');
const bcrypt = require('bcrypt');
const User = require('../../models/userModel');
const throwError = require('../../utils/throwError');

// POST /employees  (owner only) - registrasi karyawan
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

  const hash = await bcrypt.hash(password, 10);

  const emp = await User.create({
    name,
    email: lower,
    role: 'employee',
    password: hash,
    phone: phone || undefined,
    pages: pages && typeof pages === 'object' ? pages : {} // boleh kosong
  });

  // Normalisasi Map → object
  let outPages = emp.pages;
  if (outPages instanceof Map) outPages = Object.fromEntries(outPages);

  res.status(201).json({
    message: 'Karyawan dibuat',
    employee: {
      id: emp._id,
      name: emp.name,
      email: emp.email,
      phone: emp.phone,
      role: emp.role,
      pages: outPages,
      createdAt: emp.createdAt
    }
  });
});

// GET /employees  (owner only) - list karyawan
exports.listEmployees = asyncHandler(async (_req, res) => {
  const items = await User.find({ role: 'employee' })
    .select('name email phone role pages createdAt updatedAt')
    .lean();

  const normalized = items.map((u) => ({
    ...u,
    pages: u.pages instanceof Map ? Object.fromEntries(u.pages) : u.pages || {}
  }));

  res.json({ items: normalized });
});

// GET /employees/:id  (owner only)
exports.getEmployee = asyncHandler(async (req, res) => {
  const emp = await User.findOne({ _id: req.params.id, role: 'employee' })
    .select('name email phone role pages createdAt updatedAt')
    .lean();
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  emp.pages =
    emp.pages instanceof Map ? Object.fromEntries(emp.pages) : emp.pages || {};
  res.json({ employee: emp });
});

// PATCH /employees/:id  (owner only) - update profil &/atau password &/atau pages
exports.updateEmployee = asyncHandler(async (req, res) => {
  const { name, email, phone, newPassword, pages, mergePages } = req.body || {};

  const emp = await User.findOne({
    _id: req.params.id,
    role: 'employee'
  }).select('+password');
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  // email
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

  // pages: replace atau merge
  if (pages && typeof pages === 'object') {
    if (mergePages) {
      const cur =
        emp.pages instanceof Map
          ? Object.fromEntries(emp.pages)
          : emp.pages || {};
      emp.pages = { ...cur, ...pages };
    } else {
      emp.pages = pages;
    }
  }

  await emp.save();

  const out = emp.toObject();
  out.pages =
    out.pages instanceof Map ? Object.fromEntries(out.pages) : out.pages || {};
  delete out.password;
  res.json({ message: 'Karyawan diperbarui', employee: out });
});

// PATCH /employees/:id/pages  (owner only) - set izin halaman saja
exports.setEmployeePages = asyncHandler(async (req, res) => {
  const { pages, merge = true } = req.body || {};
  if (!pages || typeof pages !== 'object')
    throwError('pages wajib berupa object boolean', 400);

  const emp = await User.findOne({ _id: req.params.id, role: 'employee' });
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  if (merge) {
    const cur =
      emp.pages instanceof Map
        ? Object.fromEntries(emp.pages)
        : emp.pages || {};
    emp.pages = { ...cur, ...pages };
  } else {
    emp.pages = pages;
  }

  await emp.save();

  const outPages =
    emp.pages instanceof Map ? Object.fromEntries(emp.pages) : emp.pages || {};
  res.json({ message: 'Halaman karyawan diperbarui', pages: outPages });
});

// DELETE /employees/:id  (owner only)
exports.deleteEmployee = asyncHandler(async (req, res) => {
  const emp = await User.findOne({ _id: req.params.id, role: 'employee' });
  if (!emp) throwError('Karyawan tidak ditemukan', 404);

  await User.findByIdAndDelete(emp._id);
  res.json({ message: 'Karyawan dihapus' });
});
