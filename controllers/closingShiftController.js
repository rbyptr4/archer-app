const asyncHandler = require('express-async-handler');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const ClosingShift = require('../models/closingShiftModel');
const User = require('../models/userModel');
const throwError = require('../utils/throwError');

const VALID_TYPES = ['bar', 'kitchen', 'cashier'];

const startOfDayJakarta = (d) =>
  dayjs(d || new Date())
    .tz('Asia/Jakarta')
    .startOf('day')
    .toDate();

exports.findOpen = asyncHandler(async (req, res) => {
  const { type, date } = req.query || {};
  if (!VALID_TYPES.includes(String(type))) throwError('type tidak valid', 400);

  const d = startOfDayJakarta(date);
  const doc = await ClosingShift.findOne({
    type,
    date: d,
    status: { $in: ['step1', 'step2'] }
  }).lean();

  res.json({ success: true, data: doc || null });
});

exports.createShift1 = asyncHandler(async (req, res) => {
  const { type, date, shift1 } = req.body || {};
  if (!VALID_TYPES.includes(String(type))) throwError('type tidak valid', 400);

  if (!shift1?.staff?.user || !shift1?.staff?.name) {
    throwError('staff.user dan staff.name wajib', 400);
  }

  const d = startOfDayJakarta(date);

  // Reuse bila sudah ada laporan aktif untuk kombinasi type+date
  const existing = await ClosingShift.findOne({
    type,
    date: d,
    status: { $in: ['step1', 'step2'] }
  });
  if (existing)
    return res.json({ success: true, reused: true, data: existing });

  // Normalisasi payload shift-1
  const payloadS1 = {
    staff: {
      user: shift1.staff.user,
      name: String(shift1.staff.name || '').trim(),
      position: String(shift1.staff.position || '') // opsional (boleh kosong)
    }
  };

  if (type === 'cashier') {
    payloadS1.cashier = {
      previousTurnover: Number(shift1?.cashier?.previousTurnover || 0)
    };
  } else {
    payloadS1.stockItemsStart = Array.isArray(shift1?.stockItemsStart)
      ? shift1.stockItemsStart
          .filter((r) => r && r.name)
          .map((r) => ({
            name: String(r.name).trim(),
            qty: String(r.qty || '').trim()
          }))
      : [];
  }

  const doc = await ClosingShift.create({
    type,
    date: d,
    status: 'step1',
    s1Submitted: true, // FE render Shift-2
    shift1: payloadS1,
    shift2: null
  });

  res.status(201).json({ success: true, data: doc });
});

/* ========== PATCH /closing-shifts/:id/shift2  (Shift-2: Isi) ========== */
exports.fillShift2 = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { shift2 } = req.body || {};

  const doc = await ClosingShift.findById(id);
  if (!doc) throwError('Laporan closing tidak ditemukan', 404);
  if (doc.status === 'locked') throwError('Laporan sudah dikunci', 400);

  if (!shift2?.staff?.user || !shift2?.staff?.name) {
    throwError('staff.user dan staff.name wajib di shift-2', 400);
  }

  const payloadS2 = {
    staff: {
      user: shift2.staff.user,
      name: String(shift2.staff.name || '').trim(),
      position: String(shift2.staff.position || '')
    },
    note: String(shift2?.note || ''),
    requestPurchase: doc.type === 'cashier' ? false : !!shift2?.requestPurchase
  };

  if (doc.type === 'cashier') {
    payloadS2.cashier = {
      diffFromShift1: Number(shift2?.cashier?.diffFromShift1 || 0),
      closingBreakdown: {
        cash: Number(shift2?.cashier?.closingBreakdown?.cash || 0),
        qris: Number(shift2?.cashier?.closingBreakdown?.qris || 0),
        transfer: Number(shift2?.cashier?.closingBreakdown?.transfer || 0)
      }
    };
  } else {
    payloadS2.stockItemsEnd = Array.isArray(shift2?.stockItemsEnd)
      ? shift2.stockItemsEnd
          .filter((r) => r && r.name)
          .map((r) => ({
            name: String(r.name).trim(),
            qty: String(r.qty || '').trim()
          }))
      : [];
  }

  doc.shift2 = payloadS2;
  doc.status = 'step2';
  await doc.save();

  res.json({ success: true, data: doc });
});

/* ========== PATCH /closing-shifts/:id/lock  (Kunci + TTL +1 hari) ========== */
exports.lockReport = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await ClosingShift.findById(id);
  if (!doc) throwError('Laporan closing tidak ditemukan', 404);

  // cukup jadikan locked + set TTL; tanpa info siapa yang lock
  if (doc.status !== 'locked') {
    const now = new Date();
    doc.status = 'locked';
    doc.lockAt = now;
    doc.expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +1 hari
    await doc.save();
  }

  res.json({ success: true, data: doc });
});

exports.listEmployeesDropdown = asyncHandler(async (req, res) => {
  const employees = await User.find({ role: 'employee' })
    .select('name email')
    .sort({ name: 1 })
    .lean();

  const items = employees.map((e) => ({
    name: e.name || '',
    email: e.email || ''
  }));

  res.json({
    items
  });
});
