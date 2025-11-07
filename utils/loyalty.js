// utils/loyalty.js

// Helper kecil (biar ga tergantung file lain)
function int(v) {
  return Math.round(Number(v || 0));
}

// Bisa di-set pakai 2 gaya:
// LOYALTY_PERCENT = 0.05  (5%)  ATAU  LOYALTY_PERCENT = 5  (5%)
function parseRate(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > 1 ? n / 100 : n;
}

// ===== ENV CONFIGURABLE =====

// Minimal base transaksi (sebelum pajak & pembulatan) untuk dapat poin
// Default: 25000
const LOYALTY_MIN_BASE = Number(process.env.LOYALTY_MIN_BASE || 25000);

// Persentase poin dari base
// Default: 5%  (0.05)
const LOYALTY_RATE = parseRate(process.env.LOYALTY_PERCENT, 0.05);

// Optional: matikan fitur via env kalau perlu
const LOYALTY_ENABLED =
  String(process.env.LOYALTY_ENABLED || 'true').toLowerCase() === 'true';

// ===== RULE BARU =====
//
// - Dipanggil setelah order fix (totals sudah ke-set & divalidasi schema).
// - Hitungan base poin:
//     base = items_subtotal
//          + delivery_fee
//          + (service_fee || 0)
//          - items_discount
//          - shipping_discount
//   (INI = total transaksi sebelum pajak & sebelum pembulatan custom)
// - Jika base > LOYALTY_MIN_BASE => points = round(base * LOYALTY_RATE)
// - Simpan ke field `points` di Member (sesuai schema lama kamu).
// - Set `loyalty_awarded_at` supaya idempotent.

exports.awardPointsIfEligible = async function awardPointsIfEligible(
  order,
  MemberModel
) {
  try {
    if (!LOYALTY_ENABLED) return;
    if (!order?.member) return;
    if (order.loyalty_awarded_at) return; // guard idempotent

    // Pastikan angka aman
    const items_subtotal = int(order.items_subtotal);
    const delivery_fee = int(order.delivery_fee);
    const service_fee = int(order.service_fee || 0);
    const items_discount = int(order.items_discount);
    const shipping_discount = int(order.shipping_discount);

    // Base poin sesuai hirarki:
    // Biaya asli + layanan - voucher, sebelum pajak & rounding
    let base =
      items_subtotal +
      delivery_fee +
      service_fee -
      items_discount -
      shipping_discount;

    base = Math.max(0, base);

    if (base <= LOYALTY_MIN_BASE) return;

    const points = int(base * LOYALTY_RATE);
    if (points <= 0) return;

    // Update saldo poin member
    await MemberModel.findByIdAndUpdate(order.member, {
      $inc: { points: points }
    });

    order.loyalty_awarded_at = new Date();
    await order.save();
  } catch (err) {
    console.warn('[loyalty] award failed:', err?.message || err);
  }
};
