// utils/voucherEngine.js
const mongoose = require('mongoose');
const Voucher = require('../models/voucherModel');
const VoucherClaim = require('../models/voucherClaimModel');
const throwError = require('./throwError');

// Ambil info kebutuhan dari cart:
// - items: [{menuId, qty, price, category}]
function subtotalFromItems(items = []) {
  return items.reduce((sum, it) => sum + it.price * it.qty, 0);
}

function filterItemsByScope(items, appliesTo) {
  if (!appliesTo || appliesTo.mode === 'all') return items;
  if (appliesTo.mode === 'menus') {
    const set = new Set((appliesTo.menuIds || []).map(String));
    return items.filter((it) => set.has(String(it.menuId)));
  }
  if (appliesTo.mode === 'category') {
    const set = new Set((appliesTo.categories || []).map(String));
    return items.filter((it) => set.has(String(it.category)));
  }
  return items;
}

function calcPercent(val, pct) {
  return Math.floor((val * pct) / 100);
}

function computeVoucherDiscount(voucher, items, deliveryFee) {
  const scoped = filterItemsByScope(items, voucher.appliesTo);
  const scopedSubtotal = subtotalFromItems(scoped);

  switch (voucher.type) {
    case 'percent': {
      const d = calcPercent(scopedSubtotal, voucher.percent || 0);
      return { itemsDiscount: d, shippingDiscount: 0, note: 'percent' };
    }
    case 'amount': {
      const d = Math.min(voucher.amount || 0, scopedSubtotal);
      return { itemsDiscount: d, shippingDiscount: 0, note: 'amount' };
    }
    case 'free_item': {
      // versi simpel: gratis 1 item termurah di scope
      const cheapest = scoped.reduce(
        (m, it) => (m && m.price < it.price ? m : it),
        null
      );
      const d = cheapest ? cheapest.price : 0;
      return { itemsDiscount: d, shippingDiscount: 0, note: 'free_item' };
    }
    case 'bundling': {
      const need = voucher.appliesTo?.bundling?.buyQty || 0;
      if (!need)
        return {
          itemsDiscount: 0,
          shippingDiscount: 0,
          note: 'bundling(no config)'
        };
      const qtyTotal = scoped.reduce((q, it) => q + it.qty, 0);
      if (qtyTotal < need)
        return {
          itemsDiscount: 0,
          shippingDiscount: 0,
          note: 'bundling(not enough qty)'
        };
      const pct = voucher.appliesTo?.bundling?.getPercent || 0;
      const d = calcPercent(scopedSubtotal, pct);
      return { itemsDiscount: d, shippingDiscount: 0, note: 'bundling' };
    }
    case 'shipping': {
      const pct = voucher.shipping?.percent ?? 100;
      const cap = voucher.shipping?.maxAmount ?? 0;
      let d = calcPercent(deliveryFee, pct);
      if (cap > 0) d = Math.min(d, cap);
      return { itemsDiscount: 0, shippingDiscount: d, note: 'shipping' };
    }
    default:
      return { itemsDiscount: 0, shippingDiscount: 0, note: 'unknown' };
  }
}

/**
 * validateAndPrice({ memberId, cart, deliveryFee, voucherClaimIds[] })
 * Mengembalikan { ok, reasons[], breakdown, totals }
 * Wajib dipanggil di server saat preview checkout & saat confirm order (dengan session).
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

    // window & expiry
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

    // min transaksi
    if ((v.target?.minTransaction || 0) > baseSubtotal) {
      reasons.push(`${v.name}: minimal transaksi belum terpenuhi`);
      continue;
    }

    validClaims.push(c);
  }

  // stacking rule: maksimal 1 non-shipping + opsional 1 shipping
  const shippingClaims = validClaims.filter(
    (c) => c.voucher.type === 'shipping'
  );
  const nonShipping = validClaims.filter((c) => c.voucher.type !== 'shipping');

  const chosen = [];
  if (nonShipping.length > 1) {
    // pilih yang benefit terbesar
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
    chosen.push(best);
    reasons.push(
      `Hanya satu voucher non-ongkir yang bisa dipakai, dipilih: ${best.voucher.name}`
    );
  } else if (nonShipping.length === 1) {
    chosen.push(nonShipping[0]);
  }
  // boleh tambah 1 shipping (kalau ada)
  if (shippingClaims.length > 0) {
    // ambil yang shipping diskonnya paling besar
    let best = null,
      bestValue = -1;
    for (const c of shippingClaims) {
      const est = computeVoucherDiscount(c.voucher, items, deliveryFee);
      const val = est.shippingDiscount;
      if (val > bestValue) {
        bestValue = val;
        best = c;
      }
    }
    chosen.push(best);
  }

  // hitung
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

  const subtotal = baseSubtotal - itemsDiscount;
  const deliveryAfter = Math.max(0, deliveryFee - shippingDiscount);
  const grandTotal = Math.max(0, subtotal + deliveryAfter);

  return {
    ok: true,
    reasons,
    breakdown,
    totals: {
      baseSubtotal,
      itemsDiscount,
      subtotal,
      deliveryFee,
      shippingDiscount,
      deliveryAfter,
      grandTotal
    },
    chosenClaimIds: chosen.map((c) => String(c._id))
  };
}

module.exports = { validateAndPrice };
