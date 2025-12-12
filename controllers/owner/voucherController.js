const mongoose = require('mongoose');
const asyncHandler = require('express-async-handler');
const Voucher = require('../../models/voucherModel');
const VoucherClaim = require('../../models/voucherClaimModel');
const throwError = require('../../utils/throwError');
const Member = require('../../models/memberModel');
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

exports.createPercentVoucher = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });
  payload.type = 'percent';
  payload = cleanseIrrelevantFieldsByType(payload, 'percent');
  validatePercentPayload(payload);

  if (payload.isDeleted == null) payload.isDeleted = false;
  if (payload.isActive == null) payload.isActive = false;

  if (payload.visibility?.mode === 'global_stock') {
    if (
      !payload.visibility.globalStock ||
      payload.visibility.globalStock === 0
    ) {
      payload.visibility.globalStock = 0;
    }
  }

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

  // --- FIX ---
  if (payload.visibility?.mode === 'global_stock') {
    if (
      !payload.visibility.globalStock ||
      payload.visibility.globalStock === 0
    ) {
      payload.visibility.globalStock = 0;
    }
  }

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

  // --- FIX ---
  if (payload.visibility?.mode === 'global_stock') {
    if (
      !payload.visibility.globalStock ||
      payload.visibility.globalStock === 0
    ) {
      payload.visibility.globalStock = null;
    }
  }

  const v = await Voucher.create(payload);
  res.status(201).json({ voucher: v });
});

