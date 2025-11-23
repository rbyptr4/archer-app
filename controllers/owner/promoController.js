// controllers/promoController.js
const asyncHandler = require('express-async-handler');
const Promo = require('../../models/promoModel');
const { findApplicablePromos } = require('../../utils/promoEngine');
const Member = require('../../models/memberModel');
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
  if (!v) return null;
  const d = new Date(v);
  return !isNaN(d.getTime()) ? d : null;
};

/* ---------------- normalize & cleanse ---------------- */
/**
 * normalizeCommon(payload, { isUpdate })
 * - menormalisasi tipe dasar & fields umum
 * - menormalisasi reward: accept payload.reward (object) OR payload.rewards (array/object)
 *   -> normalize to single payload.reward object
 */
function normalizeCommon(payload = {}, { isUpdate = false } = {}) {
  const p = JSON.parse(JSON.stringify(payload || {})); // shallow clone

  // numeric normalizations
  if ('priority' in p) p.priority = asInt(p.priority, 0);
  if ('perMemberLimit' in p)
    p.perMemberLimit = Math.max(0, asInt(p.perMemberLimit, 0));
  if ('globalStock' in p)
    p.globalStock =
      p.globalStock === null ? null : Math.max(0, asInt(p.globalStock, 0));

  // booleans
  if ('autoApply' in p) p.autoApply = Boolean(p.autoApply);
  if ('stackable' in p) p.stackable = Boolean(p.stackable);
  if ('blocksVoucher' in p) p.blocksVoucher = Boolean(p.blocksVoucher);
  if ('isActive' in p) p.isActive = Boolean(p.isActive);

  // dates inside conditions
  if (p.conditions && typeof p.conditions === 'object') {
    if ('startAt' in p.conditions)
      p.conditions.startAt = asDate(p.conditions.startAt);
    if ('endAt' in p.conditions)
      p.conditions.endAt = asDate(p.conditions.endAt);
    if ('minTotal' in p.conditions)
      p.conditions.minTotal = Math.max(0, Number(p.conditions.minTotal || 0));
    if ('minQty' in p.conditions)
      p.conditions.minQty = Math.max(0, Number(p.conditions.minQty || 0));
    if (
      'audience' in p.conditions &&
      !['all', 'members'].includes(p.conditions.audience)
    )
      p.conditions.audience = 'all';
    // NOTE: birthdayWindowDays telah dihapus dari model jadi tidak diproses
  } else {
    p.conditions = p.conditions || {};
  }

  // --- reward normalization: support legacy array OR single object ---
  // Accept: payload.reward (object) OR payload.rewards (array/object)
  if (!p.reward) {
    if (Array.isArray(p.rewards) && p.rewards.length) {
      p.reward = { ...(p.rewards[0] || {}) };
    } else if (p.rewards && typeof p.rewards === 'object') {
      p.reward = { ...(p.rewards || {}) };
    } else {
      p.reward = {};
    }
  }

  // remove legacy field to avoid confusion
  delete p.rewards;

  // normalize numeric fields inside reward
  const rr = { ...(p.reward || {}) };
  if ('freeQty' in rr) rr.freeQty = Math.max(0, asInt(rr.freeQty, 1));
  if ('percent' in rr)
    rr.percent = Number.isFinite(Number(rr.percent))
      ? Number(rr.percent)
      : null;
  if ('amount' in rr)
    rr.amount = Number.isFinite(Number(rr.amount))
      ? Math.max(0, Number(rr.amount))
      : null;
  if ('pointsFixed' in rr)
    rr.pointsFixed = Number.isFinite(Number(rr.pointsFixed))
      ? Math.max(0, Number(rr.pointsFixed))
      : null;
  if ('pointsPercent' in rr)
    rr.pointsPercent = Number.isFinite(Number(rr.pointsPercent))
      ? Math.max(0, Number(rr.pointsPercent))
      : null;
  if ('grantMembership' in rr) rr.grantMembership = Boolean(rr.grantMembership);

  // default appliesTo (sesuai model kamu sebelumnya default 'menu')
  rr.appliesTo = rr.appliesTo ?? 'menu';
  rr.appliesToCategory = rr.appliesToCategory ?? null;
  rr.appliesToMenuId = rr.appliesToMenuId ?? null;

  p.reward = rr;

  p._updateGuard = { isUpdate };
  return p;
}

