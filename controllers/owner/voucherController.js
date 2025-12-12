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
  const mongoose = require('mongoose');
  const Member = require('../../models/memberModel');

  const v = await Voucher.findById(req.params.id);
  if (!v || v.isDeleted) throwError('Voucher tidak ditemukan', 404);

  // minimal checks per type
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

  // Sanity periode
  if (v.useStart && v.useEnd && v.useStart > v.useEnd)
    throwError('useStart tidak boleh setelah useEnd.', 400);
  if (v.claimUntil && v.useEnd && v.claimUntil > v.useEnd)
    throwError('claimUntil tidak boleh setelah useEnd.', 400);

  // Interpret stock BEFORE activation:
  // - rawStock === null  => unlimited
  // - rawStock === 0     => treated as "sold out" => reject activation (per your request)
  // - rawStock > 0       => using global stock
  const rawStock =
    v.visibility && typeof v.visibility.globalStock !== 'undefined'
      ? v.visibility.globalStock
      : null;
  const globalStockIsNull = rawStock === null;
  const globalStockIsZero = Number(rawStock) === 0 && !globalStockIsNull;
  const usingGlobalStock =
    String(v.visibility?.mode || '') === 'global_stock' && !globalStockIsNull;

  // If voucher uses numeric global stock and it's exactly 0 => block activation with error
  if (usingGlobalStock && globalStockIsZero) {
    throwError(
      'Global stock voucher = 0. Jika ingin unlimited set globalStock = null; jika ingin assign, set globalStock > 0 terlebih dahulu.',
      400
    );
  }

  // activate master voucher
  v.isActive = true;
  await v.save();

  // Auto-assign only when claimRequired === false (auto-claim)
  const shouldAutoAssign = v.usage && v.usage.claimRequired === false;
  if (!shouldAutoAssign) {
    return res.json({ voucher: v.toObject() });
  }

  // Options from request
  const chunkSize =
    Number(req.body.chunkSize) && Number(req.body.chunkSize) > 0
      ? Math.min(Math.max(Number(req.body.chunkSize), 50), 2000)
      : 500;
  const dryRun =
    req.body.dryRun === true ||
    req.body.dryRun === 'true' ||
    req.query.dryRun === 'true';
  const forceReassign =
    req.body.forceReassign === true || req.body.forceReassign === 'true';

  // Build member filter based on voucher.target (respect include/exclude if provided)
  const target = v.target || {};
  let memberQuery = {};
  memberQuery.is_active = true; // sesuai model/memberModel.js

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

  // Helper: try to take stock atomically for n items.
  // If globalStockIsNull -> unlimited, always ok.
  async function tryTakeStock(n) {
    if (globalStockIsNull) return { ok: true, taken: n };

    // otherwise rawStock > 0 (we already validated rawStock !== 0)
    const updated = await Voucher.findOneAndUpdate(
      { _id: v._id, 'visibility.globalStock': { $gte: n } },
      { $inc: { 'visibility.globalStock': -n } },
      { new: true }
    ).lean();

    if (updated) return { ok: true, taken: n };

    // partial path: read available then decrement by available
    const cur = await Voucher.findById(v._id)
      .select('visibility.globalStock')
      .lean();
    const avail = Number(cur?.visibility?.globalStock || 0);
    if (avail <= 0) return { ok: false, taken: 0 };

    await Voucher.findByIdAndUpdate(v._id, {
      $inc: { 'visibility.globalStock': -avail }
    });
    return { ok: true, taken: avail, partial: true };
  }

  // Helper: build claim doc(s) for a memberId
  const now = new Date();
  function buildClaimDocsForMember(memberId, qty = 1) {
    const docs = [];
    for (let i = 0; i < qty; i++) {
      const doc = {
        voucher: mongoose.Types.ObjectId(v._id),
        member: mongoose.Types.ObjectId(memberId),
        status: 'claimed',
        remainingUse: Math.max(1, Number(v.usage?.maxUsePerClaim || 1)),
        claimedAt: now,
        history: [
          {
            at: now,
            action: 'ASSIGNED_BY_OWNER',
            note: 'Auto-assign on activate'
          }
        ]
      };

      if (Number(v.usage?.useValidDaysAfterClaim || 0) > 0) {
        doc.validUntil = new Date(
          now.getTime() + Number(v.usage.useValidDaysAfterClaim) * 86400000
        );
      } else if (v.visibility && v.visibility.endAt) {
        doc.validUntil = v.visibility.endAt;
      }

      docs.push(doc);
    }
    return docs;
  }

  // flush chunk: filter existing perMemberLimit and insert
  async function flushChunkAndInsert(memberIdChunk) {
    if (!memberIdChunk || memberIdChunk.length === 0)
      return { ok: true, insertedCount: 0, skipped: 0 };

    const perMemberLimit = Math.max(
      1,
      Number(v.visibility?.perMemberLimit || 1)
    );
    const existingMap = {};

    if (!forceReassign) {
      // aggregate existing counts for this chunk
      const agg = await VoucherClaim.aggregate([
        {
          $match: {
            voucher: mongoose.Types.ObjectId(v._id),
            member: {
              $in: memberIdChunk.map((id) => mongoose.Types.ObjectId(id))
            }
          }
        },
        { $group: { _id: '$member', cnt: { $sum: 1 } } }
      ]);
      for (const it of agg) existingMap[String(it._id)] = it.cnt;
    }

    const docsToInsert = [];
    let skipped = 0;
    for (const mid of memberIdChunk) {
      const midStr = String(mid);
      const existingCnt = existingMap[midStr] || 0;
      const allowed = Math.max(0, perMemberLimit - existingCnt);
      if (allowed <= 0) {
        skipped++;
        continue;
      }
      const docs = buildClaimDocsForMember(mid, allowed);
      docsToInsert.push(...docs);
    }

    if (docsToInsert.length === 0)
      return { ok: true, insertedCount: 0, skipped };

    if (dryRun) {
      return {
        ok: true,
        insertedCount: 0,
        toCreate: docsToInsert.length,
        skipped
      };
    }

    // if using numeric stock (rawStock > 0), take stock based on docsToInsert length
    if (
      !globalStockIsNull &&
      String(v.visibility?.mode || '') === 'global_stock'
    ) {
      const stockRes = await tryTakeStock(docsToInsert.length);
      if (!stockRes.ok)
        return { ok: false, reason: 'no_stock', insertedCount: 0, skipped };
      if (stockRes.taken < docsToInsert.length) {
        const toInsert = docsToInsert.slice(0, stockRes.taken);
        const ins = await VoucherClaim.insertMany(toInsert, {
          ordered: false
        }).catch((e) => ({ error: e }));
        if (ins && ins.error) {
          console.error(
            '[activateVoucher] partial insertMany error',
            ins.error
          );
          return {
            ok: false,
            reason: 'insert_error',
            insertedCount: 0,
            skipped,
            error: ins.error
          };
        }
        return {
          ok: true,
          insertedCount: Array.isArray(ins) ? ins.length : 0,
          skipped,
          partial: true
        };
      }
      // else full insert below
    }

    const ins = await VoucherClaim.insertMany(docsToInsert, {
      ordered: false
    }).catch((e) => ({ error: e }));
    if (ins && ins.error) {
      console.error('[activateVoucher] insertMany error', ins.error);
      return {
        ok: false,
        reason: 'insert_error',
        insertedCount: 0,
        skipped,
        error: ins.error
      };
    }
    return {
      ok: true,
      insertedCount: Array.isArray(ins) ? ins.length : 0,
      skipped
    };
  }

  // Diagnostics before running
  const memberCount = await Member.countDocuments(memberQuery).catch((e) => {
    console.error('[activateVoucher] member count error', e);
    return 0;
  });
  const existingClaimCount = await VoucherClaim.countDocuments({
    voucher: v._id
  }).catch((e) => {
    console.error('[activateVoucher] existing claim count error', e);
    return 0;
  });

  if (dryRun || req.query.debug === 'true') {
    return res.json({
      voucher: v.toObject(),
      memberQuery,
      memberCount,
      existingClaimCount,
      note: 'dryRun/debug - tidak melakukan insert. Jika memberCount > 0 maka assign seharusnya bisa berjalan.'
    });
  }

  if (!memberCount) {
    return res.json({
      voucher: v.toObject(),
      assigned: 0,
      skipped: 0,
      memberCount,
      existingClaimCount,
      note: 'Tidak ada member yang match memberQuery. Periksa filter include/exclude atau is_active.'
    });
  }

  // Iterate members in chunks
  const cursor = Member.find(memberQuery).select('_id').cursor();
  const buffer = [];
  let totalAssigned = 0;
  let totalSkipped = 0;
  let stoppedDueToStock = false;

  try {
    for await (const m of cursor) {
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
      if (cursor && typeof cursor.close === 'function') await cursor.close();
    } catch (_) {}
  }

  // save metadata
  try {
    v.autoAssignedAt = new Date();
    v.autoAssignedCount =
      (v.autoAssignedCount ? Number(v.autoAssignedCount) : 0) + totalAssigned;
    await v.save();
  } catch (e) {
    console.error(
      '[activateVoucher] failed to save autoAssigned metadata',
      e?.message || e
    );
  }

  const note = globalStockIsNull
    ? 'Auto-assign selesai (unlimited stock).'
    : stoppedDueToStock
    ? 'Auto-assign berhenti karena stok habis.'
    : 'Auto-assign selesai.';

  return res.json({
    voucher: v.toObject(),
    assigned: totalAssigned,
    skipped: totalSkipped,
    memberCount,
    existingClaimCount,
    dryRun: !!dryRun,
    note
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
