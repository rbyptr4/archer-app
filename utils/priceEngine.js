const {
  applyPromo: applyPromoRaw,
  findApplicablePromos,
  executePromoActions: _noop
} = require('./promoEngine');
const { validateAndPrice } = require('./voucherEngine');
const throwError = require('./throwError');

const int = (v) => Math.round(Number(v || 0));

/** distributeDiscountToItems: proporsional distribusi potongan ke tiap line
 * items: [{ menuId, qty, price }]
 * discount: number (total amount to distribute)
 * returns: [{ menuId, qty, amount }]
 */
function distributeDiscountToItems(items, discount) {
  if (!Array.isArray(items) || items.length === 0 || !discount) return [];
  const totals = items.map((it) => ({
    menuId: it.menuId,
    qty: Number(it.qty || it.quantity || 0),
    price: Number(it.price || 0),
    lineTotal: Number(it.price || 0) * Number(it.qty || it.quantity || 0)
  }));
  const baseTotal = totals.reduce((s, x) => s + x.lineTotal, 0) || 0;
  if (baseTotal <= 0)
    return totals.map((t) => ({ menuId: t.menuId, qty: t.qty, amount: 0 }));

  let remaining = Math.round(discount);
  const out = totals.map((t) => {
    if (t.lineTotal <= 0)
      return {
        menuId: t.menuId,
        qty: t.qty,
        amount: 0
      };
    const share = Math.round((t.lineTotal / baseTotal) * discount);
    const dec = Math.min(share, remaining);
    remaining = Math.max(0, remaining - dec);
    return {
      menuId: t.menuId,
      qty: t.qty,
      amount: dec
    };
  });
  if (remaining > 0 && out.length) out[0].amount += remaining;
  return out;
}

/** helper: create a safe cart snapshot shape that promoEngine expects */
function makeSafeCartForPromo(items = []) {
  return {
    items: (Array.isArray(items) ? items : []).map((it) => {
      const price = Number(it.price ?? it.unit_price ?? it.base_price ?? 0);
      const qty = Number(it.qty ?? it.quantity ?? 0);
      return {
        // fields promoEngine.snapshotTotals reads:
        base_price: price,
        unit_price: price,
        price: price,
        quantity: qty,
        qty: qty,
        // keep metadata to help promo logic
        menuId: it.menuId ?? it.menu ?? null,
        name: it.name ?? null,
        category: it.category ?? null,
        imageUrl: it.imageUrl ?? null,
        menu_code: it.menu_code ?? it.menuCode ?? null
      };
    })
  };
}

