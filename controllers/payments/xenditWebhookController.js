// controllers/payments/xenditWebhookController.js
const asyncHandler = require('express-async-handler');
const Order = require('../../models/orderModel');
const { logPaidHistory } = require('../../utils/historyLoggers');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('../socket/socketBus');

exports.webhook = asyncHandler(async (req, res) => {
  const token = req.headers['x-callback-token'];
  if (
    process.env.XENDIT_CALLBACK_TOKEN &&
    token !== process.env.XENDIT_CALLBACK_TOKEN
  ) {
    return res.status(401).json({ message: 'Invalid callback token' });
  }

  const ev = req.body || {};
  const rawStatus = String(ev.status || ev.payment_status || '').toUpperCase();
  const succeeded = ['PAID', 'SUCCEEDED', 'COMPLETED', 'CAPTURED'].includes(
    rawStatus
  );
  const expired = ['EXPIRED'].includes(rawStatus);
  const failed = ['FAILED', 'VOID'].includes(rawStatus);

  // Cari orderId
  const orderId =
    ev?.metadata?.orderId ||
    (ev?.reference_id && ev.reference_id.split('ORDER-')[1]?.split('-')[0]) ||
    null;

  if (!orderId) {
    console.warn('[XENDIT] Webhook tanpa orderId:', ev);
    return res.json({ received: true });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    console.warn('[XENDIT] Order tidak ditemukan untuk webhook', orderId);
    return res.json({ received: true });
  }

  // Update status
  if (succeeded) {
    order.payment_status = 'paid';
    order.paid_at = new Date();
    order.payment_provider = 'xendit';
    order.payment_invoice_id = ev.id || order.payment_invoice_id;
    order.payment_invoice_url = ev.qr_string || order.payment_invoice_url;
    await order.save();

    // log ke history
    await logPaidHistory(order).catch((err) =>
      console.error('logPaidHistory error:', err?.message || err)
    );

    // Emit realtime
    const payload = {
      id: String(order._id),
      transaction_code: order.transaction_code,
      payment_status: order.payment_status,
      payment_method: order.payment_method,
      grand_total: order.grand_total,
      paid_at: order.paid_at,
      channel: ev.channel_code || null
    };
    emitToStaff('order:paid', payload);
    if (order.member) emitToMember(order.member, 'order:paid', payload);
    if (order.table_number)
      emitToTable(order.table_number, 'order:paid', payload);

    console.log('[XENDIT] Payment success for', order.transaction_code);
  } else if (expired || failed) {
    order.payment_status = 'void';
    await order.save();
    console.log('[XENDIT] Payment failed/expired for', order.transaction_code);
  }

  return res.json({ received: true });
});
