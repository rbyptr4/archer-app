// controllers/paymentWebhookController.js
const PaymentSession = require('../../models/paymentSessionModel');
const Order = require('../../models/orderModel');
const { awardPointsIfEligible } = require('../../utils/loyalty');
const { nextDailyTxCode } = require('../../utils/txCode');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('../socket/socketBus');

exports.xenditQrisWebhook = async (req, res) => {
  try {
    // === Parser aman ===
    let ev;
    if (typeof req.body === 'string') {
      try {
        ev = JSON.parse(req.body);
      } catch {
        console.warn('[Webhook] gagal parse body string');
        return res.status(400).json({ message: 'Invalid JSON' });
      }
    } else {
      ev = req.body || {};
    }

    // Kirim dulu response biar Xendit gak retry
    res.json({ received: true });

    // ====== Logika di bawah ini asinkron ======
    const reference_id = ev?.data?.reference_id || ev?.reference_id;
    const status = ev?.data?.status || ev?.status;
    if (!reference_id) {
      console.warn('[Webhook] Missing reference_id');
      return;
    }

    const session = await PaymentSession.findOne({
      external_id: reference_id
    });
    if (!session) {
      console.warn('[Webhook] Session not found for', reference_id);
      return;
    }

    // Hindari double order
    if (session.order) return;

    const paidStatuses = ['COMPLETED', 'SUCCEEDED', 'PAID'];
    if (!paidStatuses.includes(String(status).toUpperCase())) {
      return;
    }

    // ===== Create Order dari snapshot =====
    const code = await nextDailyTxCode('ARCH');
    const order = await Order.create({
      member: session.member || null,
      customer_name: session.customer_name,
      customer_phone: session.customer_phone,
      source: session.source || 'online',
      fulfillment_type: session.fulfillment_type,
      table_number: session.table_number || null,
      transaction_code: code,

      items: session.items,
      items_subtotal: session.items_subtotal,
      delivery_fee: session.delivery_fee,
      service_fee: session.service_fee,
      items_discount: session.items_discount,
      shipping_discount: session.shipping_discount,
      discounts: session.discounts,

      payment_method: 'qris',
      payment_provider: 'xendit',
      payment_status: 'paid',
      paid_at: new Date(),
      status: 'created',
      placed_at: new Date(),
      payment_invoice_id: session.qr_code_id,
      payment_invoice_external_id: session.external_id,
      payment_invoice_url: session.qr_string,
      payment_expires_at: session.expires_at,
      payment_raw_webhook: ev
    });

    session.status = 'paid';
    session.order = order._id;
    await session.save();

    await awardPointsIfEligible(order, require('../models/memberModel'));

    const payload = {
      id: String(order._id),
      transaction_code: order.transaction_code,
      grand_total: order.grand_total,
      payment_status: order.payment_status,
      source: order.source,
      fulfillment_type: order.fulfillment_type,
      table_number: order.table_number
    };
    emitToStaff('order:new', payload);
    if (order.member) emitToMember(order.member, 'order:new', payload);
    if (order.table_number)
      emitToTable(order.table_number, 'order:new', payload);
  } catch (e) {
    console.error('[xendit webhook] error', e);
    // tetap 200 supaya Xendit tidak retry
    try {
      res.status(200).json({ received: true });
    } catch {}
  }
};
