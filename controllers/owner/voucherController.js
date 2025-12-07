// controllers/owner/voucherOwnerController.js
const asyncHandler = require('express-async-handler');
const Voucher = require('../../models/voucherModel');
const VoucherClaim = require('../../models/voucherClaimModel');
const throwError = require('../../utils/throwError');

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

function cleanseIrrelevantFieldsByType(payload, type) {
  const p = payload;

  // common containers in your model: percent, amount, shipping, appliesTo.bundling
  if (type === 'percent') {
    // keep percent, maybe maxDiscount if present; clear amount/shipping/bundling
    p.amount = undefined;
    p.shipping = undefined;
    if (p.appliesTo) p.appliesTo.bundling = undefined;
  } else if (type === 'amount') {
    // amount voucher: clear percent/shipping/bundling
    p.percent = undefined;
    p.shipping = undefined;
    if (p.appliesTo) p.appliesTo.bundling = undefined;
  } else if (type === 'bundling') {
    // bundling needs appliesTo.bundling.*; clear percent/amount/shipping
    p.percent = undefined;
    p.amount = undefined;
    p.shipping = undefined;
  } else if (type === 'shipping') {
    // keep shipping object; clear percent/amount/bundling (item discounts)
    p.percent = undefined;
    p.amount = undefined;
    if (p.appliesTo) p.appliesTo.bundling = undefined;
  } else {
    // unknown: don't aggressively clear
  }

  return p;
}

/* ===================== Normalization & generic checks ===================== */
function normalizeCommon(payload = {}, { isUpdate = false } = {}) {
  const p = { ...payload };

  // Numeric normalization
  if ('target' in p && typeof p.target === 'string') p.target = p.target;
  if ('percent' in p)
    p.percent = Number.isFinite(+p.percent) ? +p.percent : undefined;
  if ('amount' in p)
    p.amount = Number.isFinite(+p.amount)
      ? Math.max(0, Math.trunc(+p.amount))
      : undefined;

  // shipping object normalization (if provided)
  if (p.shipping && typeof p.shipping === 'object') {
    p.shipping = {
      percent:
        p.shipping.percent !== undefined
          ? Math.max(0, Math.min(100, Number(p.shipping.percent) || 0))
          : 100,
      maxAmount:
        p.shipping.maxAmount !== undefined
          ? Math.max(0, asInt(p.shipping.maxAmount, 0))
          : 0
    };
  }

  // appliesTo.bundling normalization
  if (p.appliesTo && p.appliesTo.bundling) {
    p.appliesTo.bundling.buyQty = Math.max(
      0,
      asInt(p.appliesTo.bundling.buyQty, 0)
    );
    p.appliesTo.bundling.getPercent = Math.max(
      0,
      Math.min(100, asInt(p.appliesTo.bundling.getPercent, 0))
    );
    // targetMenuIds left as is (array of ids)
  }

  // visibility normalization
  if (p.visibility && typeof p.visibility === 'object') {
    if ('startAt' in p.visibility)
      p.visibility.startAt = asDate(p.visibility.startAt);
    if ('endAt' in p.visibility)
      p.visibility.endAt = asDate(p.visibility.endAt);
    if ('globalStock' in p.visibility)
      p.visibility.globalStock = Math.max(
        0,
        asInt(p.visibility.globalStock, 0)
      );
    if ('perMemberLimit' in p.visibility)
      p.visibility.perMemberLimit = Math.max(
        0,
        asInt(p.visibility.perMemberLimit, 1)
      );
  }

  // usage normalization
  if (p.usage && typeof p.usage === 'object') {
    if ('maxUsePerClaim' in p.usage)
      p.usage.maxUsePerClaim = Math.max(1, asInt(p.usage.maxUsePerClaim, 1));
    if ('useValidDaysAfterClaim' in p.usage)
      p.usage.useValidDaysAfterClaim = Math.max(
        0,
        asInt(p.usage.useValidDaysAfterClaim, 0)
      );
    if ('claimRequired' in p.usage)
      p.usage.claimRequired = Boolean(p.usage.claimRequired);
    if ('stackableWithShipping' in p.usage)
      p.usage.stackableWithShipping = Boolean(p.usage.stackableWithShipping);
    if ('stackableWithOthers' in p.usage)
      p.usage.stackableWithOthers = Boolean(p.usage.stackableWithOthers);
  }

  // top-level booleans/flags
  if ('isActive' in p) p.isActive = Boolean(p.isActive);
  if ('isDeleted' in p) p.isDeleted = Boolean(p.isDeleted);

  // dates at top-level (if provided)
  if ('publishStart' in p) p.publishStart = asDate(p.publishStart);
  if ('publishEnd' in p) p.publishEnd = asDate(p.publishEnd);
  if ('claimUntil' in p) p.claimUntil = asDate(p.claimUntil);
  if ('useStart' in p) p.useStart = asDate(p.useStart);
  if ('useEnd' in p) p.useEnd = asDate(p.useEnd);

  // sanity checks (only if both sides present)
  const err = (msg) => throwError(msg, 400);
  if (p.publishStart && p.publishEnd && p.publishStart > p.publishEnd)
    err('publishStart tidak boleh setelah publishEnd');
  if (p.useStart && p.useEnd && p.useStart > p.useEnd)
    err('useStart tidak boleh setelah useEnd');
  if (p.claimUntil && p.useEnd && p.claimUntil > p.useEnd)
    err('claimUntil tidak boleh setelah useEnd (masa pakai terakhir).');

  p._updateGuard = { isUpdate };

  return p;
}

