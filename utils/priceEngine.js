// utils/priceEngine.js
const PromoModel = require('../models/promoModel'); // jika beda path, sesuaikan

const {
  applyPromo: applyPromoRaw,
  findApplicablePromos
} = require('./promoEngine');
const { validateAndPrice } = require('./voucherEngine');
const throwError = require('./throwError');

const int = (v) => Math.round(Number(v || 0));

/**
 * Distribusi diskon cart (flat) ke setiap item secara proporsional berdasarkan line total.
 * - items: [{ menuId, qty, price, category }]
 * - discount: integer
 * returns new items array with adjusted price (per-unit)
 */
function distributeDiscountToItems(items, discount) {
  if (!Array.isArray(items) || items.length === 0 || !discount) return items;
  const totals = items.map((it) => ({
    ...it,
    lineTotal: Number(it.price || 0) * Number(it.qty || 0)
  }));
  const baseTotal = totals.reduce((s, x) => s + x.lineTotal, 0) || 0;
  if (baseTotal <= 0) return items;

  let remaining = discount;
  const adjusted = totals.map((t) => {
    if (t.lineTotal <= 0) return { ...t, newUnitPrice: t.price };
    const share = Math.round((t.lineTotal / baseTotal) * discount);
    const dec = Math.min(share, remaining, t.lineTotal);
    const newLine = Math.max(0, t.lineTotal - dec);
    const newUnit = Math.round(newLine / Math.max(1, Number(t.qty || 1)));
    remaining = Math.max(0, remaining - dec);
    return { ...t, newUnitPrice: newUnit };
  });

  if (remaining > 0) {
    adjusted.sort((a, b) => b.lineTotal - a.lineTotal);
    const top = adjusted[0];
    const topLine = top.lineTotal;
    const dec = Math.min(topLine, remaining);
    const newLine = Math.max(0, topLine - dec);
    top.newUnitPrice = Math.round(newLine / Math.max(1, Number(top.qty || 1)));
    remaining = 0;
  }

  return adjusted.map((a) => ({
    menuId: a.menuId,
    qty: Number(a.qty || 0),
    price: int(a.newUnitPrice),
    category: a.category || null
  }));
}

