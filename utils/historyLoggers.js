// utils/historyLogger.js
const OrderHistory = require('../models/orderHistoryModel');
const Member = require('../models/memberModel');

/**
 * Buat entry history saat pembayaran jadi PAID.
 * Dipanggil dari:
 *  - POS create (mark_paid = true)
 *  - verifyPayment (staff memverifikasi)
 */
exports.logPaidHistory = async function logPaidHistory(order, cashierUser) {
  try {
    const opts = {};
    if (cashierUser?.name) opts.verified_by_name = cashierUser.name;

    // (opsional) isi nama/phone member bila belum ter-embed di order
    if (order.member && (!order.member_name || !order.member_phone)) {
      const m = await Member.findById(order.member).lean();
      if (m) {
        order.member_name = m.name;
        order.member_phone = m.phone;
      }
    }
    await OrderHistory.createFromOrder(order, opts);
  } catch (e) {
    // Jangan gagalkan alur utama
    console.error('[history] logPaidHistory error:', e?.message || e);
  }
};

/**
 * Buat entry history saat REFUND/VOID/CANCEL (jejak jelas).
 * Disarankan bikin dokumen baru agar timeline transparan.
 */
exports.logRefundHistory = async function logRefundHistory(order) {
  try {
    const clone = order.toObject ? order.toObject() : order;
    clone.payment_status = 'refunded';
    clone.status = clone.status || 'cancelled';
    clone.is_refund = true;
    await OrderHistory.createFromOrder(clone);
  } catch (e) {
    console.error('[history] logRefundHistory error:', e?.message || e);
  }
};