/* ===================== Type-specific validators ===================== */
function validatePercentPayload(p) {
  if (p.percent === undefined || !Number.isFinite(p.percent))
    throwError('Field "percent" wajib untuk voucher type "percent".', 400);
  if (p.percent < 0 || p.percent > 100)
    throwError('Field "percent" harus antara 0 - 100.', 400);
  // optional cap
  if (p.maxDiscount !== undefined && asInt(p.maxDiscount, NaN) < 0)
    throwError('maxDiscount tidak valid', 400);
}

function validateAmountPayload(p) {
  if (p.amount === undefined || !Number.isFinite(p.amount))
    throwError('Field "amount" wajib untuk voucher type "amount".', 400);
  if (p.amount < 0) throwError('Field "amount" harus >= 0.', 400);
}

function validateBundlingPayload(p) {
  const b = p.appliesTo && p.appliesTo.bundling;
  if (!b)
    throwError('appliesTo.bundling wajib untuk voucher type "bundling".', 400);
  if (!b.buyQty || asInt(b.buyQty, 0) < 1)
    throwError('bundling.buyQty harus >= 1.', 400);
  if (
    (!b.targetMenuIds ||
      !Array.isArray(b.targetMenuIds) ||
      b.targetMenuIds.length === 0) &&
    (!p.appliesTo.menuIds || !p.appliesTo.menuIds.length)
  ) {
    // require at least a target set
    throwError(
      'bundling.targetMenuIds atau appliesTo.menuIds wajib untuk bundling (target diskon).',
      400
    );
  }
  if (
    (b.getPercent === undefined || !Number.isFinite(b.getPercent)) &&
    p.amount === undefined
  ) {
    // allow getPercent or flat amount on target; require one
    throwError(
      'bundling.getPercent (0-100) atau amount harus diset untuk diskon pada item target.',
      400
    );
  }
  if (b.getPercent !== undefined && (b.getPercent < 0 || b.getPercent > 100))
    throwError('bundling.getPercent harus antara 0-100.', 400);
}

function validateShippingPayload(p) {
  if (!p.shipping || typeof p.shipping !== 'object')
    throwError('Field "shipping" wajib untuk voucher type "shipping".', 400);
  if (p.shipping.percent === undefined || !Number.isFinite(p.shipping.percent))
    throwError('shipping.percent wajib antara 0-100.', 400);
  if (p.shipping.percent < 0 || p.shipping.percent > 100)
    throwError('shipping.percent harus antara 0-100.', 400);
  if (p.shipping.maxAmount !== undefined && asInt(p.shipping.maxAmount, 0) < 0)
    throwError('shipping.maxAmount tidak valid', 400);
}

/* ===================== CREATE per-type (and generic) ===================== */

exports.createPercentVoucher = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });
  payload.type = 'percent';
  // clear unrelated
  payload = cleanseIrrelevantFieldsByType(payload, 'percent');
  validatePercentPayload(payload);

  // defaults
  if (payload.isDeleted == null) payload.isDeleted = false;
  if (payload.isActive == null) payload.isActive = false;

  const v = await Voucher.create(payload);
  res.status(201).json({ voucher: v });
});

exports.createAmountVoucher = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });
  payload.type = 'amount';
  payload = cleanseIrrelevantFieldsByType(payload, 'amount');
  validateAmountPayload(payload);

  if (payload.isDeleted == null) payload.isDeleted = false;
  if (payload.isActive == null) payload.isActive = false;

  const v = await Voucher.create(payload);
  res.status(201).json({ voucher: v });
});

exports.createBundlingVoucher = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });
  payload.type = 'bundling';
  payload = cleanseIrrelevantFieldsByType(payload, 'bundling');
  validateBundlingPayload(payload);

  if (payload.isDeleted == null) payload.isDeleted = false;
  if (payload.isActive == null) payload.isActive = false;

  const v = await Voucher.create(payload);
  res.status(201).json({ voucher: v });
});