/**
 * cleanseIrrelevantFieldsByType(payload, type)
 * - hapus / set null field reward yang tidak relevan utk tiap tipe
 * - payload.reward adalah object tunggal
 */
function cleanseIrrelevantFieldsByType(payload = {}, type) {
  const p = { ...(payload || {}) };
  p.reward = p.reward || {};

  const r = { ...(p.reward || {}) };

  if (type === 'cart_percent') {
    r.percent = r.percent !== undefined ? r.percent : null;
    r.amount = null;
    // fixedPriceBundle removed from model
  } else if (type === 'cart_amount') {
    r.amount = r.amount !== undefined ? r.amount : null;
    r.percent = null;
  } else if (type === 'free_item' || type === 'buy_x_get_y') {
    r.freeMenuId = r.freeMenuId || null;
    r.freeQty = r.freeQty ?? 1;
    r.percent = null;
    r.amount = null;
  } else if (type === 'bundling') {
    // bundling: flexible, don't require fixed price bundle
    r.freeMenuId = r.freeMenuId ?? null;
    r.freeQty = r.freeQty ?? 0;
    r.percent = null;
    r.amount = null;
  } else if (type === 'award_points') {
    r.pointsFixed = r.pointsFixed ?? null;
    r.pointsPercent = r.pointsPercent ?? null;
    r.freeMenuId = null;
    r.freeQty = 0;
    r.percent = null;
    r.amount = null;
  } else if (type === 'grant_membership') {
    r.grantMembership = true;
  } else {
    // fallback: keep what's provided, but ensure some defaults
    r.freeMenuId = r.freeMenuId ?? null;
    r.freeQty = r.freeQty ?? 0;
    r.percent = r.percent ?? null;
    r.amount = r.amount ?? null;
  }

  r.appliesTo = r.appliesTo ?? 'menu';
  r.appliesToCategory = r.appliesToCategory ?? null;
  r.appliesToMenuId = r.appliesToMenuId ?? null;

  p.reward = r;
  delete p.rewards;
  return p;
}

/* ---------------- validators ---------------- */

function validateConditions(c) {
  if (!c) return;
  if (c.minTotal && Number(c.minTotal) < 0)
    throwError('conditions.minTotal harus >= 0', 400);
  if (c.minQty && Number(c.minQty) < 0)
    throwError('conditions.minQty harus >= 0', 400);
  if (Array.isArray(c.items)) {
    for (const it of c.items) {
      if (!it) continue;
      if (it.qty && Number(it.qty) < 1)
        throwError('conditions.items.qty harus >= 1', 400);
    }
  }
  if (c.startAt && c.endAt && new Date(c.startAt) > new Date(c.endAt))
    throwError('conditions.startAt tidak boleh setelah conditions.endAt', 400);
}

