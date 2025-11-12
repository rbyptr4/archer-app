// utils/buildUiTotalsFromCart.js
const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money');

function buildUiTotalsFromCart(cart = {}, opts = {}) {
  const deliveryModeOpt = opts.deliveryMode ?? null;
  const envDeliveryFee =
    Number(opts.envDeliveryFee ?? process.env.DELIVERY_FLAT_FEE ?? 0) || 0;
  const forceChargeDelivery = !!opts.forceChargeDelivery;

  // safety parse
  const items_subtotal = Number(cart.total_price || 0); // total menu + addons (BEFORE discount)

  // pick delivery source: prefer delivery_draft (cart model you have), fallback delivery
  const deliverySrc = cart.delivery_draft || cart.delivery || null;

  // if delivery fee stored on cart, use it (but only if mode says 'delivery')
  let rawDeliveryFeeFromCart = Number(deliverySrc?.delivery_fee || 0);

  // determine effective delivery mode: priority opts > cart.delivery_draft.mode > cart.delivery.mode
  const cartDeliveryMode =
    (deliveryModeOpt && String(deliveryModeOpt).toLowerCase()) ||
    (deliverySrc?.mode && String(deliverySrc.mode).toLowerCase()) ||
    null;

  // decide final delivery fee: charge only if mode === 'delivery' OR forceChargeDelivery true
  const shouldChargeDelivery =
    forceChargeDelivery || cartDeliveryMode === 'delivery';
  const deliveryFee = shouldChargeDelivery
    ? rawDeliveryFeeFromCart > 0
      ? rawDeliveryFeeFromCart
      : envDeliveryFee
    : 0;

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
    items_subtotal,
    items_subtotal_after_discount,
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
