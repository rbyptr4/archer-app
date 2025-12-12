const asyncHandler = require('express-async-handler');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const LOCAL_TZ = 'Asia/Jakarta';

const ClosingShift = require('../models/closingShiftModel');
const User = require('../models/userModel');
const Order = require('../models/orderModel');

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

function parseTimeRangeToDayjs(rangeStr, dateStr) {
  // rangeStr contoh: "06:00-13:59"
  if (!rangeStr || typeof rangeStr !== 'string') return null;
  const parts = rangeStr.split('-').map((p) => String(p || '').trim());
  if (parts.length !== 2) return null;

  const [fromRaw, toRaw] = parts;
  // validasi format HH:mm (24h)
  const timeRe = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  if (!timeRe.test(fromRaw) || !timeRe.test(toRaw)) return null;

  // build ISO-like string then parse in LOCAL_TZ
  const fromIso = `${dateStr}T${fromRaw}:00`;
  const toIso = `${dateStr}T${toRaw}:00`;

  let from = dayjs.tz(fromIso, LOCAL_TZ);
  let to = dayjs.tz(toIso, LOCAL_TZ);

  if (!from.isValid() || !to.isValid()) return null;

  // if to is earlier than from -> assume next day
  if (to.isBefore(from) || to.isSame(from)) {
    to = to.add(1, 'day');
  }

  // normalize: from at start of minute, to at end of minute
  from = from.startOf('minute');
  to = to.endOf('minute');

  return { from, to };
}

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
  const employees = await User.find({ role: 'courier cashier kitchen' })
    .select('_id name phone')
    .sort({ name: 1 })
    .lean();

  const items = employees.map((e) => ({
    id: e._id || '',
    name: e.name || '',
    phone: e.phone || ''
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

exports.closingShiftSummary = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const dateQuery = String(req.query?.date || '').trim();
  const baseDay = dateQuery
    ? dayjs(dateQuery).tz(LOCAL_TZ)
    : dayjs().tz(LOCAL_TZ);
  if (!baseDay.isValid())
    throwError('date tidak valid (gunakan YYYY-MM-DD)', 400);

  // default shifts kalau tidak dikirim
  const defaultShift1 = '06:00-13:59';
  const defaultShift2 = '14:00-21:59';

  const shift1RangeStr = String(req.query?.shift1 || defaultShift1).trim();
  const shift2RangeStr = String(req.query?.shift2 || defaultShift2).trim();

  const toRangeDayjs = (rangeStr) => {
    const parsed = parseTimeRangeToDayjs(
      rangeStr,
      baseDay.format('YYYY-MM-DD')
    );
    if (!parsed) return null;
    return { from: parsed.from, to: parsed.to };
  };

  const shift1 = toRangeDayjs(shift1RangeStr);
  const shift2 = toRangeDayjs(shift2RangeStr);

  if (!shift1 || !shift2)
    throwError('Format shift tidak valid. Gunakan "HH:mm-HH:mm".', 400);

  // Full day range (startOfDay..endOfDay)
  const startOfDay = baseDay.startOf('day');
  const endOfDay = baseDay.endOf('day');

  const buildSummaryForRange = async (fromD, toD) => {
    const match = {
      payment_status: 'verified',
      paid_at: { $gte: fromD.toDate(), $lte: toD.toDate() }
    };

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$payment_method', 'unknown'] },
          total_amount: { $sum: { $ifNull: ['$grand_total', 0] } },
          count: { $sum: 1 }
        }
      }
    ];

    const rows = await Order.aggregate(pipeline).allowDiskUse(true);

    // normalize result into map + compute totals
    const methods = { transfer: 0, qris: 0, cash: 0, card: 0, unknown: 0 };
    let total_amount = 0;
    let total_orders = 0;
    for (const r of rows || []) {
      const m = String(r._id || 'unknown');
      const amt = Number(r.total_amount || 0);
      const cnt = Number(r.count || 0);
      if (Object.prototype.hasOwnProperty.call(methods, m)) {
        methods[m] = amt;
      } else {
        // anything else go to unknown
        methods.unknown += amt;
      }
      total_amount += amt;
      total_orders += cnt;
    }

    return {
      range_from: fromD.toISOString(),
      range_to: toD.toISOString(),
      total_orders,
      total_amount,
      by_payment_method: methods
    };
  };

  // compute three ranges
  const fullDaySummary = await buildSummaryForRange(startOfDay, endOfDay);
  const shift1Summary = await buildSummaryForRange(shift1.from, shift1.to);
  const shift2Summary = await buildSummaryForRange(shift2.from, shift2.to);

  return res.json({
    success: true,
    date: baseDay.format('YYYY-MM-DD'),
    shift_definitions: {
      shift1: shift1RangeStr,
      shift2: shift2RangeStr,
      // sertakan ISO ranges juga supaya jelas
      shift1_iso: {
        from: shift1.from.toISOString(),
        to: shift1.to.toISOString()
      },
      shift2_iso: {
        from: shift2.from.toISOString(),
        to: shift2.to.toISOString()
      },
      full_day_iso: {
        from: startOfDay.toISOString(),
        to: endOfDay.toISOString()
      }
    },
    summary: {
      full_day: fullDaySummary,
      shift1: shift1Summary,
      shift2: shift2Summary
    }
  });
});
