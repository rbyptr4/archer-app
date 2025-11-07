// controllers/paymentWebhookController.js
const PaymentSession = require('../../models/paymentSessionModel');
const Order = require('../../models/orderModel');
const Member = require('../../models/memberModel');
const { awardPointsIfEligible } = require('../../utils/loyalty');
const { nextDailyTxCode } = require('../../utils/txCode');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('../socket/socketBus');

exports.xenditQrisWebhook = async (req, res) => {
  // SELALU bungkus di try-catch, tapi jangan ngirim response dua kali
  try {
    // --- optional security ---
    const token = req.headers['x-callback-token'];
    if (
      process.env.XENDIT_CALLBACK_TOKEN &&
      token !== process.env.XENDIT_CALLBACK_TOKEN
    ) {
      return res.status(401).json({ message: 'Invalid callback token' });
    }

    // --- parsing body aman: karena kita pakai express.text({ type: '*/*' }) di router ---
    let ev;
    if (typeof req.body === 'string') {
      try {
        ev = JSON.parse(req.body);
      } catch (e) {
        console.warn('[Xendit QRIS] invalid JSON body');
        return res.status(400).json({ message: 'Invalid JSON' });
      }
    } else {
      ev = req.body || {};
    }

    // Balas dulu ke Xendit biar dia gak retry-retry.
    // Logic lanjut di bawah jalan "di belakang layar".
    res.json({ received: true });

    // --- Normalisasi payload ---
    const data = ev.data || ev;
    const reference_id = data.reference_id || ev.reference_id || null;
    const metadata = data.metadata || ev.metadata || {};
    const rawStatus = data.status || ev.status || '';
    const status = String(rawStatus).toUpperCase();

    const PAID_STATUSES = ['PAID', 'SUCCEEDED', 'COMPLETED', 'CAPTURED'];

    if (!reference_id && !metadata.payment_session_id) {
      console.warn('[Xendit QRIS] Missing reference_id & payment_session_id');
      return;
    }

    if (!PAID_STATUSES.includes(status)) {
      // bukan event paid -> kita cuekin aja (expired/failed/pending)
      console.log('[Xendit QRIS] Non-paid status:', status);
      return;
    }

    // --- Cari PaymentSession ---
    let session = null;

    if (metadata.payment_session_id) {
      session = await PaymentSession.findById(metadata.payment_session_id);
    }

    if (!session && reference_id) {
      session = await PaymentSession.findOne({ external_id: reference_id });
    }

    if (!session) {
      console.warn(
        '[Xendit QRIS] PaymentSession not found for ref=',
        reference_id,
        'meta=',
        metadata.payment_session_id
      );
      return;
    }

    // --- Idempotent: kalau sudah ada order, jangan buat lagi ---
    if (session.order) {
      console.log(
        '[Xendit QRIS] Session already linked to order',
        String(session.order)
      );
      return;
    }

    // --- Pastikan identitas lolos validasi Order ---
    let customer_name = (session.customer_name || '').trim();
    let customer_phone = (session.customer_phone || '').trim();

    if (!session.member && !customer_name && !customer_phone) {
      customer_name = 'Guest QRIS';
    }

    // --- Generate transaction code ---
    const code = await nextDailyTxCode('ARCH');

    // --- Create Order dari snapshot PaymentSession ---
    const order = await Order.create({
      member: session.member || null,

      customer_name: session.member ? '' : customer_name,
      customer_phone: session.member ? '' : customer_phone,

      source: session.source || 'online',
      fulfillment_type: session.fulfillment_type,
      table_number: session.table_number || null,

      transaction_code: code,

      items: session.items || [],

      // komponen pricing (hook pre('validate') akan hitung grand_total, tax, dll)
      items_subtotal: session.items_subtotal || 0,
      delivery_fee: session.delivery_fee || 0,
      service_fee: session.service_fee || 0,
      items_discount: session.items_discount || 0,
      shipping_discount: session.shipping_discount || 0,
      discounts: session.discounts || [],

      payment_method: 'qris',
      payment_provider: 'xendit',
      payment_status: 'paid',
      paid_at: new Date(),

      status: 'created',
      placed_at: new Date(),

      payment_invoice_id: data.id || session.qr_code_id || '',
      payment_invoice_external_id: session.external_id || reference_id || '',
      payment_invoice_url: session.qr_string || '',
      payment_expires_at: session.expires_at || null,
      payment_raw_webhook: ev
    });

    // --- Update session ---
    session.status = 'paid';
    session.order = order._id;
    await session.save();

    // --- Loyalty ---
    await awardPointsIfEligible(order, Member);

    // --- Emit realtime ---
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

    console.log(
      '[Xendit QRIS] Order created from webhook:',
      order.transaction_code
    );
  } catch (e) {
    console.error('[xendit webhook] error', e);
  }
};
