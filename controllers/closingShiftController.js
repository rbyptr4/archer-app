const asyncHandler = require('express-async-handler');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const ClosingShift = require('../models/closingShiftModel');
const User = require('../models/userModel');

const throwError = require('../utils/throwError');
const { sendText, buildClosingShiftMessage } = require('../utils/wablas');
const { getOwnerPhone } = require('../utils/ownerPhone');

const VALID_TYPES = ['bar', 'kitchen', 'cashier'];

const toWa62 = (phone) => {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let d = s.replace(/\D+/g, '');
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (d.startsWith('+62')) return '62' + d.slice(3);
  return d;
};

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
    // Untuk cashier: wajib ada openingBreakdown (cash, qris, transfer, card)
    const ob = shift1?.cashier?.openingBreakdown || null;
    if (!ob || typeof ob !== 'object') {
      throwError(
        'Untuk cashier, openingBreakdown wajib diisi pada Shift-1 (fields: cash, qris, transfer, card).',
        400
      );
    }

    const parseNumberField = (v) => {
      const n = Number(v === undefined || v === null ? 0 : v);
      return Number.isFinite(n) ? n : NaN;
    };

    const cash = parseNumberField(ob.cash);
    const qris = parseNumberField(ob.qris);
    const transfer = parseNumberField(ob.transfer);
    const card = parseNumberField(ob.card);

    if ([cash, qris, transfer, card].some((x) => Number.isNaN(x))) {
      throwError(
        'openingBreakdown harus berisi angka untuk cash, qris, transfer, dan card (boleh 0).',
        400
      );
    }

    payloadS1.cashier = {
      previousTurnover: Number(shift1?.cashier?.previousTurnover || 0),
      openingBreakdown: { cash, qris, transfer, card }
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
    throwError('Nama staff wajib diisi', 400);
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
    // Validasi wajib: shift2.cashier.closingBreakdown harus berisi cash, qris, transfer, card
    const cb = shift2?.cashier?.closingBreakdown || null;
    if (!cb || typeof cb !== 'object') {
      throwError(
        'Untuk cashier, closingBreakdown wajib diisi (fields: cash, qris, transfer, card).',
        400
      );
    }

    // Cast & validate setiap pecahan jadi number (boleh 0)
    const parseNumberField = (v) => {
      const n = Number(v === undefined || v === null ? 0 : v);
      return Number.isFinite(n) ? n : NaN;
    };

    const cash = parseNumberField(cb.cash);
    const qris = parseNumberField(cb.qris);
    const transfer = parseNumberField(cb.transfer);
    const card = parseNumberField(cb.card);

    if ([cash, qris, transfer, card].some((x) => Number.isNaN(x))) {
      throwError(
        'closingBreakdown harus berisi angka untuk cash, qris, transfer, dan card (boleh 0).',
        400
      );
    }

    // Optionally: kamu bisa menambahkan pemeriksaan sum vs grand_total di sini.
    payloadS2.cashier = {
      diffFromShift1: Number(shift2?.cashier?.diffFromShift1 || 0),
      closingBreakdown: {
        cash,
        qris,
        transfer,
        card
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
    .select('_id name email')
    .sort({ name: 1 })
    .lean();

  const items = employees.map((e) => ({
    id: e._id || '',
    name: e.name || '',
    email: e.email || ''
  }));

  res.json({
    items
  });
});

exports.sendClosingShiftLockedWa = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const doc = await ClosingShift.findById(id).lean();
  if (!doc) throwError('Laporan closing tidak ditemukan', 404);
  if (doc.status !== 'locked') {
    throwError(
      'Laporan belum dikunci. Hanya bisa kirim saat status locked.',
      409
    );
  }
  if (!doc.shift2)
    throwError('Shift-2 belum diisi. Tidak ada data untuk dikirim.', 409);

  const ownersRaw = getOwnerPhone();
  if (!ownersRaw.length) throwError('OWNER_WA belum di-set atau kosong.', 500);

  // Normalisasi ke format 62
  const recipients = [
    ...new Set(ownersRaw.map((p) => toWa62(p || '').trim()).filter(Boolean))
  ];
  if (!recipients.length) throwError('Nomor OWNER_WA tidak valid.', 500);

  const message = buildClosingShiftMessage(doc, 'locked');

  // Kirim paralel (best-effort)
  const settled = await Promise.allSettled(
    recipients.map((phone) => sendText(phone, message))
  );

  const results = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? { phone: recipients[i], ok: true, gateway: r.value }
      : {
          phone: recipients[i],
          ok: false,
          error: r.reason?.message || String(r.reason)
        }
  );

  res.json({
    success: true,
    recipients,
    preview: message,
    results
  });
});
