const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money');

function buildUiTotalsFromCart(cart) {
  const itemsSubtotalBeforeTax = Number(cart.total_price || 0); // total menu tanpa pajak
  const deliveryFee = Number(cart?.delivery?.delivery_fee || 0);
  const itemsDiscount = Number(cart.items_discount || 0) || 0;
  const shippingDiscount = Number(cart.shipping_discount || 0) || 0;

  // === Service fee 2% dari total items (sebelum pajak & diskon) ===
  const svcRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = Math.round(itemsSubtotalBeforeTax * svcRate);

  // === Pajak (PPN) dihitung dari items - item_discount ===
  const rate = parsePpnRate();
  const taxBase = Math.max(0, itemsSubtotalBeforeTax - itemsDiscount);
  const taxAmount = Math.round(taxBase * rate);
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;

  // === Subtotal termasuk pajak (biar FE lebih mudah pakai untuk tampilan) ===
  const itemsSubtotalWithTax = itemsSubtotalBeforeTax + taxAmount;

  // === Total sebelum pembulatan (belum termasuk ongkir) ===
  const grandBeforeRound =
    itemsSubtotalWithTax + serviceFee - itemsDiscount - shippingDiscount;

  // === Pembulatan custom (misal ke 0/500/1000) ===
  const after =
    typeof roundRupiahCustom === 'function'
      ? roundRupiahCustom(grandBeforeRound)
      : Math.round(grandBeforeRound);

  const roundingDelta = Number(after) - Number(grandBeforeRound);

  return {
    items_subtotal: itemsSubtotalWithTax,
    items_subtotal_before_tax: itemsSubtotalBeforeTax, // tambahan: kalau FE butuh harga sebelum pajak
    service_fee: serviceFee,
    items_discount: itemsDiscount,
    delivery_fee: deliveryFee,
    shipping_discount: shippingDiscount,
    tax_rate_percent: taxRatePercent,
    tax_amount: taxAmount,
    rounding_delta: roundingDelta,
    grand_total: after
  };
}

module.exports = { buildUiTotalsFromCart };
