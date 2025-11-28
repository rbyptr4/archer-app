// utils/priceEngine.js
const {
  applyPromo: applyPromoRaw,
  findApplicablePromos
} = require('./promoEngine'); // applyPromoRaw berasal dari promoEngine.applyPromo
const { validateAndPrice } = require('./voucherEngine');
const throwError = require('./throwError');

const int = (v) => Math.round(Number(v || 0));

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

function makeSafeCartForPromo(items = []) {
  return {
    items: (Array.isArray(items) ? items : []).map((it) => {
      const price = Number(it.price ?? it.unit_price ?? it.base_price ?? 0);
      const qty = Number(it.qty ?? it.quantity ?? 0);
      return {
        base_price: price,
        unit_price: price,
        price: price,
        quantity: qty,
        qty: qty,
        menuId: it.menuId ?? it.menu ?? null,
        name: it.name ?? null,
        category: it.category ?? null,
        imageUrl: it.imageUrl ?? null,
        menu_code: it.menu_code ?? it.menuCode ?? null
      };
    })
  };
}

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

  const originalCart = {
    items: (Array.isArray(cart.items) ? cart.items : []).map((it) => ({
      menuId: it.menuId ?? it.menu ?? it.id ?? null,
      qty: Number(it.qty ?? it.quantity ?? 0),
      price: Number(it.price ?? it.unit_price ?? it.base_price ?? 0),
      category: it.category ?? null,
      name: it.name ?? null,
      imageUrl: it.imageUrl ?? null,
      menu_code: it.menu_code ?? it.menuCode ?? null,
      raw: it.rawItem ?? null
    }))
  };

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
      { fetchers: promoUsageFetchers }
    );
  } catch (e) {
    console.warn('[priceEngine] findApplicablePromos failed', e?.message || e);
    applicable = [];
  }

  // === LOG START ===
  console.log('=== [PE] START ===');
  console.log('[PE] selectedPromoId:', String(selectedPromoId || 'null'));
  console.log(
    '[PE] effectiveMember snapshot:',
    JSON.stringify(effectiveMember || null)
  );
  console.log(
    '[PE] cart originalForDist:',
    JSON.stringify(originalForDist, null, 2)
  );
  console.log(
    '[PE] applicable promos ids:',
    (applicable || []).map((p) => ({
      id: String(p._id),
      name: p.name,
      type: p.type,
      autoApply: p.autoApply,
      priority: p.priority
    }))
  );
  // === LOG END ===

  // choose promo
  let promoApplied = null;
  let promoImpact = null;
  let promoActions = [];
  let selectedPromoRejected = false;
  let selectedPromoReplacedBy = null;

  // helper to evaluate promo and compute value score including free items value
  async function evaluatePromoValue(promoCandidate) {
    try {
      const safeCart = makeSafeCartForPromo(originalForDist);
      const res = await applyPromoRaw(promoCandidate, safeCart);
      const impact = res.impact || {};
      const actions = Array.isArray(res.actions) ? res.actions.slice() : [];

      // estimate free items value
      let freeValue = 0;
      if (
        impact &&
        Array.isArray(impact.addedFreeItems) &&
        impact.addedFreeItems.length
      ) {
        for (const fi of impact.addedFreeItems) {
          const menuId = String(fi.menuId || '');
          const qty = Number(fi.qty || 1);
          const found = originalForDist.find(
            (x) => String(x.menuId) === menuId
          );
          if (found && Number(found.price || 0) > 0) {
            freeValue += Number(found.price || 0) * qty;
          } else {
            // try db fallback (best-effort)
            try {
              const Menu = require('../models/menuModel');
              const mdoc = await Menu.findById(menuId)
                .lean()
                .catch(() => null);
              if (mdoc) {
                freeValue += Number(mdoc.base_price || mdoc.price || 0) * qty;
              } else {
                freeValue += 0;
              }
            } catch (e) {
              freeValue += 0;
            }
          }
        }
      }

      const discountValue = Number(
        impact.itemsDiscount || impact.cartDiscount || 0
      );
      const score =
        Number(Math.round(discountValue || 0)) +
        Number(Math.round(freeValue || 0));

      // === LOG evaluate result ===
      console.log(
        '[PE][evaluatePromoValue] promoId:',
        String(promoCandidate._id),
        'name:',
        promoCandidate.name,
        'discountValue:',
        discountValue,
        'freeValue:',
        freeValue,
        'score:',
        score,
        'impactKeys:',
        Object.keys(impact || {}),
        'actionsLen:',
        actions.length
      );
      // === END LOG ===

      return { impact, actions, discountValue, freeValue, score };
    } catch (e) {
      console.warn(
        '[PE] evaluatePromoValue failed for promo',
        String(promoCandidate._id),
        e?.message || e
      );
      return {
        impact: null,
        actions: [],
        discountValue: 0,
        freeValue: 0,
        score: -1
      };
    }
  }

  // selection logic when selectedPromoId given
  if (selectedPromoId) {
    promoApplied =
      (applicable || []).find(
        (p) => String(p._id) === String(selectedPromoId)
      ) || null;
    if (!promoApplied) {
      // try fetch directly from DB and apply as fallback
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
              '[PE] selectedPromo applied directly from DB:',
              selectedPromoReplacedBy,
              'impactKeys:',
              Object.keys(promoImpact || {}),
              'actionsLen:',
              promoActions.length
            );
          } catch (e) {
            console.warn(
              '[PE] direct applyPromoRaw failed for selected promo',
              e?.message || e
            );
            selectedPromoRejected = true;
          }
        } else {
          selectedPromoRejected = true;
        }
      } catch (e) {
        console.warn('[PE] fetch promoFromDb failed', e?.message || e);
        selectedPromoRejected = true;
      }

      if (selectedPromoRejected) {
        if (Array.isArray(applicable) && applicable.length) {
          let best = null;
          let bestValue = -1;
          for (const p of applicable) {
            const ev = await evaluatePromoValue(p);
            console.log('[PE] eval candidate:', {
              id: p._id,
              name: p.name,
              discountValue: ev.discountValue,
              freeValue: ev.freeValue,
              score: ev.score
            });
            if (ev.score > bestValue) {
              bestValue = ev.score;
              best = { promo: p, impact: ev.impact, actions: ev.actions };
            }
          }
          if (best) {
            promoApplied = best.promo;
            selectedPromoReplacedBy = String(best.promo._id);
            console.log(
              '[PE] selectedPromo replaced by auto-best',
              selectedPromoReplacedBy,
              'score:',
              bestValue
            );
          } else {
            promoApplied = null;
          }
        }
      }
    }
  } else if (autoApplyPromo && Array.isArray(applicable) && applicable.length) {
    // choose best by discount + freeValue
    let best = null;
    let bestValue = -1;
    for (const p of applicable) {
      const ev = await evaluatePromoValue(p);
      console.log('[PE] eval candidate:', {
        id: p._id,
        name: p.name,
        discountValue: ev.discountValue,
        freeValue: ev.freeValue,
        score: ev.score
      });
      if (ev.score > bestValue) {
        bestValue = ev.score;
        best = { promo: p, impact: ev.impact, actions: ev.actions };
      }
    }
    if (best) {
      promoApplied = best.promo;
      console.log('[PE] auto-best selected promo:', {
        id: promoApplied._id,
        name: promoApplied.name,
        score: bestValue
      });
    }
  }

  // apply promo finally (if not already have impact/actions)
  let cartAfterPromo = JSON.parse(JSON.stringify(originalCart));
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
    promoApplied = null;
    promoImpact = null;
    promoActions = [];
  }

  // prefetch menuMap for free items
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
              '[PE] prefetch Menu attempt failed',
              ee?.message || ee
            );
            menuMap = {};
          }
        }
      }
    }
  } catch (e) {
    console.warn('[PE] prefetch Menu for free items failed', e?.message || e);
    menuMap = {};
  }

  // build cartAfterPromo based on promoImpact (free items & discounts)
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
      const itemsDist = distributeDiscountToItems(originalForDist, discount);
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

  // if promo blocks voucher -> return minimal snapshot
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

    const discounts = [];
    const itemAdjustmentsMap = {};
    const promoId = String(promoApplied._id);
    const promoName = promoApplied.name || 'Promo';
    const totalPromoDiscount = Number(
      promoImpact.cartDiscount || promoImpact.itemsDiscount || 0
    );
    if (totalPromoDiscount > 0) {
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

  // 5) call voucher engine
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

  // combine promo + voucher results
  const discounts = [];
  const itemAdjustmentsMap = {};

  if (promoApplied && promoImpact) {
    const promoId = String(promoApplied._id);
    const promoName = promoApplied.name || 'Promo';
    const totalPromoDiscount = Number(
      promoImpact.cartDiscount || promoImpact.itemsDiscount || 0
    );
    if (totalPromoDiscount > 0) {
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

  // build promoRewards
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
          type: a.type || 'action',
          amount: a.amount || null,
          label: a.label || a.type || 'Reward',
          meta: a.meta || {}
        });
      }
    }
  }

  if (
    promoImpact &&
    Array.isArray(promoImpact.addedFreeItems) &&
    promoImpact.addedFreeItems.length
  ) {
    for (const f of promoImpact.addedFreeItems) {
      promoRewards.push({
        type: 'free_item',
        amount: 0,
        label: f.name || `Gratis: ${String(f.menuId || '')}`,
        meta: { menuId: f.menuId, qty: Number(f.qty || 1) }
      });
    }
  }

  const discountValue = Number(
    promoImpact?.cartDiscount || promoImpact?.itemsDiscount || 0
  );
  if (discountValue && discountValue > 0) {
    promoRewards.push({
      type: 'discount',
      amount: int(discountValue),
      label: `Diskon promo`,
      meta: { promoId: promoApplied ? String(promoApplied._id) : null }
    });
  }

  const pointsTotalFromActions = (
    Array.isArray(promoActions) ? promoActions : []
  )
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
          actions: promoActions || [],
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
      total: Math.max(0, Math.round(pointsTotalFromActions || 0)),
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
      voucherRes
    }
  };

  // === LOG FINAL SNAPSHOT ===
  console.log('=== [PE] FINAL PROMO RESULT ===');
  console.log('appliedPromo:', final.promoApplied);
  console.log('promoRewards:', JSON.stringify(final.promoRewards, null, 2));
  console.log(
    'points_awarded_details:',
    JSON.stringify(final.points_awarded_details, null, 2)
  );
  console.log('chosenClaimIds:', final.chosenClaimIds);
  console.log('voucher breakdown:', JSON.stringify(final.breakdown, null, 2));
  console.log('engineSnapshot:', JSON.stringify(final.engineSnapshot, null, 2));
  console.log('================================');
  // === END LOG ===

  return final;
}

module.exports = { applyPromoThenVoucher };
