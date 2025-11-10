const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money');

function buildUiTotalsFromCart(cart) {
  // safety parse
  const items_subtotal = Number(cart.total_price || 0); // total menu + addons (BEFORE tax)
  const deliveryFee = Number(cart?.delivery?.delivery_fee || 0);
  const itemsDiscount = Number(cart.items_discount || 0) || 0;
  const shippingDiscount = Number(cart.shipping_discount || 0) || 0;

  // --- Service fee: 2% dari items subtotal (aggregate) ---
  const svcRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = Math.round(items_subtotal * svcRate);

  // --- Tax: dihitung dari items subtotal (aggregate). NOT affected by voucher ---
  const rate = parsePpnRate();
  const taxAmount = Math.round(items_subtotal * rate);

  // --- Compose raw total (sebelum custom rounding) ---
  // Formula: items + service + delivery - itemDiscount - shippingDiscount + tax
  const rawTotal =
    items_subtotal +
    serviceFee +
    deliveryFee -
    itemsDiscount -
    shippingDiscount +
    taxAmount;

  // --- Custom rounding (if helper tersedia), else normal Math.round ---
  const rounded =
    typeof roundRupiahCustom === 'function'
      ? roundRupiahCustom(rawTotal)
      : Math.round(rawTotal);

  const roundingDelta = Number(rounded) - Number(rawTotal);

  return {
    // keep both before-tax and with-tax subtotals for FE clarity
    items_subtotal: items_subtotal,
    service_fee: serviceFee,
    tax_amount: taxAmount,

    delivery_fee: deliveryFee,
    items_discount: itemsDiscount,
    shipping_discount: shippingDiscount,

    rounding_delta: roundingDelta,
    grand_total: Number(rounded)
  };
}

module.exports = { buildUiTotalsFromCart };
