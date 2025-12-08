// controllers/promoController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Promo = require('../../models/promoModel');
const { findApplicablePromos } = require('../../utils/promoEngine');
const Member = require('../../models/memberModel');
const Menu = require('../../models/menuModel');
const throwError = require('../../utils/throwError');

function isValidId(v) {
  try {
    return mongoose.Types.ObjectId.isValid(String(v));
  } catch (e) {
    return false;
  }
}

function asId(v) {
  if (!isValidId(v)) return null;
  return new mongoose.Types.ObjectId(String(v));
}

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

function normalizeConditionItemsIncoming(cond = {}) {
  if (!cond || typeof cond !== 'object') return cond || {};
  if (!('items' in cond)) return cond;

  if (!Array.isArray(cond.items)) cond.items = [];

  cond.items = cond.items
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      const out = {};

      out.qty = Number.isFinite(Number(it.qty)) ? Number(it.qty) : 1;

      const rawMid = it.menuId ?? it.menu_id ?? it.menu ?? null;

      out.menuId = isValidId(rawMid) ? asId(rawMid) : null;

      if ('category' in it) out.category = it.category ?? null;

      return out;
    });

  return cond;
}

exports.create = asyncHandler(async (req, res) => {
  let payload = normalizeCommon(req.body || {}, { isUpdate: false });

  if (!payload.name || !String(payload.name).trim())
    throwError('Field "name" wajib', 400);
  if (!payload.type) throwError('Field "type" wajib', 400);

  // bersihkan field yang tidak relevan menurut tipe (tetap seperti sebelumnya)
  payload = cleanseIrrelevantFieldsByType(payload, String(payload.type));

  // normalisasi kondisi: pastikan startAt/endAt null jika tidak ada / kosong
  if (!payload.conditions || typeof payload.conditions !== 'object') {
    payload.conditions = payload.conditions || {};
  }
  const cond = payload.conditions;

  // jika startAt diberikan dan valid -> ubah ke Date, jika falsy -> null
  if (cond.startAt) {
    const d = new Date(cond.startAt);
    cond.startAt = isNaN(d.getTime()) ? null : d;
  } else {
    cond.startAt = null;
  }

  if (cond.endAt) {
    const d2 = new Date(cond.endAt);
    cond.endAt = isNaN(d2.getTime()) ? null : d2;
  } else {
    cond.endAt = null;
  }

  // jika startAt > endAt -> error
  if (
    cond.startAt &&
    cond.endAt &&
    new Date(cond.startAt) > new Date(cond.endAt)
  )
    throwError('conditions.startAt tidak boleh setelah conditions.endAt', 400);

  // validate conditions & reward as before
  validateConditions(payload.conditions);
  validateRewardByType(payload.reward || {}, String(payload.type));

  // normal default flags
  if (payload.isActive == null) payload.isActive = false;
  if (payload.stackable == null) payload.stackable = false;
  if (payload.autoApply == null) payload.autoApply = true;

  // special: globalStock normalization:
  // - jika user mengirim angka 0 -> kita simpan sebagai null (artinya "tidak di-set / unlimited")
  // - jika nilai non-numeric atau null/undefined, biarkan null
  if ('globalStock' in payload) {
    const gsRaw = payload.globalStock;
    const gsNum = Number.isFinite(Number(gsRaw)) ? Number(gsRaw) : null;
    payload.globalStock = gsNum === 0 ? null : gsNum;
  } else {
    // jika tidak dikirim, pastikan tetap null (atau biarkan undefined jika memang mau)
    payload.globalStock =
      payload.globalStock == null ? null : payload.globalStock;
  }

  if (req.user && req.user.id) payload.createdBy = req.user.id;

  const doc = await Promo.create(payload);
  res.status(201).json({ promo: doc.toObject() });
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

  // --- Normalisasi partial conditions (merge, jangan timpa keseluruhan) ---
  if (incoming.conditions && typeof incoming.conditions === 'object') {
    const ic = incoming.conditions;

    // normalisasi startAt/endAt hanya jika dikirim
    if ('startAt' in ic) {
      if (ic.startAt) {
        const d = new Date(ic.startAt);
        ic.startAt = isNaN(d.getTime()) ? null : d;
      } else {
        ic.startAt = null;
      }
    }

    if ('endAt' in ic) {
      if (ic.endAt) {
        const d2 = new Date(ic.endAt);
        ic.endAt = isNaN(d2.getTime()) ? null : d2;
      } else {
        ic.endAt = null;
      }
    }

    // normalisasi items hanya jika dikirim; jangan hilangkan items lama jika tidak dikirim
    incoming.conditions = normalizeConditionItemsIncoming(ic);

    // MERGE incoming.conditions ke p.conditions (preserve fields yang tidak dikirim)
    p.conditions = Object.assign({}, p.conditions || {}, incoming.conditions);
  } else {
    // jika incoming.conditions tidak dikirim, biarkan p.conditions apa adanya
    if (!p.conditions) p.conditions = {};
  }

  // validate menggunakan kondisi hasil merge (p.conditions) dan reward final
  validateConditions(p.conditions);
  validateRewardByType(incoming.reward || p.reward || {}, finalType);

  // apply incoming fields kecuali conditions (karena sudah kita tangani merge)
  Object.keys(incoming).forEach((k) => {
    if (k === 'conditions') return; // skip karena sudah merge
    p[k] = incoming[k];
  });

  // After applying, ensure condition dates dan items tetap ada
  if (!p.conditions) p.conditions = {};
  if (!('startAt' in p.conditions) || p.conditions.startAt == null)
    p.conditions.startAt = p.conditions.startAt ?? null;
  if (!('endAt' in p.conditions) || p.conditions.endAt == null)
    p.conditions.endAt = p.conditions.endAt ?? null;
  if (!Array.isArray(p.conditions.items))
    p.conditions.items = p.conditions.items || [];

  // globalStock normalization jika dikirim
  if ('globalStock' in incoming) {
    const gsRaw = incoming.globalStock;
    const gsNum = Number.isFinite(Number(gsRaw)) ? Number(gsRaw) : null;
    p.globalStock = gsNum === 0 ? null : gsNum;
  }

  if (
    p.conditions &&
    p.conditions.startAt &&
    p.conditions.endAt &&
    new Date(p.conditions.startAt) > new Date(p.conditions.endAt)
  ) {
    throwError('conditions.startAt tidak boleh setelah conditions.endAt', 400);
  }

  await p.save();
  res.json({ promo: p.toObject() });
});

