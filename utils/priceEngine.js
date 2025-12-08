// utils/priceEngine.js
const {
  applyPromo: applyPromoRaw,
  findApplicablePromos
} = require('./promoEngine');
const { validateAndPrice } = require('./voucherEngine');
const Member = require('../models/memberModel');
const throwError = require('./throwError');

const int = (v) => Math.round(Number(v || 0));

async function ensureMenuInMap(menuMap, menuId) {
  if (!menuId) return null;
  const key = String(menuId);
  if (menuMap && menuMap[key]) return menuMap[key];
  try {
    const Menu = require('../models/menuModel');
    const m = await Menu.findById(menuId)
      .select('name imageUrl code category price base_price')
      .lean()
      .catch(() => null);
    if (m) {
      menuMap = menuMap || {};
      menuMap[key] = m;
      return m;
    }
    return null;
  } catch (e) {
    // tetap jangan spam log di production
    return null;
  }
}

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
    if (t.lineTotal <= 0) return { menuId: t.menuId, qty: t.qty, amount: 0 };
    const share = Math.round((t.lineTotal / baseTotal) * discount);
    const dec = Math.min(share, remaining);
    remaining = Math.max(0, remaining - dec);
    return { menuId: t.menuId, qty: t.qty, amount: dec };
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
  console.log('[PE] START applyPromoThenVoucher', {
    memberId,
    fulfillmentType,
    deliveryFee,
    voucherClaimIdsLen: Array.isArray(voucherClaimIds)
      ? voucherClaimIds.length
      : 0,
    voucherClaimIdsSample: Array.isArray(voucherClaimIds)
      ? voucherClaimIds.slice(0, 5)
      : voucherClaimIds,
    cart_items_len: Array.isArray((cart || {}).items) ? cart.items.length : 0,
    cart_items_sample:
      cart && cart.items && cart.items[0] ? cart.items[0] : null
  });

  // build effectiveMember
  let effectiveMember = memberDoc || null;
  if (!effectiveMember && memberId) {
    try {
      effectiveMember = await Member.findById(memberId)
        .select('_id level promoUsageHistory')
        .lean()
        .catch(() => null);
    } catch (e) {
      effectiveMember = null;
    }
  }

  const originalCart = {
    items: (Array.isArray(cart.items) ? cart.items : []).map((it) => ({
      menuId: it.menuId ?? it.menu ?? it.id ?? null,
      qty: Number(it.qty ?? it.quantity ?? 0),
      price: Number(it.price ?? it.unit_price ?? it.base_price ?? 0),
      category: it.category ?? null,
      name: it.name ?? null,
      imageUrl: it.imageUrl ?? null,
      menu_code: it.menu_code ?? it.menuCode ?? null,
      raw: it.raw ?? null
    }))
  };

  const originalForDist = originalCart.items.map((it) => ({
    menuId: it.menuId,
    qty: Number(it.qty || 0),
    price: Number(it.price || 0)
  }));
  console.log('[PE.debug] originalForDist summary:', {
    count: originalForDist.length,
    subtotal: originalForDist.reduce(
      (s, x) => s + Number(x.price || 0) * Number(x.qty || 0),
      0
    ),
    sample: originalForDist.slice(0, 3)
  });
  const safeCart = makeSafeCartForPromo(originalForDist);
  console.log(
    '[PE.debug] safeCart for promo (first items):',
    safeCart.items && safeCart.items.slice(0, 3)
  );
  // find applicable promos (no verbose logging)
  let applicable = [];
  try {
    applicable = await findApplicablePromos(
      originalForDist,
      effectiveMember,
      now,
      { fetchers: promoUsageFetchers }
    );
  } catch (e) {
    applicable = [];
  }

  // --- selection + apply promo logic (tetap jalan seperti semula) ---
  let promoApplied = null;
  let promoImpact = null;
  let promoActions = [];
  let selectedPromoRejected = false;
  let selectedPromoReplacedBy = null;

  async function evaluatePromoValue(promoCandidate) {
    try {
      const safeCart = makeSafeCartForPromo(originalForDist);
      const res = await applyPromoRaw(promoCandidate, safeCart);
      const impact = res.impact || {};
      const actions = Array.isArray(res.actions) ? res.actions.slice() : [];

      // estimate free items value (sederhana, tanpa log)
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
            try {
              const Menu = require('../models/menuModel');
              const mdoc = await Menu.findById(menuId)
                .lean()
                .catch(() => null);
              if (mdoc)
                freeValue += Number(mdoc.base_price || mdoc.price || 0) * qty;
            } catch (e) {
              /* ignore */
            }
          }
        }
      }

      const discountValue = Number(
        impact.itemsDiscount || impact.cartDiscount || 0
      );
      let actionsValue = 0;
      if (Array.isArray(actions) && actions.length) {
        for (const a of actions) {
          const t = String(a.type || '').toLowerCase();
          if (t === 'award_points') {
            const pts = Number(a.points ?? a.amount ?? 0) || 0;
            actionsValue += Math.round(pts * 0.5);
          } else if (t === 'grant_membership') {
            actionsValue += 1000;
          } else {
            actionsValue += 100;
          }
        }
      }

      const score =
        Math.round(discountValue || 0) +
        Math.round(freeValue || 0) +
        Math.round(actionsValue || 0);
      return { impact, actions, discountValue, freeValue, actionsValue, score };
    } catch (e) {
      return {
        impact: null,
        actions: [],
        discountValue: 0,
        freeValue: 0,
        actionsValue: 0,
        score: -999999
      };
    }
  }

  // selection flow (kept but no noisy logs)
  if (selectedPromoId) {
    promoApplied =
      (applicable || []).find(
        (p) => String(p._id) === String(selectedPromoId)
      ) || null;
    if (!promoApplied) {
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
          } catch (e) {
            selectedPromoRejected = true;
          }
        } else {
          selectedPromoRejected = true;
        }
      } catch (e) {
        selectedPromoRejected = true;
      }

      if (
        selectedPromoRejected &&
        Array.isArray(applicable) &&
        applicable.length
      ) {
        let best = null;
        let bestValue = -Infinity;
        for (const p of applicable) {
          const ev = await evaluatePromoValue(p);
          if (ev.score > bestValue) {
            bestValue = ev.score;
            best = { promo: p, impact: ev.impact, actions: ev.actions };
          }
        }
        if (best) {
          promoApplied = best.promo;
          selectedPromoReplacedBy = String(best.promo._id);
        }
      }
    }
  } else if (autoApplyPromo && Array.isArray(applicable) && applicable.length) {
    let best = null;
    let bestValue = -1;
    for (const p of applicable) {
      const ev = await evaluatePromoValue(p);
      if (ev.score > bestValue) {
        bestValue = ev.score;
        best = { promo: p, impact: ev.impact, actions: ev.actions };
      }
    }
    if (best) {
      promoApplied = best.promo;
      promoImpact = best.impact;
      promoActions = best.actions || [];
    }
  }

  // apply promo finally if needed (no verbose logs)
  let cartAfterPromo = JSON.parse(JSON.stringify(originalCart));
  try {
    if (promoApplied && (!promoImpact || !promoActions.length)) {
      const safeCart = makeSafeCartForPromo(originalForDist);
      const res = await applyPromoRaw(promoApplied, safeCart);
      promoImpact = res.impact || {};
      promoActions = Array.isArray(res.actions) ? res.actions.slice() : [];
    }
  } catch (e) {
    promoApplied = null;
    promoImpact = null;
    promoActions = [];
  }

  // prefetch menuMap for free items (silent failures)
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
          menuMap = {};
        }
      }
    }
  } catch (e) {
    menuMap = {};
  }

  // ensure missing menu docs quietly
  try {
    if (
      promoImpact &&
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        await ensureMenuInMap(menuMap, f.menuId);
      }
    }
  } catch (e) {
    /* ignore */
  }

  // build cartAfterPromo based on promoImpact (kept behavior but no logs)
  if (promoApplied && promoImpact) {
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      for (const f of promoImpact.addedFreeItems) {
        const menuDoc = await ensureMenuInMap(menuMap, f.menuId);
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
      cartAfterPromo._promoItemsDistribution = itemsDist;
      cartAfterPromo.items = originalForDist.map((it) => ({
        menuId: it.menuId,
        qty: it.qty,
        price: it.price,
        category: it.category || null,
        name: it.name || null,
        imageUrl: it.imageUrl || null,
        menu_code: it.menu_code || null
      }));
      if (
        Array.isArray(promoImpact.addedFreeItems) &&
        promoImpact.addedFreeItems.length
      ) {
        for (const f of promoImpact.addedFreeItems) {
          const menuDoc = await ensureMenuInMap(menuMap, f.menuId);
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
  console.log(
    '[PE.debug] calling validateAndPrice with voucherClaimIds:',
    voucherClaimIds
  );
  console.log('[PE.debug] cartAfterPromo summary:', {
    items_len: (cartAfterPromo.items || []).length,
    subtotal: (cartAfterPromo.items || []).reduce(
      (s, it) => s + Number(it.price || 0) * Number(it.qty || 0),
      0
    )
  });

  // ==== Fokus voucher: panggil voucher engine dan log ringkas hasilnya ====
  let voucherRes = null;
  try {
    voucherRes = await validateAndPrice({
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

    // LOG PENTING: hanya output yang relevan ke voucher
    console.info(
      '[PE] voucher engine returned keys:',
      voucherRes ? Object.keys(voucherRes) : null
    );
  } catch (e) {
    // fallback non-fatal
    voucherRes = { ok: true, breakdown: [], totals: {}, chosenClaimIds: [] };
    console.error(
      '[PE] voucher engine failed (short):',
      String(e?.message || e)
    );
  }

  // combine promo + voucher results (perilaku preserved)
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
        const menuDoc = await ensureMenuInMap(menuMap, f.menuId);
        const labelName = menuDoc?.name || f.name || String(f.menuId || '');
        const meta = {
          promoId,
          menuId: f.menuId,
          qty: Number(f.qty || 1),
          name: menuDoc?.name || f.name || null,
          imageUrl: menuDoc?.imageUrl || f.imageUrl || null
        };
        discounts.push({
          id: promoId,
          source: 'promo',
          orderIdx: 1,
          type: 'free_item',
          label: `Gratis: ${labelName}`,
          amount: 0,
          items: [{ menuId: f.menuId, qty: Number(f.qty || 1), amount: 0 }],
          meta
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
      const id = vb.voucherClaimId || vb.id || null;
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

  // build promoRewards (kept)
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
      const menuDoc = await ensureMenuInMap(menuMap, f.menuId);
      const labelName = menuDoc?.name || f.name || String(f.menuId || '');
      promoRewards.push({
        type: 'free_item',
        amount: 0,
        label: labelName
          ? `Gratis: ${labelName}`
          : `Gratis: ${String(f.menuId || '')}`,
        meta: {
          menuId: f.menuId,
          qty: Number(f.qty || 1),
          name: menuDoc?.name || f.name || null,
          imageUrl: menuDoc?.imageUrl || f.imageUrl || null
        }
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

  // === merge totals (voucher + promo) ===
  try {
    const money = require('./money');
    const voucherTotals = (voucherRes && voucherRes.totals) || {};
    const baseSubtotalFromVoucher = Number(
      voucherTotals.baseSubtotal ?? voucherTotals.base_subtotal ?? NaN
    );
    const baseSubtotalComputed = originalForDist.reduce(
      (s, it) => s + Number(it.price || 0) * Number(it.qty || 0),
      0
    );
    const baseSubtotal = Number.isFinite(baseSubtotalFromVoucher)
      ? baseSubtotalFromVoucher
      : baseSubtotalComputed;

    const promoDiscountTotal = Number(
      promoImpact && (promoImpact.cartDiscount || promoImpact.itemsDiscount)
        ? promoImpact.cartDiscount || promoImpact.itemsDiscount
        : 0
    );
    const voucherItemsDiscount = Number(
      voucherTotals.itemsDiscount ?? voucherTotals.items_discount ?? 0
    );
    const mergedItemsDiscount = Math.max(
      0,
      Math.round(voucherItemsDiscount + promoDiscountTotal)
    );

    const items_subtotal_after_discount = Math.max(
      0,
      Math.round(baseSubtotal - mergedItemsDiscount)
    );
    const deliveryAfter = Number(
      voucherTotals.deliveryFee ??
        voucherTotals.delivery_fee ??
        deliveryFee ??
        0
    );
    const shippingDiscount = Number(
      voucherTotals.shippingDiscount ?? voucherTotals.shipping_discount ?? 0
    );

    const service_fee = Math.round(
      items_subtotal_after_discount * money.SERVICE_FEE_RATE
    );
    const tax_amount = Math.round(
      items_subtotal_after_discount * money.parsePpnRate()
    );
    const beforeRound = Math.round(
      items_subtotal_after_discount +
        service_fee +
        deliveryAfter -
        shippingDiscount +
        tax_amount
    );
    const grand = money.roundRupiahCustom(beforeRound);
    const rounding_delta = Math.round(grand - beforeRound);

    const mergedTotals = {
      baseSubtotal: int(baseSubtotal),
      itemsDiscount: int(mergedItemsDiscount),
      items_subtotal_after_discount: int(items_subtotal_after_discount),
      deliveryFee: int(deliveryAfter),
      shippingDiscount: int(shippingDiscount),
      deliveryAfter: int(deliveryAfter),
      service_fee: int(service_fee),
      tax_amount: int(tax_amount),
      beforeRound: int(beforeRound),
      rounding_delta: int(rounding_delta),
      grandTotal: int(grand)
    };

    // LOG PENTING: ringkasan merged totals
    console.info('[PE] merged totals built:', {
      promoDiscountTotal,
      voucherItemsDiscount,
      mergedGrand: mergedTotals.grandTotal
    });

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
                ? await Promise.all(
                    promoImpact.addedFreeItems.map(async (f) => {
                      const md = await ensureMenuInMap(menuMap, f.menuId);
                      return {
                        menuId: f.menuId,
                        qty: Number(f.qty || 1),
                        name: md?.name || f.name || null,
                        imageUrl: md?.imageUrl || f.imageUrl || null
                      };
                    })
                  )
                : []
          }
        : null,
      voucherResult: voucherRes || { ok: true, breakdown: [], totals: {} },
      breakdown: voucherRes?.breakdown || [],
      totals: Object.assign({}, voucherRes?.totals || {}, mergedTotals),
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

    // LOG PENTING: ringkas hasil voucher yang relevan
    console.info('=== [PE] FINAL PROMO RESULT ===');
    console.info(
      'appliedPromo (final):',
      final.promoApplied ? final.promoApplied.promoId : null
    );
    console.info('chosenClaimIds:', final.chosenClaimIds);
    console.info(
      'voucher breakdown:',
      JSON.stringify(final.breakdown || [], null, 2)
    );
    console.info('================================');

    return final;
  } catch (err) {
    // fallback minimal
    const fallback = {
      ok: voucherRes?.ok ?? true,
      reasons: (voucherRes?.reasons || []).slice(),
      promoApplied: promoApplied
        ? {
            promoId: String(promoApplied._id),
            name: promoApplied.name || null,
            impact: promoImpact,
            actions: promoActions || []
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
    console.error(
      '[PE] merge totals failed (short):',
      String(err?.message || err)
    );
    return fallback;
  }
} // end applyPromoThenVoucher

module.exports = { applyPromoThenVoucher };