exports.createShippingVoucher = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });
  payload.type = 'shipping';
  payload = cleanseIrrelevantFieldsByType(payload, 'shipping');
  validateShippingPayload(payload);

  if (payload.isDeleted == null) payload.isDeleted = false;
  if (payload.isActive == null) payload.isActive = false;

  const v = await Voucher.create(payload);
  res.status(201).json({ voucher: v });
});

/* ===================== LIST / DETAIL ===================== */
exports.listVoucher = asyncHandler(async (req, res) => {
  const { q, type } = req.query || {};
  const limit = Math.min(Math.max(asInt(req.query.limit || 50, 50), 1), 200);
  const cursor = req.query.cursor;

  const filter = { isDeleted: false };
  if (q) filter.name = new RegExp(String(q), 'i');
  if (type) filter.type = String(type);

  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) filter.createdAt = { $lt: d };
  }

  const items = await Voucher.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .lean();

  const total = await Voucher.countDocuments(filter);

  const rows = items.slice(0, limit);
  const next_cursor =
    items.length > limit && items[limit] && items[limit].createdAt
      ? new Date(items[limit].createdAt).toISOString()
      : null;

  res.json({
    limit,
    next_cursor,
    total,
    data: rows
  });
});

exports.getVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id).lean();
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);
  res.json({ voucher: v });
});

/* ===================== UPDATE (type-aware) ===================== */
exports.updateVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  // Normalize incoming
  let incoming = normalizeCommon(req.body || {}, { isUpdate: true });

  // If type is provided and different, disallow changing type when active
  const incomingType = incoming.type
    ? String(incoming.type).toLowerCase()
    : undefined;
  if (incomingType && incomingType !== String(v.type) && v.isActive) {
    throwError('Voucher sudah aktif, tidak boleh mengubah type.', 400);
  }
  const finalType = incomingType || String(v.type);

  // Cleanse unrelated fields
  incoming = cleanseIrrelevantFieldsByType(incoming, finalType);

  // Type-specific validation (only validate if provided or new)
  if (finalType === 'percent' && (incoming.percent !== undefined || !v.percent))
    validatePercentPayload({ ...(v.toObject ? v.toObject() : v), ...incoming });
  if (finalType === 'amount' && (incoming.amount !== undefined || !v.amount))
    validateAmountPayload({ ...(v.toObject ? v.toObject() : v), ...incoming });
  if (finalType === 'bundling')
    validateBundlingPayload({
      ...(v.toObject ? v.toObject() : v),
      ...incoming
    });
  if (finalType === 'shipping')
    validateShippingPayload({
      ...(v.toObject ? v.toObject() : v),
      ...incoming
    });

  // Merge & save (only update fields provided)
  Object.keys(incoming).forEach((k) => {
    // allow nested objects assignment (shallow)
    v[k] = incoming[k];
  });

  // optional guard: if isStackable true but target != shipping -> reject
  if (v.isStackable && String(v.target || '').toLowerCase() !== 'shipping') {
    throwError('isStackable hanya valid untuk voucher target "shipping".', 400);
  }

  await v.save();
  res.json({ voucher: v.toObject() });
});

/* ===================== Activate / Deactivate / Remove ===================== */
exports.activateVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  // minimal checks per type
  if (!v.name || !String(v.name).trim())
    throwError('Nama voucher wajib diisi sebelum aktivasi.', 400);

  if (String(v.type) === 'percent') {
    if (!Number.isFinite(Number(v.percent)))
      throwError('percent tidak valid untuk voucher percent.', 400);
  }
  if (String(v.type) === 'amount') {
    if (!Number.isFinite(Number(v.amount)))
      throwError('amount tidak valid untuk voucher amount.', 400);
  }
  if (String(v.type) === 'bundling') {
    if (!v.appliesTo || !v.appliesTo.bundling)
      throwError('bundling config wajib sebelum aktivasi.', 400);
  }
  if (String(v.type) === 'shipping') {
    if (!v.shipping || !Number.isFinite(Number(v.shipping.percent)))
      throwError('shipping config wajib sebelum aktivasi.', 400);
  }

  // Sanity periode
  if (v.useStart && v.useEnd && v.useStart > v.useEnd)
    throwError('useStart tidak boleh setelah useEnd.', 400);
  if (v.claimUntil && v.useEnd && v.claimUntil > v.useEnd)
    throwError('claimUntil tidak boleh setelah useEnd.', 400);

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

  // Hapus semua voucher claims yang berhubungan (hard delete)
  try {
    await VoucherClaim.deleteMany({ voucher: v._id });
  } catch (e) {
    // jangan block proses penghapusan voucher walau gagal hapus claim,
    // tapi log supaya bisa dicek.
    console.error(
      '[removeVoucher] gagal hapus VoucherClaim terkait:',
      e?.message || e
    );
  }

  await v.deleteOne();

  res.json({ ok: true, deleted: true });
});