exports.list = asyncHandler(async (req, res) => {
  const {
    q,
    isActive,
    type,
    page = 1,
    pageSize = 25,
    sortBy = 'priority',
    sortDir = 'desc'
  } = req.query || {};
  const limit = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const filter = {};
  if (q) filter.name = { $regex: String(q), $options: 'i' };
  if (typeof isActive !== 'undefined') {
    const s = String(isActive).toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(s)) filter.isActive = true;
    else if (['0', 'false', 'no', 'n'].includes(s)) filter.isActive = false;
  }
  if (type) filter.type = String(type);

  const dir = String(sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const sort = {};
  sort[String(sortBy || 'priority')] = dir;
  sort.createdAt = -1;

  const [total, items] = await Promise.all([
    Promo.countDocuments(filter),
    Promo.find(filter).sort(sort).skip(skip).limit(limit).lean()
  ]);

  const promoTypeLabel = {
    free_item: 'Gratis item',
    buy_x_get_y: 'Beli X gratis Y',
    percent: 'Diskon persentase',
    amount: 'Potongan nominal',
    points: 'Beri poin',
    membership: 'Free membership'
  };

  const now = Date.now();

  const rows = (items || []).map((p) => {
    // asumsi endAt di dalam p.conditions.endAt (kalau berbeda, sesuaikan)
    const endAtRaw =
      p.conditions && p.conditions.endAt ? new Date(p.conditions.endAt) : null;
    const endAtTs =
      endAtRaw && !isNaN(endAtRaw.getTime()) ? endAtRaw.getTime() : null;

    // globalStock kemungkinan ada di root p.globalStock atau di p.visibility/globalStock
    let globalStock = null;
    if (typeof p.globalStock !== 'undefined') globalStock = p.globalStock;
    else if (p.visibility && typeof p.visibility.globalStock !== 'undefined')
      globalStock = p.visibility.globalStock;

    const expired = endAtTs !== null ? now > endAtTs : false;
    const soldOut = typeof globalStock === 'number' ? globalStock === 0 : false;

    return {
      id: String(p._id),
      name: p.name || '',
      type: p.type || '',
      typeLabel: promoTypeLabel[String(p.type || '')] || String(p.type || ''),
      endAt: endAtTs ? new Date(endAtTs).toISOString() : null,
      priority: typeof p.priority === 'number' ? p.priority : 0,
      globalStock: typeof globalStock !== 'undefined' ? globalStock : null,
      isActive: !!p.isActive,
      // ATTRIBUTE YANG DITAMBAHKAN: true kalau expired atau stock = 0
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

exports.getPromo = asyncHandler(async (req, res) => {
  const p = await Promo.findById(req.params.id).lean();
  if (!p || p.isDeleted) throwError('Promo tidak ditemukan', 404);

  try {
    // kumpulkan semua menuId yang relevan untuk di-populate
    const menuIdSet = new Set();

    // kondisi.items
    if (Array.isArray(p.conditions?.items)) {
      for (const it of p.conditions.items) {
        if (it && it.menuId) menuIdSet.add(String(it.menuId));
      }
    }

    if (p.reward && p.reward.freeMenuId)
      menuIdSet.add(String(p.reward.freeMenuId));
    if (p.reward && p.reward.appliesToMenuId)
      menuIdSet.add(String(p.reward.appliesToMenuId));
    if (p.reward && p.reward.applies_to_menu_id)
      menuIdSet.add(String(p.reward.applies_to_menu_id));
    if (p.reward && p.reward.menuId) menuIdSet.add(String(p.reward.menuId));

    if (menuIdSet.size === 0) {
      return res.json({ promo: p });
    }

    const menuIds = Array.from(menuIdSet);
    const menus = await Menu.find({ _id: { $in: menuIds } })
      .select('name code ')
      .lean()
      .catch(() => []);

    const menuMap = menus.reduce((acc, m) => {
      acc[String(m._id)] = m;
      return acc;
    }, {});

    if (Array.isArray(p.conditions?.items)) {
      p.conditions.items = p.conditions.items.map((it) => {
        const menuId = it?.menuId || it?.menu || null;
        const menuDoc = menuId ? menuMap[String(menuId)] || null : null;
        return { ...it, menu: menuDoc };
      });
    }

    if (p.reward) {
      const freeId =
        p.reward.freeMenuId || p.reward.free_menu_id || p.reward.menuId || null;
      if (freeId) p.reward.freeMenu = menuMap[String(freeId)] || null;

      const appliesId =
        p.reward.appliesToMenuId || p.reward.applies_to_menu_id || null;
      if (appliesId)
        p.reward.appliesToMenu = menuMap[String(appliesId)] || null;
    }

    return res.json({ promo: p });
  } catch (e) {
    console.error('[getPromo] populate menu failed', e?.message || e);
    return res.json({ promo: p });
  }
});

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
