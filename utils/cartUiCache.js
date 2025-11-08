const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money');

function buildUiTotalsFromCart(cart) {
  const itemsSubtotal = Number(cart.total_price || 0);

  // biarkan delivery_fee ditarik dari snapshot (akan dioverride di controller saat delivery)
  const deliveryFee = Number(cart?.delivery?.delivery_fee || 0);
  const itemsDiscount = Number(cart.items_discount || 0) || 0;
  const shippingDiscount = Number(cart.shipping_discount || 0) || 0;

  // === SF 2% dari ITEMS SAJA ===
  const svcRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = Math.round(itemsSubtotal * svcRate);

  // === PPN HANYA dari items (setelah item_discount) ===
  const rate = parsePpnRate();
  const taxBase = Math.max(0, itemsSubtotal - itemsDiscount);
  const taxAmount = Math.round(taxBase * rate);
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;

  // === Pure grand total (TANPA ongkir), lalu pembulatan custom ===
  const grandBeforeRound =
    itemsSubtotal + serviceFee - itemsDiscount - shippingDiscount + taxAmount;

  const after =
    typeof roundRupiahCustom === 'function'
      ? roundRupiahCustom(grandBeforeRound)
      : Math.round(grandBeforeRound);

  const roundingDelta = Number(after) - Number(grandBeforeRound);

  return {
    items_subtotal: itemsSubtotal,
    service_fee: serviceFee,
    items_discount: itemsDiscount,
    delivery_fee: deliveryFee, // info saja; controller akan override kalau FT=delivery
    shipping_discount: shippingDiscount,
    tax_rate_percent: taxRatePercent,
    tax_amount: taxAmount,
    rounding_delta: roundingDelta,
    grand_total: after
  };
}

module.exports = { buildUiTotalsFromCart };
