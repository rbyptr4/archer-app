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

  // LOG eligible promos
  try {
    console.log(
      '[promoEngine] findApplicablePromos -> eligible count:',
      eligible.length,
      'ids:',
      eligible.map((x) => String(x._id))
    );
  } catch (e) {
    /* ignore logging error */
  }

  return eligible;
}

async function applyPromo(promo, cartSnapshot = {}, pricing = {}) {
  if (!promo) throw new Error('promo required');
  const impact = {
    itemsDiscount: 0,
    cartDiscount: 0,
    addedFreeItems: [],
    note: ''
  };
  const actions = [];

  // ambil snapshot totals
  const { items_subtotal: sub, items } = snapshotTotals(cartSnapshot);
  const subtotal = Number(sub || 0);

  // === Ambil rewards array ===
  const rewards =
    promo && typeof promo.reward === 'object' && promo.reward
      ? [promo.reward]
      : Array.isArray(promo.rewards)
      ? promo.rewards
      : Array.isArray(promo.rewardSummary)
      ? promo.rewardSummary
      : Array.isArray(promo.reward_summary)
      ? promo.reward_summary
      : [];

  // LOG promo header
  try {
    console.log(
      '[promoEngine.applyPromo] promoId:',
      String(promo._id),
      'name:',
      promo.name,
      'type:',
      promo.type,
      'subtotal:',
      subtotal,
      'rewardsLen:',
      rewards.length
    );
  } catch (e) {
    /* ignore */
  }

  // helper parse angka
  const parseNumber = (v) => {
    if (v == null) return NaN;
    const cleaned = String(v).replace(/[^0-9.\-]+/g, '');
    return cleaned === '' ? NaN : Number(cleaned);
  };

  // ----------------------------------------
  // LOOP REWARD
  // ----------------------------------------
  for (const raw of rewards) {
    if (!raw || typeof raw !== 'object') continue;

    const r = { ...raw };

    // LOG raw reward
    console.log(
      '[promoEngine.applyPromo] processing reward:',
      JSON.stringify(r)
    );

    // ======================================
    // 1) FREE ITEM
    // ======================================
    const freeMenuId =
      r.freeMenuId ||
      r.free_menu_id ||
      r.menuId ||
      r.menu_id ||
      r.free_menu ||
      null;
    const freeQty = Number(
      r.freeQty || r.qty || r.quantity || r.free_qty || r.free_quantity || 0
    );

    if (freeMenuId && freeQty > 0) {
      impact.addedFreeItems.push({
        menuId: String(freeMenuId),
        qty: freeQty,
        category: r.appliesToCategory || r.applies_to_category || null,
        name: r.name || null,
        imageUrl: r.imageUrl || null
      });

      impact.note += (impact.note ? '; ' : '') + `Gratis ${freeQty} item`;
      console.log(
        '[promoEngine.applyPromo] addedFreeItem ->',
        freeMenuId,
        'qty',
        freeQty
      );
    }

    // ======================================
    // 2) DISCOUNT (percent / flat)
    // ======================================
    // PENTING: percent & amount = DISKON, bukan poin
    const percentVal = parseNumber(
      r.percent || r.discountPercent || r.percent_val
    );

    if (Number.isFinite(percentVal) && percentVal > 0) {
      let scopeSub = subtotal;

      // scope to menu
      const menuTarget = r.appliesToMenuId || r.applies_to_menu_id;
      if (menuTarget) {
        scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.menu || it.menuId) === String(menuTarget)
              ? Number(it.base_price || it.unit_price || it.price || 0) *
                Number(it.quantity || it.qty || 0)
              : 0),
          0
        );
      }

      // scope to category
      const catTarget = r.appliesToCategory || r.applies_to_category;
      if (catTarget) {
        scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.category) === String(catTarget)
              ? Number(it.base_price || it.unit_price || it.price || 0) *
                Number(it.quantity || it.qty || 0)
              : 0),
          0
        );
      }

      let amt = Math.floor((scopeSub * percentVal) / 100);

      // limit maksimum diskon
      const maxDisc = parseNumber(r.maxDiscountAmount || r.max_discount_amount);
      if (Number.isFinite(maxDisc) && maxDisc > 0) amt = Math.min(amt, maxDisc);

      impact.itemsDiscount += amt;
      impact.cartDiscount += amt;

      impact.note +=
        (impact.note ? '; ' : '') + `Diskon ${percentVal}% (${amt})`;

      console.log('[promoEngine.applyPromo] percent discount applied:', {
        percentVal,
        scopeSub,
        amt
      });
    }

    // flat amount
    const flat = parseNumber(
      r.amount || r.flat || r.flatAmount || r.discountAmount
    );
    if (Number.isFinite(flat) && flat > 0) {
      let amt = flat;

      // scope menu
      const menuTarget = r.appliesToMenuId || r.applies_to_menu_id;
      if (menuTarget) {
        const scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.menu || it.menuId) === String(menuTarget)
              ? Number(it.base_price || it.unit_price || it.price || 0) *
                Number(it.quantity || it.qty || 0)
              : 0),
          0
        );
        amt = Math.min(amt, scopeSub);
      }

      // scope category
      const catTarget = r.appliesToCategory || r.applies_to_category;
      if (catTarget) {
        const scopeSub = (items || []).reduce(
          (s, it) =>
            s +
            (String(it.category) === String(catTarget)
              ? Number(it.base_price || it.unit_price || it.price || 0) *
                Number(it.quantity || it.qty || 0)
              : 0),
          0
        );
        amt = Math.min(amt, scopeSub);
      }

      amt = Math.min(amt, subtotal);
      impact.itemsDiscount += amt;
      impact.cartDiscount += amt;

      impact.note += (impact.note ? '; ' : '') + `Potongan Rp ${amt}`;
      console.log('[promoEngine.applyPromo] flat discount applied:', { amt });
    }

    // ======================================
    // 3) POINTS (HANYA jika fields-nya ada)
    // ======================================
    const ptsFix = parseNumber(r.pointsFixed || r.points_fixed);
    if (Number.isFinite(ptsFix) && ptsFix > 0) {
      const pts = Math.round(ptsFix);
      actions.push({
        type: 'award_points',
        points: pts,
        meta: { promoId: promo._id }
      });
      impact.note += (impact.note ? '; ' : '') + `Poin +${pts}`;
      console.log('[promoEngine.applyPromo] pointsFixed applied:', pts);
    }

    const ptsPercent = parseNumber(r.pointsPercent || r.points_percent);
    if (Number.isFinite(ptsPercent) && ptsPercent > 0) {
      const pts = Math.floor((subtotal * ptsPercent) / 100);
      if (pts > 0) {
        actions.push({
          type: 'award_points',
          points: pts,
          meta: { promoId: promo._id, percent: ptsPercent }
        });
        impact.note +=
          (impact.note ? '; ' : '') + `Poin ${ptsPercent}% (~${pts})`;
        console.log('[promoEngine.applyPromo] pointsPercent applied:', {
          ptsPercent,
          pts
        });
      } else {
        impact.note += (impact.note ? '; ' : '') + `Poin ${ptsPercent}% (0)`;
        console.log(
          '[promoEngine.applyPromo] pointsPercent zero result:',
          ptsPercent
        );
      }
    }

    // ======================================
    // 4) GRANT MEMBERSHIP
    // ======================================
    if (r.grantMembership || r.grant_membership) {
      actions.push({
        type: 'grant_membership',
        meta: { promoId: promo._id }
      });
      impact.note += (impact.note ? '; ' : '') + `Grant membership`;
      console.log('[promoEngine.applyPromo] grantMembership added');
    }
  }

  // safety: cap diskon max subtotal
  impact.itemsDiscount = Math.max(0, Math.min(impact.itemsDiscount, subtotal));

  // LOG final impact/actions
  console.log(
    '[promoEngine.applyPromo] final impact:',
    JSON.stringify(impact),
    'actions:',
    JSON.stringify(actions)
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
