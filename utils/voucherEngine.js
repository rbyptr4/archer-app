// utils/voucherEngine.js
const mongoose = require('mongoose');
const VoucherClaim = require('../models/voucherClaimModel');
const throwError = require('./throwError');

// gunakan helpers money yang sudah kamu sediakan
const {
  int,
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('./money');

function subtotalFromItems(items = []) {
  return items.reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.qty || 0),
    0
  );
}

function filterItemsByScope(items, appliesTo) {
  // safe: jika appliesTo hilang atau null => berlaku ke semua item
  if (!appliesTo || appliesTo.mode === 'all') return items;
  if (appliesTo.mode === 'menus') {
    const set = new Set((appliesTo.menuIds || []).map(String));
    return items.filter((it) => set.has(String(it.menuId)));
  }
  if (appliesTo.mode === 'category') {
    const set = new Set((appliesTo.categories || []).map(String));
    return items.filter((it) => set.has(String(it.category)));
  }
  // fallback: jika unknown mode, treat as all
  return items;
}

function calcPercent(val, pct) {
  // pembulatan ke integer
  return Math.max(0, Math.round((Number(val || 0) * Number(pct || 0)) / 100));
}

function applyVoucherMaxCap(amount, voucher) {
  // voucher.maxDiscount: hanya dihormati jika bernilai number > 0
  if (typeof voucher.maxDiscount === 'number' && voucher.maxDiscount > 0) {
    return Math.min(amount, Number(voucher.maxDiscount || 0));
  }
  return amount;
}

function computeVoucherDiscount(voucher, items, deliveryFee) {
  // safe: voucher.appliesTo mungkin undefined
  const scoped = filterItemsByScope(items, voucher.appliesTo || null);
  const scopedSubtotal = subtotalFromItems(scoped);

  const computeShippingDiscount = () => {
    const pct = Number(voucher.shipping?.percent ?? 0);
    const cap = Number(voucher.shipping?.maxAmount ?? 0);
    if (!pct || !deliveryFee) return 0;
    let d = calcPercent(deliveryFee, pct);
    if (cap > 0) d = Math.min(d, cap);
    return Math.min(d, deliveryFee);
  };

  switch (voucher.type) {
    case 'percent': {
      const pct = Number(voucher.percent || 0);
      let itemsDisc = calcPercent(scopedSubtotal, pct);

      // APPLY PER-VOUCHER CAP jika ada
      itemsDisc = applyVoucherMaxCap(itemsDisc, voucher);

      itemsDisc = Math.min(itemsDisc, scopedSubtotal);

      const shippingDisc =
        voucher.shipping && voucher.usage?.stackableWithShipping
          ? computeShippingDiscount()
          : 0;

      return {
        itemsDiscount: itemsDisc,
        shippingDiscount: shippingDisc,
        note: 'percent'
      };
    }

    case 'amount': {
      let d = Number(voucher.amount || 0);

      // cap per-voucher
      d = applyVoucherMaxCap(d, voucher);

      d = Math.max(0, Math.min(d, scopedSubtotal));
      const shippingDisc =
        voucher.shipping && voucher.usage?.stackableWithShipping
          ? computeShippingDiscount()
          : 0;
      return {
        itemsDiscount: d,
        shippingDiscount: shippingDisc,
        note: 'amount'
      };
    }

    case 'shipping': {
      const d = computeShippingDiscount();
      // cap per-voucher (jika owner ingin cap ongkir via maxDiscount)
      const capped = applyVoucherMaxCap(d, voucher);
      return { itemsDiscount: 0, shippingDiscount: capped, note: 'shipping' };
    }

    default:
      // tipe voucher tidak dikenali -> no effect
      return { itemsDiscount: 0, shippingDiscount: 0, note: 'unknown' };
  }
}

/**
 * validateAndPrice({ memberId, cart, deliveryFee, voucherClaimIds[] })
 * Mengembalikan { ok, reasons[], breakdown, totals }
 */
