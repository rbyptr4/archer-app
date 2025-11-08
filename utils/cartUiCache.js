// utils/cartUiCache.js
const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money');

function buildUiTotalsFromCart(cart) {
  // Gunakan angka yg sudah direcomputeTotals ke dalam cart:
  // asumsi cart.total_price = baseSubtotal (tanpa tax/service)
  const itemsSubtotal = Number(cart.total_price || 0);

  const deliveryFee = Number(cart?.delivery?.delivery_fee || 0);
  const itemsDiscount = Number(cart.items_discount || 0); // kalau belum ada, default 0
  const shippingDiscount = Number(cart.shipping_discount || 0); // default 0

  const svcRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFeeRaw = itemsSubtotal * svcRate;
  const serviceFee =
    typeof roundRupiahCustom === 'function'
      ? roundRupiahCustom(serviceFeeRaw)
      : Math.round(serviceFeeRaw);

  const rate = parsePpnRate();
  const taxBase = Math.max(
    0,
    itemsSubtotal - itemsDiscount + deliveryFee - shippingDiscount
  );
  const taxAmount = Math.round(taxBase * rate);
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;

  const grandBeforeRound = taxBase + taxAmount + serviceFee;
  const after =
    typeof roundRupiahCustom === 'function'
      ? roundRupiahCustom(grandBeforeRound)
      : grandBeforeRound;
  const roundingDelta = Number(after) - Number(grandBeforeRound);

  return {
    items_subtotal: itemsSubtotal,
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

async function recomputeAndCache(cart) {
  // kamu sudah punya recomputeTotals(cart)
  recomputeTotals(cart);
  // simpan cache visual untuk GET
  cart.ui_cache = buildUiTotalsFromCart(cart);
  await cart.save();
}

module.exports = { buildUiTotalsFromCart, recomputeAndCache };