exports.listVoucher = asyncHandler(async (req, res) => {
  const { q, type, page = 1, pageSize = 50 } = req.query || {};
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const filter = { isDeleted: false };
  if (q) filter.name = { $regex: String(q), $options: 'i' };
  if (type) filter.type = String(type);

  const [total, items] = await Promise.all([
    Voucher.countDocuments(filter),
    Voucher.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
  ]);

  const typeLabelMap = {
    percent: 'Diskon persentase',
    amount: 'Potongan nominal',
    shipping: 'Ongkir',
    bundling: 'Bundling'
    // tambahkan mapping lain kalau perlu
  };

  const now = Date.now();

  const rows = (items || []).map((v) => {
    const endAtRaw =
      v.visibility && v.visibility.endAt ? new Date(v.visibility.endAt) : null;
    const endAtTs =
      endAtRaw && !isNaN(endAtRaw.getTime()) ? endAtRaw.getTime() : null;

    const globalStock =
      v.visibility && typeof v.visibility.globalStock !== 'undefined'
        ? v.visibility.globalStock
        : null;

    const expired = endAtTs !== null ? now > endAtTs : false;
    const soldOut = typeof globalStock === 'number' ? globalStock === 0 : false;

    return {
      id: String(v._id),
      name: v.name || '',
      type: v.type || '',
      typeLabel: typeLabelMap[String(v.type || '')] || String(v.type || ''),
      globalStock: globalStock,
      endAt: endAtTs ? new Date(endAtTs).toISOString() : null,
      isActive: !!v.isActive,
      isUnavailable: expired || soldOut
    };
  });

  res.json({
    total,
    page: Math.max(Number(page) || 1, 1),
    pageSize: limit,
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

exports.activateVoucher = asyncHandler(async (req, res) => {
  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  // same validations as before...
  if (!v.name || !String(v.name).trim())
    throwError('Nama voucher wajib diisi sebelum aktivasi.', 400);
  if (String(v.type) === 'percent' && !Number.isFinite(Number(v.percent)))
    throwError('percent tidak valid untuk voucher percent.', 400);
  if (String(v.type) === 'amount' && !Number.isFinite(Number(v.amount)))
    throwError('amount tidak valid untuk voucher amount.', 400);
  if (String(v.type) === 'bundling' && (!v.appliesTo || !v.appliesTo.bundling))
    throwError('bundling config wajib sebelum aktivasi.', 400);
  if (
    String(v.type) === 'shipping' &&
    (!v.shipping || !Number.isFinite(Number(v.shipping.percent)))
  )
    throwError('shipping config wajib sebelum aktivasi.', 400);
  if (v.useStart && v.useEnd && v.useStart > v.useEnd)
    throwError('useStart tidak boleh setelah useEnd.', 400);
  if (v.claimUntil && v.useEnd && v.claimUntil > v.useEnd)
    throwError('claimUntil tidak boleh setelah useEnd.', 400);

  v.isActive = true;
  await v.save();

  const shouldAutoAssign = v.usage && v.usage.claimRequired === false;
  if (!shouldAutoAssign) {
    return res.json({ voucher: v.toObject() });
  }

  const chunkSize =
    Number(req.body.chunkSize) && Number(req.body.chunkSize) > 0
      ? Math.min(Math.max(Number(req.body.chunkSize), 50), 2000)
      : 500;
  const dryRun = req.body.dryRun === true || req.body.dryRun === 'true';
  const forceReassign =
    req.body.forceReassign === true || req.body.forceReassign === 'true';

  const target = v.target || {};
  // safer building of memberQuery: default all, then apply include/exclude carefully
  let memberQuery = {};
  // prefer explicit is_active filter only if your system uses it to mean active members
  memberQuery.is_active = true;

  // apply include/exclude only when non-empty arrays
  if (
    Array.isArray(target.includeMemberIds) &&
    target.includeMemberIds.length > 0
  ) {
    memberQuery._id = {
      $in: target.includeMemberIds.map((id) => mongoose.Types.ObjectId(id))
    };
  }
  if (
    Array.isArray(target.excludeMemberIds) &&
    target.excludeMemberIds.length > 0
  ) {
    if (!memberQuery._id) memberQuery._id = {};
    memberQuery._id.$nin = target.excludeMemberIds.map((id) =>
      mongoose.Types.ObjectId(id)
    );
  }

  // interpret stock: 0 or null => unlimited per your preference earlier
  const rawStock =
    v.visibility && typeof v.visibility.globalStock !== 'undefined'
      ? v.visibility.globalStock
      : null;
  const globalStockIsUnlimited = rawStock === null || Number(rawStock) === 0;
  const usingGlobalStock =
    String(v.visibility?.mode || '') === 'global_stock' &&
    !globalStockIsUnlimited;

  // --- DEBUG: counts BEFORE doing anything ---
  const memberCount = await Member.countDocuments(memberQuery).catch((e) => {
    console.error('[activateVoucher][debug] countDocuments error', e);
    return 0;
  });
  const existingClaimCount = await VoucherClaim.countDocuments({
    voucher: v._id
  }).catch((e) => {
    console.error('[activateVoucher][debug] existing claim count error', e);
    return 0;
  });

  // Return diagnostics immediately if dryRun=true or if the client asked for debug
  if (dryRun || req.query.debug === 'true') {
    return res.json({
      voucher: v.toObject(),
      memberQuery,
      memberCount,
      existingClaimCount,
      note: 'dryRun / debug mode - no assignment performed. Jika memberCount=0 berarti query tidak match any member.'
    });
  }

  // If memberCount is 0, bail early and report (avoids long running job)
  if (!memberCount) {
    return res.json({
      voucher: v.toObject(),
      assigned: 0,
      skipped: 0,
      note: 'Tidak ada member yang match memberQuery. Periksa memberQuery atau data member.'
    });
  }

  // proceed with the same auto-assign logic you already have but simplified here:
  // we will reuse flushChunkAndInsert from your previous implementation (assumed present)
  // For brevity, include the existing flushChunkAndInsert function body here (same as previous code)
  // <-- PASTE YOUR flushChunkAndInsert implementation here (unchanged) -->

  // To keep response short for now, I'll demonstrate minimal flow:
  const MemberCursor = Member.find(memberQuery).select('_id').cursor();
  let totalAssigned = 0;
  let totalSkipped = 0;
  let stoppedDueToStock = false;
  const buffer = [];

  try {
    for await (const m of MemberCursor) {
      buffer.push(String(m._id));
      if (buffer.length >= chunkSize) {
        const chunk = buffer.splice(0);
        const r = await flushChunkAndInsert(chunk);
        if (!r.ok) {
          if (r.reason === 'no_stock') {
            stoppedDueToStock = true;
            break;
          } else console.error('[activateVoucher] chunk insert issue', r);
        } else {
          totalAssigned += r.insertedCount || 0;
          totalSkipped += r.skipped || 0;
          if (r.partial) {
            stoppedDueToStock = true;
            break;
          }
        }
      }
    }
    if (!stoppedDueToStock && buffer.length) {
      const r = await flushChunkAndInsert(buffer.splice(0));
      if (!r.ok && r.reason === 'no_stock') stoppedDueToStock = true;
      else if (r.ok) {
        totalAssigned += r.insertedCount || 0;
        totalSkipped += r.skipped || 0;
        if (r.partial) stoppedDueToStock = true;
      }
    }
  } catch (e) {
    console.error(
      '[activateVoucher] fatal during auto-assign',
      e?.message || e
    );
  } finally {
    try {
      if (MemberCursor && typeof MemberCursor.close === 'function')
        await MemberCursor.close();
    } catch (_) {}
  }

  // save metadata and return
  try {
    v.autoAssignedAt = new Date();
    v.autoAssignedCount =
      (v.autoAssignedCount ? Number(v.autoAssignedCount) : 0) + totalAssigned;
    await v.save();
  } catch (e) {
    console.error('[activateVoucher] save metadata err', e?.message || e);
  }

  return res.json({
    voucher: v.toObject(),
    assigned: totalAssigned,
    skipped: totalSkipped,
    memberCount,
    existingClaimCount,
    note: globalStockIsUnlimited
      ? 'Auto-assign selesai (unlimited stock).'
      : stoppedDueToStock
      ? 'Auto-assign berhenti karena stok habis.'
      : 'Auto-assign selesai.'
  });
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

exports.listMembers = asyncHandler(async (req, res) => {
  const asInt = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : d;
  };

  function escapeRegex(str) {
    if (!str) return '';
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // build match mirip listMemberSummary: support q (name/phone) tokenization
  function buildMemberMatch({ q = '' } = {}) {
    const match = { is_active: true };
    const raw = String(q || '').trim();
    if (!raw) return match;

    const keyword = raw.replace(/\s+/g, ' ').trim();
    const digitsOnly = keyword.replace(/\D+/g, '');
    const onlyDigits =
      digitsOnly.length > 0 &&
      /^\d+$/.test(digitsOnly) &&
      digitsOnly.length >= 3;

    if (onlyDigits) {
      match.$or = [
        { phone: { $regex: escapeRegex(digitsOnly), $options: 'i' } },
        { name: { $regex: escapeRegex(keyword), $options: 'i' } }
      ];
      return match;
    }

    const safe = escapeRegex(keyword);
    const tokens = safe.split(/\s+/).filter(Boolean);

    if (tokens.length === 1) {
      const t = tokens[0];
      match.$or = [
        { name: { $regex: t, $options: 'i' } },
        { phone: { $regex: keyword.replace(/\D+/g, ''), $options: 'i' } }
      ];
    } else if (tokens.length > 1) {
      match.$and = tokens.map((t) => ({ name: { $regex: t, $options: 'i' } }));
    }

    return match;
  }

  // parse params
  let { limit = 100, q = '', cursor = null } = req.query || {};
  limit = Math.min(Math.max(asInt(limit, 100), 1), 100); // clamp 1..100

  const baseMatch = buildMemberMatch({ q });

  // cursor: expect ISO datetime string (createdAt). If provided, use createdAt < cursor for pagination
  const matchCursor = {};
  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) {
      matchCursor.createdAt = { $lt: d };
    } else {
      // jika cursor bukan date yang valid, tolak supaya FE tahu
      throwError('Cursor tidak valid (harus berupa ISO date string)', 400);
    }
  }

  // gabungkan match
  const combined = Object.keys(matchCursor).length
    ? { $and: [baseMatch, matchCursor] }
    : baseMatch;

  // pipeline: match -> sort desc by createdAt -> limit+1 -> project minimal fields
  const pipeline = [
    { $match: combined },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit + 1 },
    {
      $project: {
        _id: 1,
        name: 1,
        phone: 1,
        createdAt: 1
      }
    }
  ];

  const raw = await Member.aggregate(pipeline).allowDiskUse(true);

  // next_cursor logic (createdAt of extra item)
  let next_cursor = null;
  let rows = raw;
  if (Array.isArray(raw) && raw.length > limit) {
    const extra = raw[limit]; // extra item
    next_cursor = extra?.createdAt
      ? new Date(extra.createdAt).toISOString()
      : null;
    rows = raw.slice(0, limit);
  }

  const data = (rows || []).map((m) => ({
    id: String(m._id),
    name: m.name || '',
    phone: m.phone || '',
    createdAt: m.createdAt || null
  }));

  res.status(200).json({
    ok: true,
    count: data.length,
    next_cursor,
    data
  });
});