/**
 * applyPromoThenVoucher
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

  // ensure cart.items is array with normalized shapes (menuId, qty, price, category, name?)
  const originalCart = {
    items: (Array.isArray(cart.items) ? cart.items : []).map((it) => ({
      menuId: it.menuId ?? it.menu ?? it.id ?? null,
      qty: Number(it.qty ?? it.quantity ?? 0),
      price: Number(it.price ?? it.unit_price ?? it.base_price ?? 0),
      category: it.category ?? null,
      name: it.name ?? null,
      imageUrl: it.imageUrl ?? null,
      menu_code: it.menu_code ?? it.menuCode ?? null
    }))
  };

  // prebuild originalForDist (basis distribusi diskon selalu pre-promo)
  const originalForDist = originalCart.items.map((it) => ({
    menuId: it.menuId,
    qty: Number(it.qty || 0),
    price: Number(it.price || 0)
  }));

  // 1) find applicable promos
  let applicable = [];
  try {
    applicable = await findApplicablePromos(
      originalForDist,
      effectiveMember,
      now,
      {
        fetchers: promoUsageFetchers
      }
    );
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
    JSON.stringify(originalForDist)
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
      // try fetch promo directly and try apply (use safe cart)
      try {
        const PromoModel = require('../models/promoModel');
        const promoFromDb = await PromoModel.findById(selectedPromoId).lean();
        if (promoFromDb) {
          try {
            const safeCart = makeSafeCartForPromo(originalForDist);
            const { impact, actions } = await applyPromoRaw(
              promoFromDb,
              safeCart
            );
            promoApplied = promoFromDb;
            promoImpact = impact || {};
            promoActions = Array.isArray(actions) ? actions.slice() : [];
            selectedPromoReplacedBy = String(promoFromDb._id);
            console.log(
              '[priceEngine.info] selectedPromo applied directly from DB:',
              selectedPromoReplacedBy
            );
            console.log(
              '[priceEngine.debug] direct-apply result impact:',
              JSON.stringify(promoImpact),
              'actions:',
              JSON.stringify(promoActions)
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

      // fallback auto-best if rejected
      if (selectedPromoRejected) {
        if (Array.isArray(applicable) && applicable.length) {
          let best = null;
          let bestValue = -1;
          for (const p of applicable) {
            try {
              const safeCart = makeSafeCartForPromo(originalForDist);
              const { impact } = await applyPromoRaw(p, safeCart);
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
        const safeCart = makeSafeCartForPromo(originalForDist);
        const { impact } = await applyPromoRaw(p, safeCart);
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
  let cartAfterPromo = JSON.parse(JSON.stringify(originalCart)); // clone so originalForDist still intact
  try {
    if (promoApplied && (!promoImpact || !promoActions.length)) {
      const safeCart = makeSafeCartForPromo(originalForDist);
      const res = await applyPromoRaw(promoApplied, safeCart);
      promoImpact = res.impact || {};
      promoActions = Array.isArray(res.actions) ? res.actions.slice() : [];
      console.log('=== [PE] APPLY PROMO RESULT ===');
      console.log('promoApplied:', promoApplied?._id, promoApplied?.name);
      console.log('promoImpact:', JSON.stringify(promoImpact, null, 2));
      console.log('promoActions:', JSON.stringify(promoActions, null, 2));
      console.log('===============================');
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

  // Prefetch Menu docs for any free items (so we can show names instead of ids)
  let menuMap = {};
  try {
    if (
      promoImpact &&
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      const freeIds = Array.from(
        new Set(promoImpact.addedFreeItems.map((f) => String(f.menuId)))
      );
      if (freeIds.length) {
        try {
          const Menu = require('../models/menuModel');
          const menus = await Menu.find({ _id: { $in: freeIds } })
            .lean()
            .catch(() => []);
          menuMap = (menus || []).reduce((acc, m) => {
            acc[String(m._id)] = m;
            return acc;
          }, {});
        } catch (e) {
          // try alternative path if model filename differs
          try {
            const Menu = require('../models/Menu');
            const menus = await Menu.find({ _id: { $in: freeIds } })
              .lean()
              .catch(() => []);
            menuMap = (menus || []).reduce((acc, m) => {
              acc[String(m._id)] = m;
              return acc;
            }, {});
          } catch (ee) {
            console.warn(
              '[priceEngine] prefetch Menu attempt failed',
              ee?.message || ee
            );
            menuMap = {};
          }
        }
      }
    }
  } catch (e) {
    console.warn(
      '[priceEngine] prefetch Menu for free items failed',
      e?.message || e
    );
    menuMap = {};
  }

  // add free items (with metadata) and build cartAfterPromo pricing if promo applies
  if (promoApplied && promoImpact) {
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        const menuDoc = menuMap[String(f.menuId)];
        cartAfterPromo.items.push({
          menuId: f.menuId,
          qty: Number(f.qty || 1),
          price: 0,
          category: f.category || (menuDoc ? menuDoc.category : null) || null,
          name: f.name || (menuDoc ? menuDoc.name : null) || null,
          imageUrl: menuDoc ? menuDoc.imageUrl || null : f.imageUrl || null,
          menu_code: menuDoc ? menuDoc.code || null : null
        });
      }
    }

    const discount = Number(
      promoImpact.itemsDiscount || promoImpact.cartDiscount || 0
    );
    if (discount > 0) {
      // distribute discount always based on originalForDist (pre-promo prices)
      const itemsDist = distributeDiscountToItems(originalForDist, discount);
      // construct cartAfterPromo items as price-after-discount per unit (non-negative)
      cartAfterPromo.items = originalForDist.map((it) => {
        const dist = itemsDist.find(
          (d) => String(d.menuId) === String(it.menuId)
        );
        const perUnitDiscount = dist
          ? Math.round((dist.amount || 0) / Math.max(1, dist.qty || 1))
          : 0;
        return {
          menuId: it.menuId,
          qty: it.qty,
          price: Math.max(0, Math.round(it.price - perUnitDiscount)),
          category: it.category || null,
          name: it.name || null,
          imageUrl: it.imageUrl || null,
          menu_code: it.menu_code || null
        };
      });

      // append free items (they were pushed above, ensure they remain)
      if (
        Array.isArray(promoImpact.addedFreeItems) &&
        promoImpact.addedFreeItems.length
      ) {
        for (const f of promoImpact.addedFreeItems) {
          const menuDoc = menuMap[String(f.menuId)];
          cartAfterPromo.items.push({
            menuId: f.menuId,
            qty: Number(f.qty || 1),
            price: 0,
            category: f.category || (menuDoc ? menuDoc.category : null) || null,
            name: f.name || (menuDoc ? menuDoc.name : null) || null,
            imageUrl: menuDoc ? menuDoc.imageUrl || null : f.imageUrl || null,
            menu_code: menuDoc ? menuDoc.code || null : null
          });
        }
      }
    }
  }

  // 4) if promo blocks voucher -> compute totals and return early
  if (promoApplied && promoApplied.blocksVoucher) {
    const baseSubtotal = originalForDist.reduce(
      (s, it) => s + Number(it.price || 0) * Number(it.qty || 0),
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
      // distribute based on originalForDist
      const itemsDist = distributeDiscountToItems(
        originalForDist,
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

    // also include free item discounts metadata using menuMap
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        const menuDoc = menuMap[String(f.menuId)];
        discounts.push({
          id: promoId,
          source: 'promo',
          orderIdx: 1,
          type: 'free_item',
          label: `Gratis: ${menuDoc ? menuDoc.name : f.name || f.menuId}`,
          amount: 0,
          items: [{ menuId: f.menuId, qty: Number(f.qty || 1), amount: 0 }],
          meta: { promoId, menuId: f.menuId, menuSnapshot: menuDoc || null }
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

    return {
      ok: true,
      reasons: [`Promo (${promoApplied.name}) memblokir penggunaan voucher.`],
      promoApplied: promoApplied
        ? {
            promoId: String(promoApplied._id),
            name: promoApplied.name || null,
            description: promoApplied.notes || promoApplied.description || null,
            impact: promoImpact,
            actions: promoActions || [],
            freeItemsSnapshot:
              Array.isArray(promoImpact.addedFreeItems) &&
              promoImpact.addedFreeItems.length
                ? promoImpact.addedFreeItems.map((f) => ({
                    menuId: f.menuId,
                    qty: Number(f.qty || 1),
                    name: menuMap[String(f.menuId)]?.name || f.name || null,
                    imageUrl: menuMap[String(f.menuId)]?.imageUrl || null
                  }))
                : []
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
        cartBefore: originalForDist,
        cartAfterPromo,
        promoImpact,
        promoActions,
        voucherRes: null
      }
    };
  }

  // 5) call voucher engine with cartAfterPromo (cartAfterPromo.items already has name/image for free items)
  const voucherRes = await validateAndPrice({
    memberId,
    cart: {
      items: (cartAfterPromo.items || []).map((it) => ({
        menuId: it.menuId,
        qty: Number(it.qty || it.quantity || 0),
        price: Number(it.price || 0),
        category: it.category || null,
        name: it.name || null
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
      // distribute based on originalForDist to keep consistency
      const itemsDist = distributeDiscountToItems(
        originalForDist,
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

    // free items (use menuMap for human label)
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        const menuDoc = menuMap[String(f.menuId)];
        discounts.push({
          id: promoId,
          source: 'promo',
          orderIdx: 1,
          type: 'free_item',
          label: `Gratis: ${menuDoc ? menuDoc.name : f.name || f.menuId}`,
          amount: 0,
          items: [{ menuId: f.menuId, qty: Number(f.qty || 1), amount: 0 }],
          meta: { promoId, menuId: f.menuId, menuSnapshot: menuDoc || null }
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

  // bonus: if promo blocks voucher but voucherRes returned entries, add note
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

  // === Fallback: jika promoActions kosong tapi promoApplied.actions ada di object => gunakan itu
  const effectivePromoActions =
    Array.isArray(promoActions) && promoActions.length
      ? promoActions
      : promoApplied && Array.isArray(promoApplied.actions)
      ? promoApplied.actions
      : [];

  const pointsTotalFromActions = effectivePromoActions
    .filter((a) => String(a.type || '').toLowerCase() === 'award_points')
    .reduce((s, a) => s + Number(a.points ?? a.amount ?? 0), 0);

  const final = {
    ok: voucherRes?.ok ?? true,
    reasons: (voucherRes?.reasons || []).slice(),
    promoApplied: promoApplied
      ? {
          promoId: String(promoApplied._id),
          name: promoApplied.name || null,
          description: promoApplied.notes || promoApplied.description || null,
          impact: promoImpact,
          actions: effectivePromoActions || [],
          freeItemsSnapshot:
            Array.isArray(promoImpact?.addedFreeItems) &&
            promoImpact.addedFreeItems.length
              ? promoImpact.addedFreeItems.map((f) => ({
                  menuId: f.menuId,
                  qty: Number(f.qty || 1),
                  name: menuMap[String(f.menuId)]?.name || f.name || null,
                  imageUrl: menuMap[String(f.menuId)]?.imageUrl || null
                }))
              : []
        }
      : null,
    voucherResult: voucherRes || { ok: true, breakdown: [], totals: {} },
    breakdown: voucherRes?.breakdown || [],
    totals: voucherRes?.totals || {},
    chosenClaimIds: voucherRes?.chosenClaimIds || [],
    discounts,
    itemAdjustments: itemAdjustmentsMap,
    promoRewards,
    points_awarded_details: {
      // prefer explicit mapping from promoActions/promoRewards, fall back to computed pointsTotal
      total: Math.max(0, Math.round(pointsTotalFromActions || pointsTotal)),
      actions: effectivePromoActions || []
    },
    engineSnapshot: {
      applicableIds: (applicable || []).map((p) => String(p._id)),
      selectedPromoId,
      selectedPromoRejected,
      selectedPromoReplacedBy,
      cartBefore: originalForDist,
      cartAfterPromo,
      promoImpact,
      promoActions: effectivePromoActions,
      voucherRes
    }
  };

  // debug final promo-related pieces
  console.log('=== [PE] FINAL PROMO RESULT ===');
  console.log('appliedPromo:', final.promoApplied);
  console.log('promoRewards:', JSON.stringify(final.promoRewards, null, 2));
  console.log(
    'points_awarded_details:',
    JSON.stringify(final.points_awarded_details, null, 2)
  );
  console.log('chosenClaimIds:', final.chosenClaimIds);
  console.log('voucher breakdown:', JSON.stringify(final.breakdown, null, 2));
  console.log('================================');

  return final;
}

module.exports = { applyPromoThenVoucher };
