// utils/priceEngine.js
const {
  applyPromo: applyPromoRaw,
  findApplicablePromos,
  executePromoActions: _noop
} = require('./promoEngine');
const { validateAndPrice } = require('./voucherEngine');
const throwError = require('./throwError');

const int = (v) => Math.round(Number(v || 0));

/** distributeDiscountToItems: proporsional distribusi potongan ke tiap line */
function distributeDiscountToItems(items, discount) {
  if (!Array.isArray(items) || items.length === 0 || !discount) return items;
  const totals = items.map((it) => ({
    ...it,
    lineTotal: Number(it.price || 0) * Number(it.qty || it.quantity || 0)
  }));
  const baseTotal = totals.reduce((s, x) => s + x.lineTotal, 0) || 0;
  if (baseTotal <= 0) return items;

  let remaining = Math.round(discount);
  const out = totals.map((t) => {
    if (t.lineTotal <= 0)
      return {
        menuId: t.menuId,
        qty: Number(t.qty || t.quantity || 0),
        amount: 0
      };
    const share = Math.round((t.lineTotal / baseTotal) * discount);
    const dec = Math.min(share, remaining);
    remaining = Math.max(0, remaining - dec);
    return {
      menuId: t.menuId,
      qty: Number(t.qty || t.quantity || 0),
      amount: dec
    };
  });
  if (remaining > 0 && out.length) out[0].amount += remaining;
  return out;
}

/**
 * applyPromoThenVoucher
 * - memberId/memberDoc: member identity (nullable for guest)
 * - cart: { items: [{ menuId, qty, price, category, ... }] }
 * - returns object with totals, discounts, promoRewards, itemAdjustments, engineSnapshot, etc.
 */