/**
 * applyPromoThenVoucher({...})
 * - orchestrates promo -> optionally voucher -> final totals
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
  // opsional: fetchers untuk usage counts
  promoUsageFetchers = {}
} = {}) {
  const effectiveMember = memberDoc || (memberId ? { _id: memberId } : null);

  let applicable = [];
  try {
    applicable = await findApplicablePromos(cart, effectiveMember, now, {
      fetchers: promoUsageFetchers
    });
  } catch (e) {
    console.warn('[priceEngine] findApplicablePromos failed', e?.message || e);
    applicable = [];
  }

  // ========== DEBUG: log snapshot untuk membandingkan preview vs checkout ==========
  try {
    console.log(
      '[priceEngine.debug] selectedPromoId:',
      String(selectedPromoId)
    );
  } catch (e) {}
  console.log(
    '[priceEngine.debug] effectiveMember:',
    JSON.stringify(effectiveMember)
  );
  console.log(
    '[priceEngine.debug] fulfillmentType:',
    fulfillmentType,
    'deliveryFee:',
    deliveryFee
  );
  console.log(
    '[priceEngine.debug] cart.items:',
    JSON.stringify(cart.items || [])
  );
  console.log(
    '[priceEngine.debug] applicableIds:',
    (applicable || []).map((p) => String(p._id))
  );
  // =======================================================================

  let promoApplied = null;
  let selectedPromoRejected = false;
  let selectedPromoReplacedBy = null;

  if (selectedPromoId) {
    promoApplied =
      applicable.find((p) => String(p._id) === String(selectedPromoId)) || null;

    if (!promoApplied) {
      console.warn(
        '[priceEngine.warn] selectedPromoId tidak ada di applicable, akan coba fetch+apply langsung',
        {
          selectedPromoId,
          applicableIds: (applicable || []).map((p) => String(p._id))
        }
      );

      // coba ambil promo langsung dari DB (sesuaikan path model jika perlu)
      let promoFromDb = null;
      try {
        promoFromDb = await PromoModel.findById(selectedPromoId).lean();
      } catch (e) {
        promoFromDb = null;
      }

      if (promoFromDb) {
        try {
          // coba apply langsung; applyPromoRaw biasanya throw kalau tidak applicable
          await applyPromoRaw(promoFromDb, cart);
          // jika tidak throw => anggap valid, gunakan promoFromDb
          promoApplied = promoFromDb;
          promoApplied._id = promoFromDb._id;
          selectedPromoReplacedBy = String(promoFromDb._id);
          console.log(
            '[priceEngine.info] selectedPromo berhasil diaplikasikan via direct applyPromoRaw',
            selectedPromoReplacedBy
          );
        } catch (e) {
          console.warn(
            '[priceEngine.warn] direct applyPromoRaw gagal untuk selectedPromo',
            { selectedPromoId, err: e?.message || e }
          );
          selectedPromoRejected = true;
        }
      } else {
        console.warn(
          '[priceEngine.warn] selectedPromoId tidak ditemukan di DB',
          { selectedPromoId }
        );
        selectedPromoRejected = true;
      }

      // jika masih rejected, coba auto-best sebagai fallback
      if (selectedPromoRejected) {
        let best = null;
        let bestValue = -1;
        if (Array.isArray(applicable) && applicable.length) {
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
              // ignore failing promo
            }
          }
        }
        if (best) {
          promoApplied = best.promo;
          selectedPromoReplacedBy = String(best.promo._id);
          console.log(
            '[priceEngine.info] selectedPromo diganti oleh auto-best',
            selectedPromoReplacedBy
          );
        } else {
          // tetap nol -> lanjut tanpa promo
          promoApplied = null;
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

  // 3) terapkan promo (pure) -> hasil impact + cartAfterPromo
  let cartAfterPromo = JSON.parse(JSON.stringify(cart));
  let promoImpact = null;
  let promoActions = [];
  let promoAppliedSnapshot = null;

  if (promoApplied) {
    const { impact, actions } = await applyPromoRaw(promoApplied, cart);
    promoImpact = impact || {};
    promoActions = actions || [];
    promoAppliedSnapshot = {
      promoId: String(promoApplied._id),
      name: promoApplied.name || null,
      impact: promoImpact,
      actions: promoActions || []
    };

    // tambahkan free items (harga 0)
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

    // distribusikan discount ke line items
    const discount = Number(
      promoImpact.itemsDiscount || promoImpact.cartDiscount || 0
    );
    if (discount > 0) {
      cartAfterPromo.items = distributeDiscountToItems(
        cartAfterPromo.items,
        discount
      );
    }
  }

  // 4) jika promo memblokir voucher -> hitung totals sederhana dan return
  if (promoApplied && promoApplied.blocksVoucher) {
    const items = cartAfterPromo.items || [];
    const baseSubtotal = items.reduce(
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

    return {
      ok: true,
      reasons: [`Promo (${promoApplied.name}) memblokir penggunaan voucher.`],
      promoApplied: promoAppliedSnapshot,
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
      chosenClaimIds: []
    };
  }

  // 5) panggil voucher engine dengan cartAfterPromo
  const voucherRes = await validateAndPrice({
    memberId,
    cart: {
      items: cartAfterPromo.items.map((it) => ({
        menuId: it.menuId,
        qty: Number(it.qty || 0),
        price: Number(it.price || 0),
        category: it.category || null
      }))
    },
    fulfillmentType,
    deliveryFee,
    voucherClaimIds
  });

  // 6) gabungkan info promo ke response
  const final = {
    ok: voucherRes.ok,
    reasons: (voucherRes.reasons || []).slice(),
    promoApplied: promoApplied
      ? {
          promoId: String(promoApplied._id),
          impact: promoImpact,
          actions: promoActions
        }
      : null,
    voucherResult: voucherRes,
    breakdown: voucherRes.breakdown || [],
    totals: voucherRes.totals || {},
    chosenClaimIds: voucherRes.chosenClaimIds || []
  };

  return final;
}

module.exports = { applyPromoThenVoucher };
