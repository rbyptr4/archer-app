// controllers/owner/voucherOwnerController.js
const asyncHandler = require('express-async-handler');
const Voucher = require('../../models/voucherModel');
const throwError = require('../../utils/throwError');

/* ===================== Helpers ===================== */
const asInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const asBool = (v) => {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (['1', 'true', 'yes', 'y'].includes(s)) return true;
    if (['0', 'false', 'no', 'n'].includes(s)) return false;
  }
  return undefined;
};
const asDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

/**
 * Soft business rules kita:
 * - Stackable hanya untuk target 'shipping' (ongkir). Yang lain harus non-stack.
 * - pointsRequired >= 0 (0 = free)
 * - quota fields >= 0
 * - Period sanity (publish/use/claim)
 * Field nama/tipe disesuaikan ke model kamu; validasi hanya jalan jika field tsb ada di body.
 */
function normalizeAndValidatePayload(payload, { isUpdate = false } = {}) {
  const p = { ...payload };

  // Normalisasi angka umum
  if ('pointsRequired' in p)
    p.pointsRequired = Math.max(0, asInt(p.pointsRequired, 0));
  if ('maxPerMember' in p)
    p.maxPerMember = Math.max(0, asInt(p.maxPerMember, 0));
  if ('totalQuota' in p) p.totalQuota = Math.max(0, asInt(p.totalQuota, 0));
  if ('minOrderValue' in p)
    p.minOrderValue = Math.max(0, asInt(p.minOrderValue, 0));
  if ('maxDiscount' in p) p.maxDiscount = Math.max(0, asInt(p.maxDiscount, 0));

  // Boolean umum
  if ('isActive' in p) p.isActive = Boolean(p.isActive);
  if ('isDeleted' in p) p.isDeleted = Boolean(p.isDeleted);
  if ('isStackable' in p) p.isStackable = Boolean(p.isStackable);

  // Tanggal (opsional, hanya jika dikirim)
  const publishStart = 'publishStart' in p ? asDate(p.publishStart) : undefined;
  const publishEnd = 'publishEnd' in p ? asDate(p.publishEnd) : undefined;
  const claimUntil = 'claimUntil' in p ? asDate(p.claimUntil) : undefined;
  const useStart = 'useStart' in p ? asDate(p.useStart) : undefined;
  const useEnd = 'useEnd' in p ? asDate(p.useEnd) : undefined;

  if (publishStart !== undefined) p.publishStart = publishStart;
  if (publishEnd !== undefined) p.publishEnd = publishEnd;
  if (claimUntil !== undefined) p.claimUntil = claimUntil;
  if (useStart !== undefined) p.useStart = useStart;
  if (useEnd !== undefined) p.useEnd = useEnd;

  // Sanity check periode (hanya validasi jika kedua sisi ada)
  const err = (msg) => throwError(msg, 400);
  if (p.publishStart && p.publishEnd && p.publishStart > p.publishEnd) {
    err('publishStart tidak boleh setelah publishEnd');
  }
  if (p.useStart && p.useEnd && p.useStart > p.useEnd) {
    err('useStart tidak boleh setelah useEnd');
  }
  if (p.claimUntil && p.useEnd && p.claimUntil > p.useEnd) {
    err('claimUntil tidak boleh setelah useEnd (masa pakai terakhir).');
  }

  // Rule stack: hanya shipping yang boleh stack
  // Asumsi model punya p.target ∈ {'shipping','order','item', ...}
  const target = 'target' in p ? p.target : undefined;
  const isShip = (target || '').toLowerCase() === 'shipping';
  if ('isStackable' in p && p.isStackable && target !== undefined && !isShip) {
    err(
      'isStackable hanya diizinkan untuk voucher target "shipping" (ongkir).'
    );
  }

  // Kalau update: jangan izinkan toggle target bila sudah aktif (opsional safety)
  p._updateGuard = { isUpdate };

  return p;
}

/* ===================== Create ===================== */
exports.createVoucher = asyncHandler(async (req, res) => {
  const payload = normalizeAndValidatePayload(req.body || {}, {
    isUpdate: false
  });

  // Default flags
  if (payload.isDeleted == null) payload.isDeleted = false;
  if (payload.isActive == null) payload.isActive = false;

  const v = await Voucher.create(payload);
  res.status(201).json({ voucher: v });
});