function validateRewardByType(reward = {}, type) {
  const r = reward || {};
  switch (type) {
    case 'cart_percent':
      if (
        r.percent === null ||
        r.percent === undefined ||
        !Number.isFinite(Number(r.percent))
      )
        throwError('reward.percent wajib untuk tipe cart_percent', 400);
      if (r.percent < 0 || r.percent > 100)
        throwError('reward.percent harus antara 0-100', 400);
      break;
    case 'cart_amount':
      if (
        r.amount === null ||
        r.amount === undefined ||
        !Number.isFinite(Number(r.amount))
      )
        throwError('reward.amount wajib untuk tipe cart_amount', 400);
      if (r.amount < 0) throwError('reward.amount harus >= 0', 400);
      break;
    case 'free_item':
    case 'buy_x_get_y':
      if (!r.freeMenuId)
        throwError(
          'reward.freeMenuId wajib untuk free_item / buy_x_get_y',
          400
        );
      if (r.freeQty !== undefined && asInt(r.freeQty, 0) < 1)
        throwError('reward.freeQty harus >= 1', 400);
      break;
    case 'bundling':
      // no strict validation (flexible)
      break;
    case 'award_points':
      if (
        (r.pointsFixed === null || r.pointsFixed === undefined) &&
        (r.pointsPercent === null || r.pointsPercent === undefined)
      )
        throwError(
          'reward.pointsFixed atau reward.pointsPercent wajib untuk award_points',
          400
        );
      break;
    case 'grant_membership':
      // no strict field required
      break;
    default:
      // keep lenient
      break;
  }
}

/* ---------------- controller handlers ---------------- */

exports.create = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });

  if (!payload.name || !String(payload.name).trim())
    throwError('Field "name" wajib', 400);
  if (!payload.type) throwError('Field "type" wajib', 400);

  payload = cleanseIrrelevantFieldsByType(payload, String(payload.type));

  validateConditions(payload.conditions);
  validateRewardByType(payload.reward || {}, String(payload.type));

  if (payload.isActive == null) payload.isActive = false;
  if (payload.stackable == null) payload.stackable = false;
  if (payload.autoApply == null) payload.autoApply = true;

  if (req.user && req.user.id) payload.createdBy = req.user.id;

  const doc = await Promo.create(payload);
  res.status(201).json({ promo: doc.toObject() });
});

exports.list = asyncHandler(async (req, res) => {
  const {
    q,
    isActive,
    page = 1,
    pageSize = 25,
    type,
    sortBy = 'priority',
    sortDir = 'desc'
  } = req.query || {};

  const filter = {};
  if (q) filter.name = new RegExp(String(q), 'i');
  if (isActive !== undefined) {
    const b = asBool(isActive);
    if (typeof b === 'boolean') filter.isActive = b;
  }
  if (type) filter.type = String(type);

  const perPage = Math.min(Math.max(asInt(pageSize, 25), 1), 200);
  const skip = (Math.max(asInt(page, 1), 1) - 1) * perPage;

  const dir = String(sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const sort = {};
  sort[String(sortBy || 'priority')] = dir;
  sort.createdAt = -1;

  const [total, items] = await Promise.all([
    Promo.countDocuments(filter),
    Promo.find(filter).sort(sort).skip(skip).limit(perPage).lean()
  ]);

  res.json({
    promos: items,
    total,
    page: Math.max(asInt(page, 1), 1),
    pageSize: perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage))
  });
});

exports.update = asyncHandler(async (req, res) => {
  const p = await Promo.findById(req.params.id);
  if (!p) throwError('Promo tidak ditemukan', 404);

  let incoming = normalizeCommon(req.body || {}, { isUpdate: true });

  const incomingType = incoming.type
    ? String(incoming.type).toLowerCase()
    : undefined;
  if (incomingType && incomingType !== String(p.type) && p.isActive) {
    throwError('Promo sudah aktif, tidak boleh mengubah type.', 400);
  }
  const finalType = incomingType || String(p.type);

  incoming = cleanseIrrelevantFieldsByType(incoming, finalType);

  validateConditions(incoming.conditions || p.conditions);
  validateRewardByType(incoming.reward || p.reward || {}, finalType);

  Object.keys(incoming).forEach((k) => {
    p[k] = incoming[k];
  });

  if (
    p.conditions &&
    p.conditions.startAt &&
    p.conditions.endAt &&
    new Date(p.conditions.startAt) > new Date(p.conditions.endAt)
  )
    throwError('conditions.startAt tidak boleh setelah conditions.endAt', 400);

  await p.save();
  res.json({ promo: p.toObject() });
});