async function validateAndPrice(
  { memberId, cart, deliveryFee = 0, voucherClaimIds = [] },
  { session } = {}
) {
  const items = cart.items || [];
  const baseSubtotal = subtotalFromItems(items);

  // load claims+voucher
  const claims = await VoucherClaim.find({
    _id: { $in: voucherClaimIds },
    member: memberId
  })
    .populate('voucher')
    .session(session || null);

  // filter valid claims
  const now = new Date();
  const reasons = [];
  const validClaims = [];

  for (const c of claims) {
    const v = c.voucher;
    if (!v || v.isDeleted || !v.isActive) {
      reasons.push(`${c.id}: voucher tidak aktif`);
      continue;
    }

    const mode = v.visibility?.mode || 'periodic';
    if (mode === 'periodic') {
      if (v.visibility.startAt && now < v.visibility.startAt) {
        reasons.push(`${v.name}: belum mulai`);
        continue;
      }
      if (v.visibility.endAt && now > v.visibility.endAt) {
        reasons.push(`${v.name}: sudah berakhir`);
        continue;
      }
    }
    if (c.validUntil && now > c.validUntil) {
      reasons.push(`${v.name}: claim expired`);
      continue;
    }
    if (c.status !== 'claimed' || (c.remainingUse || 0) < 1) {
      reasons.push(`${v.name}: tidak tersedia`);
      continue;
    }

    // min transaksi (gunakan baseSubtotal yang sudah termasuk addons)
    if ((v.target?.minTransaction || 0) > baseSubtotal) {
      reasons.push(`${v.name}: minimal transaksi belum terpenuhi`);
      continue;
    }

    validClaims.push(c);
  }

  // separate shipping vs non-shipping
  const shippingClaims = validClaims.filter(
    (c) => c.voucher.type === 'shipping'
  );
  const nonShipping = validClaims.filter((c) => c.voucher.type !== 'shipping');

  const chosen = [];

  if (nonShipping.length > 0) {
    if (nonShipping.length === 1) {
      chosen.push(nonShipping[0]);
    } else {
      let best = null,
        bestValue = -1;
      for (const c of nonShipping) {
        const est = computeVoucherDiscount(c.voucher, items, deliveryFee);
        const val = est.itemsDiscount + est.shippingDiscount;
        if (val > bestValue) {
          bestValue = val;
          best = c;
        }
      }
      if (best) {
        chosen.push(best);
      }
      reasons.push(
        `Hanya satu voucher non-ongkir yang bisa dipakai. Dipilih: ${
          best ? best.voucher.name : 'tidak ada'
        }`
      );
    }
  }

  // SHIPPING: boleh digabung dengan satu non-shipping yang dipilih
  if (shippingClaims.length > 0) {
    // pilih shipping terbaik (max shippingDiscount)
    let bestShip = null,
      bestShipValue = -1;
    for (const c of shippingClaims) {
      const est = computeVoucherDiscount(c.voucher, items, deliveryFee);
      const val = est.shippingDiscount;
      if (val > bestShipValue) {
        bestShipValue = val;
        bestShip = c;
      }
    }
    if (bestShip) {
      chosen.push(bestShip);
    }
  }

  // compute chosen voucher effects
  const breakdown = [];
  let itemsDiscount = 0;
  let shippingDiscount = 0;

  for (const c of chosen) {
    const r = computeVoucherDiscount(c.voucher, items, deliveryFee);
    breakdown.push({
      claimId: String(c._id),
      voucherId: String(c.voucher._id),
      name: c.voucher.name,
      ...r
    });
    itemsDiscount += r.itemsDiscount;
    shippingDiscount += r.shippingDiscount;
  }

  // Guard: jangan melebihi subtotal item atau ongkir
  itemsDiscount = Math.max(0, Math.min(itemsDiscount, baseSubtotal));
  shippingDiscount = Math.max(
    0,
    Math.min(shippingDiscount, Number(deliveryFee || 0))
  );

  // subtotal setelah diskon item
  const items_subtotal_after_discount = Math.max(
    0,
    baseSubtotal - itemsDiscount
  );

  // delivery after shipping discount
  const deliveryAfter = Math.max(
    0,
    Number(deliveryFee || 0) - shippingDiscount
  );

  // SERVICE FEE: dihitung dari items subtotal setelah discount
  const service_fee = int(
    Math.round(items_subtotal_after_discount * Number(SERVICE_FEE_RATE))
  );

  // Pajak (PPN): gunakan parsePpnRate() sehingga sama dengan money util
  const ppnRate = parsePpnRate();
  const taxAmount = int(Math.round(items_subtotal_after_discount * ppnRate));

  // sebelum pembulatan
  const beforeRound = int(
    items_subtotal_after_discount + service_fee + deliveryAfter + taxAmount
  );

  // pembulatan sesuai rule project
  const grandTotalRounded = int(roundRupiahCustom(beforeRound));
  const rounding_delta = int(grandTotalRounded - beforeRound);

  const grandTotal = Math.max(0, grandTotalRounded);

  return {
    ok: true,
    reasons,
    breakdown,
    totals: {
      baseSubtotal: int(baseSubtotal),
      itemsDiscount: int(itemsDiscount),
      items_subtotal_after_discount: int(items_subtotal_after_discount),
      deliveryFee: int(deliveryFee),
      shippingDiscount: int(shippingDiscount),
      deliveryAfter: int(deliveryAfter),

      service_fee: int(service_fee),
      tax_amount: int(taxAmount),
      beforeRound: int(beforeRound),
      rounding_delta: int(rounding_delta),
      grandTotal: int(grandTotal)
    },
    chosenClaimIds: chosen.map((c) => String(c._id))
  };
}

module.exports = { validateAndPrice, filterItemsByScope };
