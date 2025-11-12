// utils/voucherEngine.js (modifikasi)
// tambahkan di bagian atas file (di atas fungsi-fungsi lain)
const SERVICE_FEE_RATE = Number(process.env.SERVICE_FEE_RATE || 0.02); // default 2%
const PPN_RATE = Number(process.env.PPN_RATE || 0.11); // default 11%

const int = (v) => Math.round(Number(v || 0));

// simple rounding helper (approximation).
// Jika kamu punya roundRupiahCustom di project, ganti penggunaan ini dengan import tersebut.
function roundRupiahCustom(n) {
  // contoh: pembulatan ke kelipatan 50 (sesuai banyak implementasi lokal)
  return Math.round(n / 50) * 50;
}

async function validateAndPrice(
  { memberId, cart, deliveryFee = 0, voucherClaimIds = [] },
  { session } = {}
) {
  const items = cart.items || [];
  const baseSubtotal = subtotalFromItems(items); // sudah diasumsikan price tiap item termasuk addons

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

    // min transaksi (catatan: gunakan baseSubtotal yang sudah termasuk addons)
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

  // hitung voucher effect
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

  // SERVICE FEE: dihitung dari items subtotal setelah discount (sesuai kebutuhanmu)
  const service_fee = int(
    Math.round(items_subtotal_after_discount * SERVICE_FEE_RATE)
  );

  // Pajak (PPN) dihitung dari items subtotal setelah discount (sesuaikan kalau mau inklusif service)
  const taxAmount = int(Math.round(items_subtotal_after_discount * PPN_RATE));

  // sebelum pembulatan
  const beforeRound = int(
    items_subtotal_after_discount + service_fee + deliveryAfter + taxAmount
  );

  // pembulatan custom (gunakan rule rounding yang sama dengan checkout)
  const grandTotalRounded = int(roundRupiahCustom(beforeRound));
  const rounding_delta = int(grandTotalRounded - beforeRound);

  // final grand total yang akan dibayar (tidak boleh negatif)
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

      // tambahan fields
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
