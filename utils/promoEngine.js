// utils/promoEngine.js
const Promo = require('../models/promoModel');
const throwError = require('../utils/throwError');

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

  // debug top-level cart
  try {
    console.log('[promoEngine.debug] findApplicablePromos called');
    console.log('[promoEngine.debug] cart snapshot:', {
      items_subtotal,
      totalQty,
      items_sample: (items || []).slice(0, 10)
    });
    console.log(
      '[promoEngine.debug] member snapshot:',
      member
        ? { id: String(member._id || member.id), level: member.level }
        : null
    );
  } catch (e) {
    /* ignore logging errors */
  }

  // ambil semua promo aktif
  const promos = await Promo.find({ isActive: true })
    .sort({ priority: -1 })
    .lean();

  console.log(
    '[promoEngine.debug] promos fetched count:',
    Array.isArray(promos) ? promos.length : 0
  );

  const eligible = [];
  const memberId = member ? String(member._id || member.id) : null;
  const fetchers = options.fetchers || {};

  for (const p of promos) {
    // prepare per-promo debug record
    const debug = {
      promoId: String(p._id),
      name: p.name,
      isActive: !!p.isActive,
      priority: p.priority,
      reasonSkipped: null,
      checks: {}
    };

    // 1) absolute period
    if (p.conditions?.startAt && new Date(p.conditions.startAt) > now) {
      debug.reasonSkipped = 'startAt_future';
      debug.checks.startAt = { ok: false, startAt: p.conditions.startAt };
      console.log('[promoEngine.debug][SKIP]', debug);
      continue;
    } else {
      debug.checks.startAt = {
        ok: true,
        startAt: p.conditions?.startAt || null
      };
    }
    if (p.conditions?.endAt && new Date(p.conditions.endAt) < now) {
      debug.reasonSkipped = 'endAt_passed';
      debug.checks.endAt = { ok: false, endAt: p.conditions.endAt };
      console.log('[promoEngine.debug][SKIP]', debug);
      continue;
    } else {
      debug.checks.endAt = { ok: true, endAt: p.conditions?.endAt || null };
    }

    // 2) audience
    if (p.conditions?.audience === 'members' && !member) {
      debug.reasonSkipped = 'audience_members_only_but_no_member';
      debug.checks.audience = { ok: false, audience: p.conditions?.audience };
      console.log('[promoEngine.debug][SKIP]', debug);
      continue;
    }
    debug.checks.audience = {
      ok: true,
      audience: p.conditions?.audience || 'all'
    };

    // 2.b) memberLevels filter (optional)
    if (
      Array.isArray(p.conditions?.memberLevels) &&
      p.conditions.memberLevels.length > 0
    ) {
      if (!member || !member.level) {
        debug.reasonSkipped = 'memberLevels_requires_member_missing_level';
        debug.checks.memberLevels = {
          ok: false,
          required: p.conditions.memberLevels,
          memberLevel: member?.level || null
        };
        console.log('[promoEngine.debug][SKIP]', debug);
        continue;
      }
      const allowed = new Set(
        p.conditions.memberLevels.map((l) => String(l || '').toLowerCase())
      );
      if (!allowed.has(String(member.level || '').toLowerCase())) {
        debug.reasonSkipped = 'member_level_not_allowed';
        debug.checks.memberLevels = {
          ok: false,
          required: p.conditions.memberLevels,
          memberLevel: member.level
        };
        console.log('[promoEngine.debug][SKIP]', debug);
        continue;
      }
      debug.checks.memberLevels = {
        ok: true,
        required: p.conditions.memberLevels,
        memberLevel: member.level
      };
    } else {
      debug.checks.memberLevels = {
        ok: true,
        required: [],
        memberLevel: member?.level || null
      };
    }

    // 3) minTotal
    if (
      p.conditions?.minTotal &&
      Number(items_subtotal) < Number(p.conditions.minTotal)
    ) {
      debug.reasonSkipped = 'minTotal_not_met';
      debug.checks.minTotal = {
        ok: false,
        items_subtotal,
        required: Number(p.conditions.minTotal)
      };
      console.log('[promoEngine.debug][SKIP]', debug);
      continue;
    } else {
      debug.checks.minTotal = {
        ok: true,
        items_subtotal,
        required: Number(p.conditions?.minTotal || 0)
      };
    }

    // 4) minQty
    if (
      p.conditions?.minQty &&
      Number(totalQty) < Number(p.conditions.minQty)
    ) {
      debug.reasonSkipped = 'minQty_not_met';
      debug.checks.minQty = {
        ok: false,
        totalQty,
        required: Number(p.conditions.minQty)
      };
      console.log('[promoEngine.debug][SKIP]', debug);
      continue;
    } else {
      debug.checks.minQty = {
        ok: true,
        totalQty,
        required: Number(p.conditions?.minQty || 0)
      };
    }

    // 5) item-specific conditions
    if (Array.isArray(p.conditions?.items) && p.conditions.items.length) {
      let ok = true;
      const itemChecks = [];
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
          itemChecks.push({ type: 'menuId', menuId: cond.menuId, found, need });
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
          itemChecks.push({
            type: 'category',
            category: cond.category,
            found,
            need
          });
          if (found < need) {
            ok = false;
            break;
          }
        } else {
          itemChecks.push({ type: 'unknown_cond', cond });
        }
      }
      if (!ok) {
        debug.reasonSkipped = 'item_conditions_not_met';
        debug.checks.itemConditions = { ok: false, details: itemChecks };
        console.log('[promoEngine.debug][SKIP]', debug);
        continue;
      } else {
        debug.checks.itemConditions = { ok: true, details: itemChecks };
      }
    } else {
      debug.checks.itemConditions = { ok: true, details: [] };
    }

    // 6) perMemberLimit (lifetime)
    if (p.perMemberLimit && member) {
      const used = Array.isArray(member.promoUsageHistory)
        ? member.promoUsageHistory.filter(
            (h) => String(h.promoId) === String(p._id)
          ).length
        : 0;
      if (used >= Number(p.perMemberLimit)) {
        debug.reasonSkipped = 'perMemberLimit_exceeded';
        debug.checks.perMemberLimit = {
          ok: false,
          used,
          limit: Number(p.perMemberLimit)
        };
        console.log('[promoEngine.debug][SKIP]', debug);
        continue;
      }
      debug.checks.perMemberLimit = {
        ok: true,
        used,
        limit: Number(p.perMemberLimit)
      };
    } else {
      debug.checks.perMemberLimit = {
        ok: true,
        used: 0,
        limit: p.perMemberLimit || 0
      };
    }

    // 7) usageWindowDays / usageLimitGlobal / usageLimitPerMember
    if (Number(p.conditions?.usageWindowDays) > 0) {
      const windowDays = Number(p.conditions.usageWindowDays || 0);
      const sinceDate = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
      debug.checks.usageWindow = {
        windowDays,
        sinceDate: sinceDate.toISOString()
      };

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
          debug.checks.usageWindow.memberCount = cnt;
          if (cnt >= Number(p.conditions.usageLimitPerMember)) {
            debug.reasonSkipped = 'usageLimitPerMember_exceeded';
            debug.checks.usageWindow.memberOk = false;
            console.log('[promoEngine.debug][SKIP]', debug);
            continue;
          } else {
            debug.checks.usageWindow.memberOk = true;
          }
        } catch (e) {
          console.warn(
            '[promoEngine.debug] getMemberUsageCount failed, skipping promo conservatively',
            e?.message || e
          );
          debug.reasonSkipped = 'fetcher_member_failed';
          console.log('[promoEngine.debug][SKIP]', debug);
          continue;
        }
      }

      if (
        Number(p.conditions?.usageLimitGlobal) > 0 &&
        fetchers.getGlobalUsageCount
      ) {
        try {
          const gcnt = await fetchers.getGlobalUsageCount(
            String(p._id),
            sinceDate
          );
          debug.checks.usageWindow.globalCount = gcnt;
          if (gcnt >= Number(p.conditions.usageLimitGlobal)) {
            debug.reasonSkipped = 'usageLimitGlobal_exceeded';
            debug.checks.usageWindow.globalOk = false;
            console.log('[promoEngine.debug][SKIP]', debug);
            continue;
          } else {
            debug.checks.usageWindow.globalOk = true;
          }
        } catch (e) {
          console.warn(
            '[promoEngine.debug] getGlobalUsageCount failed, skipping promo conservatively',
            e?.message || e
          );
          debug.reasonSkipped = 'fetcher_global_failed';
          console.log('[promoEngine.debug][SKIP]', debug);
          continue;
        }
      }
    }

    // 8) globalStock check
    if (p.globalStock != null) {
      const stockNum = Number(p.globalStock);
      if (Number.isFinite(stockNum)) {
        if (stockNum <= 0) {
          debug.reasonSkipped = 'globalStock_empty';
          debug.checks.globalStock = { ok: false, stock: stockNum };
          console.log('[promoEngine.debug][SKIP]', debug);
          continue;
        } else {
          debug.checks.globalStock = { ok: true, stock: stockNum };
        }
      } else {
        debug.checks.globalStock = { ok: true, stock: p.globalStock };
      }
    } else {
      debug.checks.globalStock = { ok: true, stock: null };
    }

    // lulus semua check -> eligible
    debug.reasonSkipped = null;
    debug.checks.eligible = true;
    console.log('[promoEngine.debug][PASS]', debug);
    eligible.push(p);
  } // end for promos

  console.log(
    '[promoEngine.debug] findApplicablePromos finished. eligible count:',
    eligible.length
  );
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
