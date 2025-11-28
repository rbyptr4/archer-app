// utils/promoEngine.js
const Promo = require('../models/promoModel');
const throwError = require('../utils/throwError');

/**
 * snapshotTotals(cart)
 */
function snapshotTotals(cart) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  const items_subtotal = items.reduce(
    (s, it) =>
      s +
      Number(it.base_price || it.unit_price || it.price || 0) *
        Number(it.quantity || it.qty || it.q || 0),
    0
  );
  const totalQty = items.reduce(
    (s, it) => s + Number(it.quantity || it.qty || it.q || 0),
    0
  );
  return { items, items_subtotal, totalQty };
}

async function findApplicablePromos(
  cart = {},
  member = null,
  now = new Date(),
  options = {}
) {
  const { items_subtotal, totalQty, items } = snapshotTotals(cart);

  const promos = await Promo.find({ isActive: true })
    .sort({ priority: -1 })
    .lean();

  const eligible = [];
  const memberId = member ? String(member._id || member.id) : null;
  const fetchers = options.fetchers || {};

  for (const p of promos) {
    // 1) absolute period
    if (p.conditions?.startAt && new Date(p.conditions.startAt) > now) continue;
    if (p.conditions?.endAt && new Date(p.conditions.endAt) < now) continue;

    // 2) audience
    if (p.conditions?.audience === 'members' && !member) continue;
    // 2.b) memberLevels filter (optional)
    // jika promo punya kondisi memberLevels: ['bronze','silver','gold'], hanya berlaku utk member tsb
    if (
      Array.isArray(p.conditions?.memberLevels) &&
      p.conditions.memberLevels.length > 0
    ) {
      // jika tidak ada member, promo tidak berlaku
      if (!member || !member.level) continue;

      const allowed = new Set(
        p.conditions.memberLevels.map((l) => String(l || '').toLowerCase())
      );
      if (!allowed.has(String(member.level || '').toLowerCase())) continue;
    }

    // 3) minTotal
    if (
      p.conditions?.minTotal &&
      Number(items_subtotal) < Number(p.conditions.minTotal)
    )
      continue;

    // 4) minQty
    if (p.conditions?.minQty && Number(totalQty) < Number(p.conditions.minQty))
      continue;

    // 5) item-specific conditions
    if (Array.isArray(p.conditions?.items) && p.conditions.items.length) {
      let ok = true;
      for (const cond of p.conditions.items) {
        const need = Number(cond.qty || 1);
        if (cond.menuId) {
          const found = (items || []).reduce(
            (s, it) =>
              s +
              (String(it.menu || it.menuId) === String(cond.menuId)
                ? Number(it.quantity || it.qty || 0)
                : 0),
            0
          );
          if (found < need) {
            ok = false;
            break;
          }
        } else if (cond.category) {
          const found = (items || []).reduce(
            (s, it) =>
              s +
              (String(it.category) === String(cond.category)
                ? Number(it.quantity || it.qty || 0)
                : 0),
            0
          );
          if (found < need) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
    }

    // 6) perMemberLimit (lifetime) using member.promoUsageHistory if available
    if (p.perMemberLimit && member) {
      const used = Array.isArray(member.promoUsageHistory)
        ? member.promoUsageHistory.filter(
            (h) => String(h.promoId) === String(p._id)
          ).length
        : 0;
      if (used >= Number(p.perMemberLimit)) continue;
    }

    // 7) usageWindowDays / usageLimitGlobal / usageLimitPerMember
    if (Number(p.conditions?.usageWindowDays) > 0) {
      const windowDays = Number(p.conditions.usageWindowDays || 0);
      const sinceDate = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
      // per-member usage
      if (
        Number(p.conditions?.usageLimitPerMember) > 0 &&
        fetchers.getMemberUsageCount &&
        memberId
      ) {
        try {
          const cnt = await fetchers.getMemberUsageCount(
            String(p._id),
            memberId,
            sinceDate
          );
          if (cnt >= Number(p.conditions.usageLimitPerMember)) continue;
        } catch (e) {
          // if fetcher fails, conservative: skip promo
          console.warn(
            '[promoEngine] getMemberUsageCount failed',
            e?.message || e
          );
          continue;
        }
      }
      // global usage
      if (
        Number(p.conditions?.usageLimitGlobal) > 0 &&
        fetchers.getGlobalUsageCount
      ) {
        try {
          const gcnt = await fetchers.getGlobalUsageCount(
            String(p._id),
            sinceDate
          );
          if (gcnt >= Number(p.conditions.usageLimitGlobal)) continue;
        } catch (e) {
          console.warn(
            '[promoEngine] getGlobalUsageCount failed',
            e?.message || e
          );
          continue;
        }
      }
    }

    // 8) globalStock check (lifetime) - only enforce when globalStock is explicitly set (not null/undefined)
    if (p.globalStock != null) {
      const stockNum = Number(p.globalStock);
      // if it's not a finite number -> treat as unlimited (skip check)
      if (Number.isFinite(stockNum)) {
        if (stockNum <= 0) {
          // no stock left -> not eligible
          continue;
        }
      }
    }

    // passed all checks -> eligible
    eligible.push(p);
  }

  return eligible;
}

// Ganti seluruh fungsi applyPromo(...) yang ada dengan versi ini:

async function applyPromo(promo, cartSnapshot = {}, pricing = {}) {
  if (!promo) throw new Error('promo required');
  const impact = {
    itemsDiscount: 0,
    cartDiscount: 0,
    addedFreeItems: [],
    note: ''
  };
  const actions = [];

  const { items_subtotal, items } = snapshotTotals(cartSnapshot);
  const sub = Number(items_subtotal || 0);

  // ==== ambil definisi rewards dari beberapa kemungkinan field ====
  const rewardsRaw =
    promo && typeof promo.reward === 'object' && promo.reward
      ? [promo.reward]
      : Array.isArray(promo.rewards) && promo.rewards.length
      ? promo.rewards
      : Array.isArray(promo.rewardSummary) && promo.rewardSummary.length
      ? promo.rewardSummary
      : Array.isArray(promo.reward_summary) && promo.reward_summary.length
      ? promo.reward_summary
      : [];

  // normalize rewards to consistent objects
  const rewards = (rewardsRaw || []).map((r) => {
    if (!r || typeof r !== 'object') return {};
    // create normalized copy with common keys
    return {
      ...r,
      // common aliases
      percent:
        r.percent ??
        r.percentAmount ??
        r.pointsPercent ??
        r.points_percent ??
        null,
      amount:
        r.amount ??
        r.cartAmount ??
        r.pointsFixed ??
        r.points_fixed ??
        r.value ??
        null,
      pointsFixed:
        r.pointsFixed ?? r.points_fixed ?? r.amount ?? r.points ?? null,
      pointsPercent: r.pointsPercent ?? r.points_percent ?? r.percent ?? null,
      freeMenuId: r.freeMenuId ?? r.free_menu_id ?? r.free_menu ?? null,
      appliesTo: r.appliesTo ?? r.scope ?? null,
      appliesToMenuId:
        r.appliesToMenuId ?? r.menuId ?? r.applies_to_menu_id ?? null,
      appliesToCategory:
        r.appliesToCategory ?? r.category ?? r.applies_to_category ?? null,
      grantMembership: r.grantMembership ?? r.grant_membership ?? false
    };
  });

  // helper: parse angka yang mungkin mengandung simbol
  const parseNumber = (v) => {
    if (v == null) return NaN;
    // accept numbers or strings like "10", "10%", "Rp 10.000", "1,000"
    const cleaned = String(v).replace(/[^0-9.\-]+/g, '');
    return cleaned === '' ? NaN : Number(cleaned);
  };

  for (const r of rewards) {
    if (!r) continue;

    // FREE ITEM (sama seperti sebelumnya)
    if (r.freeMenuId) {
      const qty = Math.max(0, Number(r.freeQty || r.qty || 1));
      impact.addedFreeItems.push({
        menuId: r.freeMenuId,
        qty,
        category: r.appliesToCategory || null
      });
      impact.note += (impact.note ? '; ' : '') + `Gratis item x${qty}`;
    }

    // DISCOUNT (percent atau amount) — tidak berubah
    if (Number.isFinite(Number(parseNumber(r.percent)))) {
      const pct = Math.max(0, Math.min(100, Number(parseNumber(r.percent))));
      let scopeSub = sub;
      if (r.appliesTo === 'menu' && r.appliesToMenuId) {
        scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.menu || it.menuId) === String(r.appliesToMenuId)
              ? Number(it.price || it.unit_price || it.base_price || 0) *
                Number(it.qty || it.quantity || 0)
              : 0),
          0
        );
      } else if (r.appliesTo === 'category' && r.appliesToCategory) {
        scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.category) === String(r.appliesToCategory)
              ? Number(it.price || it.unit_price || it.base_price || 0) *
                Number(it.qty || it.quantity || 0)
              : 0),
          0
        );
      }
      let amt = Math.floor((scopeSub * pct) / 100);
      const maxDisc = Number(r.maxDiscountAmount ?? NaN);
      if (Number.isFinite(maxDisc) && maxDisc > 0) {
        amt = Math.min(amt, maxDisc);
      }
      impact.cartDiscount += amt;
      impact.itemsDiscount += amt;
      impact.note += (impact.note ? '; ' : '') + `Diskon ${pct}% (${amt})`;
    }

    if (Number.isFinite(Number(parseNumber(r.amount)))) {
      let amt = Math.max(0, Number(parseNumber(r.amount)));
      if (r.appliesTo === 'menu' && r.appliesToMenuId) {
        const scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.menu || it.menuId) === String(r.appliesToMenuId)
              ? Number(it.price || it.unit_price || it.base_price || 0) *
                Number(it.qty || it.quantity || 0)
              : 0),
          0
        );
        amt = Math.min(amt, scopeSub);
      } else if (r.appliesTo === 'category' && r.appliesToCategory) {
        const scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.category) === String(r.appliesToCategory)
              ? Number(it.price || it.unit_price || it.base_price || 0) *
                Number(it.qty || it.quantity || 0)
              : 0),
          0
        );
        amt = Math.min(amt, scopeSub);
      } else {
        amt = Math.min(amt, sub);
      }
      impact.cartDiscount += amt;
      impact.itemsDiscount += amt;
      impact.note += (impact.note ? '; ' : '') + `Potongan Rp ${amt}`;
    }

    // === POINTS handling (NORMALIZED) ===
    // try multiple aliases: pointsFixed, pointsFixed via amount, explicit points, pointsPercent, percent (as fallback)
    const parsedPointsFixed = parseNumber(
      r.pointsFixed ?? r.pointsFixed ?? r.pointsFixed
    );
    const parsedPointsFixedAlt = parseNumber(
      r.pointsFixed || r.pointsFixed || r.amount || r.points || null
    );
    const parsedPointsPercent =
      parseNumber(
        r.pointsPercent ??
          r.points_percent ??
          r.pointsPercent ??
          r.pointsPercent
      ) ||
      parseNumber(r.pointsPercent ?? r.percent ?? null) ||
      parseNumber(r.pointsPercent ?? r.percent ?? r.pointsPercent ?? null);
    // better unified attempts:
    const ptsFixed =
      Number.isFinite(parsedPointsFixed) && parsedPointsFixed > 0
        ? parsedPointsFixed
        : Number.isFinite(parsedPointsFixedAlt) && parsedPointsFixedAlt > 0
        ? parsedPointsFixedAlt
        : NaN;

    let ptsFromPercent = NaN;
    // first try explicit pointsPercent keys
    const candidatePercentKeys = [
      r.pointsPercent,
      r.points_percent,
      r.pointspercent,
      r.pointsPercentAlt,
      r.percent // fallback
    ];
    for (const c of candidatePercentKeys) {
      const p = parseNumber(c);
      if (Number.isFinite(p) && p > 0) {
        ptsFromPercent = Math.trunc((sub * p) / 100);
        break;
      }
    }

    // decide which to apply
    if (Number.isFinite(ptsFixed) && ptsFixed > 0) {
      const pts = Math.trunc(ptsFixed);
      actions.push({
        type: 'award_points',
        points: pts,
        meta: { promoId: promo._id }
      });
      impact.note += (impact.note ? '; ' : '') + `Poin ${pts} (fixed)`;
    } else if (Number.isFinite(ptsFromPercent) && ptsFromPercent > 0) {
      const pts = Math.trunc(ptsFromPercent);
      actions.push({
        type: 'award_points',
        points: pts,
        meta: { promoId: promo._id, percent: true }
      });
      const pctLabel = r.pointsPercent ?? r.percent ?? 'pct';
      impact.note += (impact.note ? '; ' : '') + `Poin ${pctLabel}% (~${pts})`;
    } else {
    }

    // grant membership
    if (r.grantMembership) {
      actions.push({ type: 'grant_membership', meta: { promoId: promo._id } });
      impact.note += (impact.note ? '; ' : '') + `Grant membership`;
    }
  }

  // safety: cap itemsDiscount to subtotal
  impact.itemsDiscount = Math.max(
    0,
    Math.min(Number(impact.itemsDiscount || 0), sub)
  );

  return { impact, actions };
}

/**
 * executePromoActions(order, MemberModel, { session })
 * - menjalankan actions (award points, grant membership)
 */
async function executePromoActions(
  order,
  MemberModel,
  { session = null } = {}
) {
  if (!order || !order.appliedPromo) return;
  const applied = order.appliedPromo || {};
  const actions = applied.actions || [];
  if (!actions.length) return;

  const memberId = order.member;
  const now = new Date();
  const rewards = order.promoRewards || [];

  for (const a of actions) {
    if (a.type === 'award_points') {
      if (!memberId) continue;
      const add = Math.trunc(Number(a.points ?? a.amount ?? 0));
      if (add <= 0) continue;
      await MemberModel.updateOne(
        { _id: memberId },
        { $inc: { points: add } },
        { session }
      );
      rewards.push({
        type: 'points',
        amount: add,
        grantedAt: now,
        promoId: a.meta?.promoId || null
      });
    }
  }

  order.promoRewards = rewards;
}

module.exports = {
  snapshotTotals,
  findApplicablePromos,
  applyPromo,
  executePromoActions
};
