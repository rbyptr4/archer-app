const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money');

function buildUiTotalsFromCart(cart) {
  // safety parse
  const items_subtotal = Number(cart.total_price || 0); // total menu + addons (BEFORE discount)
  const deliveryFee = Number(cart?.delivery?.delivery_fee || 0);
  const itemsDiscount = Number(cart.items_discount || 0) || 0; // voucher item discount
  const shippingDiscount = Number(cart.shipping_discount || 0) || 0; // voucher shipping discount

  // taxable base = items subtotal AFTER item-level discounts
  const items_subtotal_after_discount = Math.max(
    0,
    items_subtotal - itemsDiscount
  );

  // --- Service fee: 2% dari items subtotal AFTER discount ---
  const svcRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = Math.round(items_subtotal_after_discount * svcRate);

  // --- Tax: dihitung dari items subtotal AFTER discount ---
  const rate = parsePpnRate();
  const taxAmount = Math.round(items_subtotal_after_discount * rate);

  // --- Compose raw total (sebelum custom rounding) ---
  // Formula: items_after_discount + service + delivery - shippingDiscount + tax
  const rawTotal =
    items_subtotal_after_discount +
    serviceFee +
    deliveryFee -
    shippingDiscount +
    taxAmount;

  // --- Custom rounding (if helper available), else normal Math.round ---
  const rounded =
    typeof roundRupiahCustom === 'function'
      ? roundRupiahCustom(rawTotal)
      : Math.round(rawTotal);

  const roundingDelta = Number(rounded) - Number(rawTotal);

  return {
    // keep both before-discount and after-discount for FE clarity
    items_subtotal: items_subtotal,
    items_subtotal_after_discount: items_subtotal_after_discount, // NEW
    items_discount: itemsDiscount,
    service_fee: serviceFee,
    tax_amount: taxAmount,

    delivery_fee: deliveryFee,
    shipping_discount: shippingDiscount,

    rounding_delta: roundingDelta,
    grand_total: Number(rounded)
  };
}

module.exports = { buildUiTotalsFromCart };