/* ===================== Read: list (filters + paging) ===================== */
exports.listVoucher = asyncHandler(async (req, res) => {
  const {
    q, // fuzzy by name
    active, // 'true' | 'false'
    target, // 'shipping' | 'order' | 'item' | ...
    stackable, // 'true' | 'false'
    free, // 'true' => pointsRequired = 0 ; 'false' => > 0
    minPoints,
    maxPoints, // numeric filter
    createdBy, // owner/staff id (optional)
    startsFrom,
    endsTo, // publish window overlap
    claimableAt, // ISO date; voucher claimable at this time
    usableAt, // ISO date; voucher usable at this time
    sort = 'createdAt', // createdAt | publishStart | useEnd
    order = 'desc', // asc | desc
    // Pagination (cursor OR page/limit)
    limit,
    cursor, // ISO or ms; returns items with sortKey < cursor (for desc) / > for asc
    page, // offset paging fallback
    pageSize
  } = req.query || {};

  const filter = { isDeleted: false };

  // text search
  if (q) filter.name = new RegExp(String(q), 'i');

  // active flag
  const a = asBool(active);
  if (a !== undefined) filter.isActive = a;

  // target
  if (target) filter.target = String(target);

  // stackable
  const st = asBool(stackable);
  if (st !== undefined) filter.isStackable = st;

  // free vs paid
  const f = asBool(free);
  if (f === true) filter.pointsRequired = 0;
  if (f === false) filter.pointsRequired = { $gt: 0 };

  // min/max points
  const minP = asInt(minPoints, NaN);
  const maxP = asInt(maxPoints, NaN);
  if (!isNaN(minP) || !isNaN(maxP)) {
    filter.pointsRequired = filter.pointsRequired || {};
    if (!isNaN(minP)) filter.pointsRequired.$gte = minP;
    if (!isNaN(maxP)) filter.pointsRequired.$lte = maxP;
  }

  // createdBy (jika ada di model)
  if (createdBy) filter.createdBy = createdBy;

  // Publish window overlap (optional jika model punya publishStart/End)
  const sFrom = asDate(startsFrom);
  const eTo = asDate(endsTo);
  if (sFrom || eTo) {
    // overlap check: publishEnd >= startsFrom AND publishStart <= endsTo
    filter.$and = filter.$and || [];
    if (sFrom) filter.$and.push({ publishEnd: { $gte: sFrom } });
    if (eTo) filter.$and.push({ publishStart: { $lte: eTo } });
  }

  // claimableAt
  const cAt = asDate(claimableAt);
  if (cAt) {
    filter.isActive = true;
    filter.$and = filter.$and || [];
    filter.$and.push(
      {
        $or: [
          { publishStart: { $exists: false } },
          { publishStart: { $lte: cAt } }
        ]
      },
      {
        $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $gte: cAt } }]
      }
    );
  }

  // usableAt
  const uAt = asDate(usableAt);
  if (uAt) {
    filter.$and = filter.$and || [];
    filter.$and.push(
      { $or: [{ useStart: { $exists: false } }, { useStart: { $lte: uAt } }] },
      { $or: [{ useEnd: { $exists: false } }, { useEnd: { $gte: uAt } }] }
    );
  }

  // Sorting
  const sortKey =
    sort === 'publishStart'
      ? 'publishStart'
      : sort === 'useEnd'
      ? 'useEnd'
      : 'createdAt';
  const sortDir = order === 'asc' ? 1 : -1;

  // Pagination: prefer cursor if provided
  const lim = Math.min(asInt(limit, 20) || 20, 100);
  let items, next_cursor, total, currentPage, totalPages;

  if (cursor) {
    const cur = asDate(cursor) || new Date(Number(cursor));
    if (cur && !isNaN(cur.getTime())) {
      filter[sortKey] =
        sortDir < 0
          ? { ...(filter[sortKey] || {}), $lt: cur }
          : { ...(filter[sortKey] || {}), $gt: cur };
    }
    items = await Voucher.find(filter)
      .sort({ [sortKey]: sortDir, _id: sortDir })
      .limit(lim)
      .lean();
    next_cursor = items.length ? items[items.length - 1][sortKey] : null;
    return res.json({ vouchers: items, next_cursor });
  }

  // Fallback: offset paging
  currentPage = Math.max(1, asInt(page, 1));
  const perPage = Math.min(asInt(pageSize, lim) || lim, 100);
  const skip = (currentPage - 1) * perPage;

  [total, items] = await Promise.all([
    Voucher.countDocuments(filter),
    Voucher.find(filter)
      .sort({ [sortKey]: sortDir, _id: sortDir })
      .skip(skip)
      .limit(perPage)
      .lean()
  ]);
  totalPages = Math.max(1, Math.ceil(total / perPage));

  res.json({
    vouchers: items,
    page: currentPage,
    pageSize: perPage,
    total,
    totalPages
  });
});

/* ===================== Read: detail ===================== */
exports.getVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id).lean();
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);
  res.json({ voucher: v });
});

/* ===================== Update ===================== */
exports.updateVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  const incoming = normalizeAndValidatePayload(req.body || {}, {
    isUpdate: true
  });

  // Guard opsional: jika sudah aktif, cegah ubah target (menghindari inkonsistensi claim)
  if (
    v.isActive &&
    incoming.target &&
    String(incoming.target) !== String(v.target)
  ) {
    throwError('Voucher sudah aktif, tidak boleh mengubah target.', 400);
  }

  Object.assign(v, incoming);
  await v.save();

  res.json({ voucher: v.toObject() });
});

/* ===================== Activate / Deactivate ===================== */
exports.activateVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  // Validasi ringan sebelum aktif:
  if (!v.name || !String(v.name).trim()) {
    throwError('Nama voucher wajib diisi sebelum aktivasi.', 400);
  }
  if (v.isStackable && String(v.target).toLowerCase() !== 'shipping') {
    throwError('Hanya voucher ongkir yang boleh stackable.', 400);
  }
  // Sanity periode (kalau ada useStart/useEnd)
  if (v.useStart && v.useEnd && v.useStart > v.useEnd) {
    throwError('useStart tidak boleh setelah useEnd.', 400);
  }
  if (v.claimUntil && v.useEnd && v.claimUntil > v.useEnd) {
    throwError('claimUntil tidak boleh setelah useEnd.', 400);
  }

  v.isActive = true;
  await v.save();
  res.json({ voucher: v.toObject() });
});

exports.deactivateVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  v.isActive = false;
  await v.save();
  res.json({ voucher: v.toObject() });
});

exports.removeVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v) throwError('Voucher tidak ditemukan', 404);
  v.isDeleted = true;
  v.isActive = false;
  await v.save();
  res.json({ ok: true });
});

exports.permanentRemoveVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v) throwError('Voucher tidak ditemukan', 404);
  await v.deleteOne(); // ← hapus permanen
  res.json({ ok: true, deleted: true });
});
