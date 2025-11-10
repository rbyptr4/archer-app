// controllers/paymentWebhookController.js
const PaymentSession = require('../../models/paymentSessionModel');
const Order = require('../../models/orderModel');
const Member = require('../../models/memberModel');
const Cart = require('../../models/cartModel');

const {
  recordOrderHistory,
  snapshotOrder
} = require('../../controllers/owner/orderHistoryController');
const { awardPointsIfEligible } = require('../../utils/loyalty');
const { nextDailyTxCode } = require('../../utils/txCode');
const throwError = require('../../utils/throwError');
const { int } = require('../../utils/money');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('../socket/socketBus');

/* ====== Helper: apply payment success (idempotent) ====== */
async function applyPaymentSuccess(session, rawEvent) {
  if (!session) return null;
  let order = null;

  // --- Fallback delivery snapshot untuk DELIVERY ---
  let deliverySnap = session.delivery_snapshot;
  if (session.fulfillment_type === 'delivery') {
    const ok =
      deliverySnap &&
      typeof deliverySnap?.location?.lat === 'number' &&
      typeof deliverySnap?.location?.lng === 'number' &&
      typeof deliverySnap?.distance_km === 'number';
    if (!ok) {
      deliverySnap = {
        address_text: String(session.address_text || 'Alamat tidak tersedia'),
        location: {
          lat: Number(session.lat) || 0, // default supaya lolos validator
          lng: Number(session.lng) || 0
        },
        distance_km: Number(session.distance_km) || 0,
        delivery_fee: int(session.delivery_fee || 0),
        note_to_rider: String(session.note_to_rider || ''),
        status: 'pending'
      };
    }
  }

  // Jika sudah ada order link → ambil
  if (session.order) {
    order = await Order.findById(session.order);
    if (!order) {
      console.warn(
        '[Payment] session.order tidak ditemukan:',
        String(session.order)
      );
    }
  }

  // Jika belum ada order → buat dari snapshot session
  if (!order) {
    const code = await nextDailyTxCode('ARCH');
    order = await Order.create({
      member: session.member || null,

      customer_name: session.member
        ? ''
        : session.customer_name || 'Guest QRIS',
      customer_phone: session.member ? '' : session.customer_phone || '',

      source: session.source || 'online',
      fulfillment_type: session.fulfillment_type,
      table_number: session.table_number || null,

      transaction_code: code,

      items: session.items || [],
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

      payment_invoice_id: session.qr_code_id || '',
      payment_invoice_external_id: session.external_id || '',
      payment_invoice_url: session.qr_string || '',
      payment_expires_at: session.expires_at || null,
      payment_raw_webhook: rawEvent || session.payment_raw_webhook || null,

      delivery:
        session.fulfillment_type === 'delivery' ? deliverySnap : undefined
    });

    session.order = order._id;
  }

  // Commit payment (idempotent)
  if (order.payment_status !== 'paid' && order.payment_status !== 'verified') {
    order.payment_status = 'paid';
    order.paid_at = new Date();
    order.payment_provider = 'xendit';
    order.payment_raw_webhook = rawEvent || order.payment_raw_webhook;
    if (order.status === 'created') order.status = 'accepted'; // opsional auto-accept
    await order.save();

    // Loyalty (best-effort)
    try {
      await awardPointsIfEligible(order, Member);
    } catch (e) {
      console.warn('[Payment] awardPointsIfEligible warn:', e?.message);
    }

    // Emit realtime
    const payload = {
      id: String(order._id),
      transaction_code: order.transaction_code,
      grand_total: order.grand_total,
      payment_status: order.payment_status,
      source: order.source,
      fulfillment_type: order.fulfillment_type,
      table_number: order.table_number
    };
    emitToStaff('order:payment_success', payload);
    if (order.member)
      emitToMember(order.member, 'order:payment_success', payload);
    if (order.table_number)
      emitToTable(order.table_number, 'order:payment_success', payload);
  }

  // === Clear cart (idempotent) ===
  try {
    if (session.cart && !session.cart_cleared) {
      await Cart.findByIdAndUpdate(session.cart, {
        $set: {
          status: 'checked_out',
          checked_out_at: new Date(),
          order_id: order._id,
          items: [],
          total_items: 0,
          total_quantity: 0,
          total_price: 0
        }
      });
      session.cart_cleared = true; // tandai supaya tidak double clear
    }
  } catch (e) {
    console.warn('[Payment] clear cart warn:', e?.message);
  }

  // Update session
  session.status = 'paid';
  await session.save();

  return order;
}

/* ============================ WEBHOOK (QRIS) ============================ */
exports.xenditQrisWebhook = async (req, res) => {
  try {
    // Optional: verifikasi callback token
    const token = req.headers['x-callback-token'];
    if (
      process.env.XENDIT_CALLBACK_TOKEN &&
      token !== process.env.XENDIT_CALLBACK_TOKEN
    ) {
      return res.status(401).json({ message: 'Invalid callback token' });
    }

    // Body bisa text atau object (tergantung parser di router)
    let ev;
    if (typeof req.body === 'string') {
      try {
        ev = JSON.parse(req.body);
      } catch {
        console.warn('[Xendit QRIS] invalid JSON body');
        return res.status(400).json({ message: 'Invalid JSON' });
      }
    } else {
      ev = req.body || {};
    }

    // Balas cepat agar Xendit tidak retry
    res.json({ received: true });

    // Normalisasi payload
    const data = ev.data || ev;
    const reference_id = data.reference_id || ev.reference_id || null;
    const metadata = data.metadata || ev.metadata || {};
    const rawStatus = data.status || ev.status || '';
    const status = String(rawStatus).toUpperCase();

    // Status-status yang dianggap "paid"
    const PAID_STATUSES = ['PAID', 'SUCCEEDED', 'COMPLETED', 'CAPTURED'];

    if (!reference_id && !metadata.payment_session_id) {
      console.warn('[Xendit QRIS] Missing reference_id & payment_session_id');
      return;
    }

    if (!PAID_STATUSES.includes(status)) {
      console.log('[Xendit QRIS] Non-paid status:', status);
      // Optional: update session status expired/failed (jika ada reference_id)
      if (reference_id) {
        const sess = await PaymentSession.findOne({
          external_id: reference_id
        });
        if (sess) {
          sess.status = status.toLowerCase();
          await sess.save();
        }
      }
      return;
    }

    // Cari session
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

    // Catat provider ref id / raw event
    session.provider_ref_id = data.id || session.provider_ref_id;
    session.raw = ev;
    await session.save();

    // Terapkan sukses (idempotent)
    const order = await applyPaymentSuccess(session, ev);
    if (order) {
      console.log(
        '[Xendit QRIS] Payment applied to order:',
        order.transaction_code
      );

      try {
        // Catat history: pembayaran berhasil via webhook
        await recordOrderHistory(order._id, 'payment_status', null, {
          from: order.payment_status === 'unpaid' ? 'unpaid' : 'pending',
          to: 'paid',
          note: 'Pembayaran QRIS berhasil',
          at: new Date(),
          transaction_code: order.transaction_code,
          source: order.source,
          fulfillment_type: order.fulfillment_type,
          status: order.status,
          payment_status: 'paid'
        });

        // Snapshot baru setelah pembayaran berhasil
        await snapshotOrder(order._id, {
          verified_by_name: 'XenditWebhook'
        }).catch(() => {});
      } catch (err) {
        throwError('');
        console.error('[OrderHistory][xenditQrisWebhook]', err?.message || err);
      }
    }
  } catch (e) {
    throwError('error: ' + e, 400);
    console.error('[xendit webhook] error', e);
  }
};