async function applyPromoThenVoucher({
  memberId = null,
  memberDoc = null,
  cart = { items: [] },
  fulfillmentType = 'dine_in',
  deliveryFee = 0,
  voucherClaimIds = [],
  selectedPromoId = null,
  autoApplyPromo = true,
  now = new Date(),
  promoUsageFetchers = {}
} = {}) {
  const effectiveMember = memberDoc || (memberId ? { _id: memberId } : null);

  // 1) find applicable promos
  let applicable = [];
  try {
    applicable = await findApplicablePromos(cart, effectiveMember, now, {
      fetchers: promoUsageFetchers
    });
  } catch (e) {
    console.warn('[priceEngine] findApplicablePromos failed', e?.message || e);
    applicable = [];
  }

  console.log(
    '[priceEngine.debug] selectedPromoId:',
    String(selectedPromoId || 'null')
  );
  console.log(
    '[priceEngine.debug] effectiveMember:',
    JSON.stringify(effectiveMember)
  );
  console.log(
    '[priceEngine.debug] cart.items:',
    JSON.stringify(cart.items || [])
  );
  console.log(
    '[priceEngine.debug] applicableIds:',
    (applicable || []).map((p) => String(p._id))
  );

  // 2) choose promo: selected or best auto
  let promoApplied = null;
  let promoImpact = null;
  let promoActions = [];
  let selectedPromoRejected = false;
  let selectedPromoReplacedBy = null;

  if (selectedPromoId) {
    promoApplied =
      (applicable || []).find(
        (p) => String(p._id) === String(selectedPromoId)
      ) || null;
    if (!promoApplied) {
      // try fetch promo directly and try apply
      try {
        const PromoModel = require('../models/promoModel');
        const promoFromDb = await PromoModel.findById(selectedPromoId).lean();
        if (promoFromDb) {
          try {
            const { impact, actions } = await applyPromoRaw(promoFromDb, cart);
            promoApplied = promoFromDb;
            promoImpact = impact || {};
            promoActions = Array.isArray(actions) ? actions.slice() : [];
            selectedPromoReplacedBy = String(promoFromDb._id);
            console.log(
              '[priceEngine.info] selectedPromo applied directly from DB:',
              selectedPromoReplacedBy
            );
          } catch (e) {
            console.warn(
              '[priceEngine.warn] direct applyPromoRaw failed for selected promo',
              e?.message || e
            );
            selectedPromoRejected = true;
          }
        } else {
          selectedPromoRejected = true;
        }
      } catch (e) {
        console.warn(
          '[priceEngine.warn] fetch promoFromDb failed',
          e?.message || e
        );
        selectedPromoRejected = true;
      }

      // fallback: auto-best if selected rejected
      if (selectedPromoRejected) {
        if (Array.isArray(applicable) && applicable.length) {
          let best = null;
          let bestValue = -1;
          for (const p of applicable) {
            try {
              const { impact } = await applyPromoRaw(p, cart);
              const v =
                Number(impact.itemsDiscount || 0) +
                Number(impact.cartDiscount || 0);
              if (v > bestValue) {
                bestValue = v;
                best = { promo: p, impact };
              }
            } catch (e) {
              /* ignore */
            }
          }
          if (best) {
            promoApplied = best.promo;
            selectedPromoReplacedBy = String(best.promo._id);
            console.log(
              '[priceEngine.info] selectedPromo replaced by auto-best',
              selectedPromoReplacedBy
            );
          } else {
            promoApplied = null;
          }
        }
      }
    }
  } else if (autoApplyPromo && Array.isArray(applicable) && applicable.length) {
    let best = null;
    let bestValue = -1;
    for (const p of applicable) {
      try {
        const { impact } = await applyPromoRaw(p, cart);
        const v =
          Number(impact.itemsDiscount || 0) + Number(impact.cartDiscount || 0);
        if (v > bestValue) {
          bestValue = v;
          best = { promo: p, impact };
        }
      } catch (e) {
        // ignore failing promo
      }
    }
    if (best) promoApplied = best.promo;
  }

  // 3) apply promo if not yet applied
  let cartAfterPromo = JSON.parse(JSON.stringify(cart));
  try {
    if (promoApplied && (!promoImpact || !promoActions.length)) {
      const res = await applyPromoRaw(promoApplied, cart);
      promoImpact = res.impact || {};
      promoActions = Array.isArray(res.actions) ? res.actions.slice() : [];
      console.log(
        '[priceEngine.debug] applyPromoRaw returned for promo',
        String(promoApplied._id),
        { impact: promoImpact, actions: promoActions }
      );
    }
  } catch (e) {
    console.warn(
      '[priceEngine.warn] applyPromoRaw failed when applying promo',
      e?.message || e
    );
    // treat as no-promo
    promoApplied = null;
    promoImpact = null;
    promoActions = [];
  }

  // add free items and distribute discount
  if (promoApplied && promoImpact) {
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        cartAfterPromo.items.push({
          menuId: f.menuId,
          qty: Number(f.qty || 1),
          price: 0,
          category: f.category || null
        });
      }
    }
    const discount = Number(
      promoImpact.itemsDiscount || promoImpact.cartDiscount || 0
    );
    if (discount > 0) {
      cartAfterPromo.items = distributeDiscountToItems(
        cartAfterPromo.items,
        discount
      ).map((d) => {
        // convert distributed output back to item shape for voucher engine: price per unit decreased
        // We'll compute unit price after distribution: not strictly needed for voucher engine if it expects line price,
        // but for safety we'll reconstruct per-unit price as integer.
        return {
          menuId: d.menuId,
          qty: d.qty,
          price: Math.round(
            ((cart.items || []).find(
              (it) => String(it.menuId) === String(d.menuId)
            )?.price || 0) -
              d.amount / Math.max(1, d.qty)
          )
        };
      });
    }
  }

  // 4) if promo blocks voucher -> compute totals and return early
  if (promoApplied && promoApplied.blocksVoucher) {
    const items = cartAfterPromo.items || [];
    const baseSubtotal = items.reduce(
      (s, it) => s + Number(it.price || 0) * Number(it.qty || it.quantity || 0),
      0
    );
    const itemsDiscount = Number(promoImpact?.itemsDiscount || 0);
    const items_subtotal_after_discount = Math.max(
      0,
      baseSubtotal - itemsDiscount
    );
    const deliveryAfter = Math.max(0, Number(deliveryFee || 0));
    const money = require('./money');
    const service_fee = Math.round(
      items_subtotal_after_discount * money.SERVICE_FEE_RATE
    );
    const tax_amount = Math.round(
      items_subtotal_after_discount * money.parsePpnRate()
    );
    const beforeRound = Math.round(
      items_subtotal_after_discount + service_fee + deliveryAfter + tax_amount
    );
    const grand = money.roundRupiahCustom(beforeRound);
    const rounding_delta = grand - beforeRound;

    // build minimal discounts/itemAdjustments/promoRewards
    const discounts = [];
    const itemAdjustmentsMap = {};
    const promoId = String(promoApplied._id);
    const promoName = promoApplied.name || 'Promo';
    const totalPromoDiscount = Number(
      promoImpact.cartDiscount || promoImpact.itemsDiscount || 0
    );
    if (totalPromoDiscount > 0) {
      const itemsDist = distributeDiscountToItems(
        cartAfterPromo.items || [],
        totalPromoDiscount
      );
      discounts.push({
        id: promoId,
        source: 'promo',
        orderIdx: 1,
        type: 'amount',
        label: promoName,
        amount: totalPromoDiscount,
        items: itemsDist,
        meta: { promoId, note: promoImpact.note || null }
      });
      for (const it of itemsDist) {
        itemAdjustmentsMap[it.menuId] = itemAdjustmentsMap[it.menuId] || [];
        itemAdjustmentsMap[it.menuId].push({
          type: 'promo',
          amount: Number(it.amount || 0),
          reason: promoName,
          promoId
        });
      }
    }

    return {
      ok: true,
      reasons: [`Promo (${promoApplied.name}) memblokir penggunaan voucher.`],
      promoApplied: promoApplied
        ? {
            promoId: String(promoApplied._id),
            name: promoApplied.name || null,
            impact: promoImpact,
            actions: promoActions || []
          }
        : null,
      voucherResult: null,
      breakdown: [],
      totals: {
        baseSubtotal: int(baseSubtotal),
        itemsDiscount: int(itemsDiscount),
        items_subtotal_after_discount: int(items_subtotal_after_discount),
        deliveryFee: int(deliveryFee),
        shippingDiscount: 0,
        deliveryAfter: int(deliveryAfter),
        service_fee: int(service_fee),
        tax_amount: int(tax_amount),
        beforeRound: int(beforeRound),
        rounding_delta: int(rounding_delta),
        grandTotal: int(grand)
      },
      chosenClaimIds: [],
      discounts,
      itemAdjustments: itemAdjustmentsMap,
      promoRewards:
        promoActions && promoActions.length
          ? promoActions.map((a) => {
              if (a.type === 'award_points')
                return {
                  type: 'points',
                  amount: Number(a.points || a.amount || 0),
                  label: 'Poin promo',
                  meta: a.meta || {}
                };
              if (a.type === 'grant_membership')
                return {
                  type: 'membership',
                  amount: null,
                  label: 'Grant membership',
                  meta: a.meta || {}
                };
              return {
                type: a.type || 'unknown',
                amount: a.amount || null,
                label: a.label || a.type || 'reward',
                meta: a.meta || {}
              };
            })
          : [],
      points_awarded_details: {
        total: promoActions
          ? promoActions
              .filter((a) => a.type === 'award_points')
              .reduce((s, a) => s + Number(a.points || a.amount || 0), 0)
          : 0,
        actions: promoActions || []
      },
      engineSnapshot: {
        applicableIds: (applicable || []).map((p) => String(p._id)),
        selectedPromoId,
        selectedPromoRejected,
        selectedPromoReplacedBy,
        cartBefore: cart,
        cartAfterPromo,
        promoImpact,
        promoActions,
        voucherRes: null
      }
    };
  }

  // 5) call voucher engine with cartAfterPromo
  const voucherRes = await validateAndPrice({
    memberId,
    cart: {
      items: (cartAfterPromo.items || []).map((it) => ({
        menuId: it.menuId,
        qty: Number(it.qty || it.quantity || 0),
        price: Number(it.price || 0),
        category: it.category || null
      }))
    },
    fulfillmentType,
    deliveryFee,
    voucherClaimIds
  });

  // 6) combine promo + voucher results -> discounts, itemAdjustments, promoRewards
  const discounts = [];
  const itemAdjustmentsMap = {};

  // promo (orderIdx:1)
  if (promoApplied && promoImpact) {
    const promoId = String(promoApplied._id);
    const promoName = promoApplied.name || 'Promo';
    const totalPromoDiscount = Number(
      promoImpact.cartDiscount || promoImpact.itemsDiscount || 0
    );
    if (totalPromoDiscount > 0) {
      const itemsDist = distributeDiscountToItems(
        cartAfterPromo.items || [],
        totalPromoDiscount
      );
      discounts.push({
        id: promoId,
        source: 'promo',
        orderIdx: 1,
        type: 'amount',
        label: promoName,
        amount: totalPromoDiscount,
        items: itemsDist,
        meta: { promoId, note: promoImpact.note || null }
      });
      for (const it of itemsDist) {
        itemAdjustmentsMap[it.menuId] = itemAdjustmentsMap[it.menuId] || [];
        itemAdjustmentsMap[it.menuId].push({
          type: 'promo',
          amount: Number(it.amount || 0),
          reason: promoName,
          promoId
        });
      }
    }
    // free items
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        discounts.push({
          id: promoId,
          source: 'promo',
          orderIdx: 1,
          type: 'free_item',
          label: `Gratis: ${f.menuId}`,
          amount: 0,
          items: [{ menuId: f.menuId, qty: Number(f.qty || 1), amount: 0 }],
          meta: { promoId, menuId: f.menuId }
        });
        itemAdjustmentsMap[f.menuId] = itemAdjustmentsMap[f.menuId] || [];
        itemAdjustmentsMap[f.menuId].push({
          type: 'promo_free_item',
          amount: 0,
          reason: promoName,
          promoId,
          qty: Number(f.qty || 1)
        });
      }
    }
  }

  // voucher (orderIdx:2)
  if (
    voucherRes &&
    Array.isArray(voucherRes.breakdown) &&
    voucherRes.breakdown.length
  ) {
    for (const vb of voucherRes.breakdown) {
      const id = vb.voucherClaimId || vb.id || 'voucher';
      const label = vb.label || 'Voucher';
      const amount = Number(vb.amount || 0);
      const items = Array.isArray(vb.items) ? vb.items : [];
      discounts.push({
        id,
        source: 'voucher',
        orderIdx: 2,
        type: 'amount',
        label,
        amount,
        items,
        meta: vb.meta || {}
      });
      for (const it of items) {
        itemAdjustmentsMap[it.menuId] = itemAdjustmentsMap[it.menuId] || [];
        itemAdjustmentsMap[it.menuId].push({
          type: 'voucher',
          amount: Number(it.amount || 0),
          reason: label,
          voucherClaimId: id
        });
      }
    }
  }

  // bonus: if promo blocks voucher but voucherRes returned entries, add note (shouldn't happen here)
  if (
    promoApplied &&
    promoApplied.blocksVoucher &&
    voucherRes &&
    Array.isArray(voucherRes.breakdown) &&
    voucherRes.breakdown.length
  ) {
    discounts.push({
      id: String(promoApplied._id) + '-blocks-voucher',
      source: 'promo',
      orderIdx: 1,
      type: 'note',
      label: `Promo ${promoApplied.name} memblokir voucher`,
      amount: 0,
      items: [],
      meta: { promoId: String(promoApplied._id), reason: 'blocksVoucher' }
    });
  }

  // promoRewards from promoActions
  const promoRewards = [];
  if (Array.isArray(promoActions) && promoActions.length) {
    for (const a of promoActions) {
      if (a.type === 'award_points') {
        promoRewards.push({
          type: 'points',
          amount: Number(a.points || a.amount || 0),
          label: 'Poin promo',
          meta: a.meta || {}
        });
      } else if (a.type === 'grant_membership') {
        promoRewards.push({
          type: 'membership',
          amount: null,
          label: 'Grant membership',
          meta: a.meta || {}
        });
      } else {
        promoRewards.push({
          type: a.type || 'unknown',
          amount: a.amount || null,
          label: a.label || a.type || 'reward',
          meta: a.meta || {}
        });
      }
    }
  }

  const pointsTotal = promoRewards
    .filter((r) => r.type === 'points')
    .reduce((s, r) => s + Number(r.amount || 0), 0);

  const final = {
    ok: voucherRes.ok,
    reasons: (voucherRes.reasons || []).slice(),
    promoApplied: promoApplied
      ? {
          promoId: String(promoApplied._id),
          name: promoApplied.name || null,
          impact: promoImpact,
          actions: promoActions || []
        }
      : null,
    voucherResult: voucherRes,
    breakdown: voucherRes.breakdown || [],
    totals: voucherRes.totals || {},
    chosenClaimIds: voucherRes.chosenClaimIds || [],
    discounts,
    itemAdjustments: itemAdjustmentsMap,
    promoRewards,
    points_awarded_details: {
      total: pointsTotal,
      actions: promoActions || []
    },
    engineSnapshot: {
      applicableIds: (applicable || []).map((p) => String(p._id)),
      selectedPromoId,
      selectedPromoRejected,
      selectedPromoReplacedBy,
      cartBefore: cart,
      cartAfterPromo,
      promoImpact,
      promoActions,
      voucherRes
    }
  };

  return final;
}

module.exports = { applyPromoThenVoucher };
