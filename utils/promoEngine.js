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

    // 8) globalStock check (lifetime)
    if (Number.isFinite(Number(p.globalStock))) {
      if ((p.globalStock || 0) <= 0) continue;
    }

    // passed all checks -> eligible
    eligible.push(p);
  }

  return eligible;
}

/**
 * applyPromo(promo, cartSnapshot = {}, pricing = {})
 * - returns { impact, actions }
 *
 * impact: { itemsDiscount, cartDiscount, addedFreeItems: [{menuId, qty, category}], note }
 * actions: array of side-effect instructions e.g. award_points/grant_membership
 */
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

  // support model with single reward object: promo.reward (preferred)
  // but keep fallback compatibility if some docs still use promo.rewards (array)
  const rewards =
    promo && promo.reward && typeof promo.reward === 'object'
      ? [promo.reward]
      : Array.isArray(promo.rewards) && promo.rewards.length
      ? promo.rewards
      : [];

  for (const r of rewards) {
    if (!r) continue;

    // free item (covers free_item and buy_x_get_y)
    if (r.freeMenuId) {
      const qty = Math.max(0, Number(r.freeQty || 1));
      impact.addedFreeItems.push({
        menuId: r.freeMenuId,
        qty,
        category: r.appliesToCategory || null
      });
      impact.note += (impact.note ? '; ' : '') + `Gratis item x${qty}`;
    }

    // cart percent / scoped percent
    if (Number.isFinite(Number(r.percent))) {
      const pct = Math.max(0, Math.min(100, Number(r.percent)));
      // if reward appliesTo menu/category, compute subtotal of that scope
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
      if (Number.isFinite(Number(r.maxDiscountAmount)))
        amt = Math.min(amt, Number(r.maxDiscountAmount));
      impact.cartDiscount += amt;
      impact.itemsDiscount += amt;
      impact.note += (impact.note ? '; ' : '') + `Diskon ${pct}% (${amt})`;
    }

    // flat amount (cart_amount)
    if (Number.isFinite(Number(r.amount))) {
      let amt = Math.max(0, Number(r.amount));
      // if scoped, restrict by scope subtotal
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

    // pointsFixed / pointsPercent => action (standar: use 'points' field)
    if (Number.isFinite(Number(r.pointsFixed))) {
      const pts = Number(r.pointsFixed);
      if (pts > 0) {
        actions.push({
          type: 'award_points',
          points: Math.trunc(pts),
          meta: { promoId: promo._id }
        });
      }
      impact.note += (impact.note ? '; ' : '') + `Poin ${r.pointsFixed}`;
    } else if (Number.isFinite(Number(r.pointsPercent))) {
      const pts = Math.floor((sub * Number(r.pointsPercent || 0)) / 100);
      if (pts > 0) {
        actions.push({
          type: 'award_points',
          points: Math.trunc(pts),
          meta: { promoId: promo._id }
        });
      }
      impact.note += (impact.note ? '; ' : '') + `Poin ${r.pointsPercent}%`;
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