exports.activate = asyncHandler(async (req, res) => {
  const p = await Promo.findById(req.params.id);
  if (!p) throwError('Promo tidak ditemukan', 404);

  if (!p.name || !String(p.name).trim())
    throwError('Nama promo wajib diisi sebelum aktivasi.', 400);

  const t = String(p.type);
  if (t === 'cart_percent') {
    const ok = p.reward && Number.isFinite(Number(p.reward.percent));
    if (!ok)
      throwError(
        'reward.percent wajib untuk tipe cart_percent sebelum aktivasi.',
        400
      );
  }
  if (t === 'cart_amount') {
    const ok = p.reward && Number.isFinite(Number(p.reward.amount));
    if (!ok)
      throwError(
        'reward.amount wajib untuk tipe cart_amount sebelum aktivasi.',
        400
      );
  }
  if (t === 'free_item' || t === 'buy_x_get_y') {
    const ok = p.reward && p.reward.freeMenuId;
    if (!ok)
      throwError(
        'reward.freeMenuId wajib untuk free_item/buy_x_get_y sebelum aktivasi.',
        400
      );
  }

  if (
    p.conditions &&
    p.conditions.startAt &&
    p.conditions.endAt &&
    new Date(p.conditions.startAt) > new Date(p.conditions.endAt)
  )
    throwError('conditions.startAt tidak boleh setelah conditions.endAt', 400);

  p.isActive = true;
  await p.save();
  res.json({ promo: p.toObject() });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const p = await Promo.findById(req.params.id);
  if (!p) throwError('Promo tidak ditemukan', 404);

  p.isActive = false;
  await p.save();
  res.json({ promo: p.toObject() });
});

exports.remove = asyncHandler(async (req, res) => {
  const p = await Promo.findById(req.params.id);
  if (!p) throwError('Promo tidak ditemukan', 404);

  await p.deleteOne();
  res.json({ ok: true, deleted: true });
});

/**
 * POST /promos/evaluate
 * body: { cart, memberId? }
 *
 * Mengembalikan ringkasan eligible promos untuk FE. rewardSummary sekarang dari p.reward (object tunggal)
 */
exports.evaluate = asyncHandler(async (req, res) => {
  const { cart, memberId } = req.body || {};
  if (!cart || !Array.isArray(cart.items))
    throwError('cart wajib dikirim', 400);

  let member = null;
  if (memberId) {
    member = await Member.findById(memberId).lean();
    if (!member) throwError('Member tidak ditemukan', 404);
  }

  const now = new Date();

  // provide simple fetchers: member usage count from member.promoUsageHistory
  const fetchers = {
    getMemberUsageCount: async (promoId, memberId, sinceDate) => {
      if (!member) return 0;
      const history = Array.isArray(member.promoUsageHistory)
        ? member.promoUsageHistory
        : [];
      return history.filter(
        (h) =>
          String(h.promoId) === String(promoId) &&
          new Date(h.usedAt || h.date) >= sinceDate
      ).length;
    }
    // getGlobalUsageCount left undefined: default behavior skip global window checks
  };

  const eligible = await findApplicablePromos(cart, member, now, { fetchers });

  const summary = eligible.map((p) => {
    const r = p.reward || {};
    const rewardSummary = {
      freeMenuId: r.freeMenuId || null,
      freeQty: r.freeQty || 0,
      percent: r.percent ?? null,
      amount: r.amount ?? null,
      pointsFixed: r.pointsFixed ?? null,
      grantMembership: !!r.grantMembership
    };
    return {
      id: String(p._id),
      name: p.name,
      type: p.type,
      desc: p.notes || null,
      blocksVoucher: !!p.blocksVoucher,
      autoApply: !!p.autoApply,
      priority: Number(p.priority || 0),
      rewardSummary
    };
  });

  res.json({ eligiblePromos: summary });
});
