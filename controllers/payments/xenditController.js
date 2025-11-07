const axios = require('axios');
const Order = require('../../models/orderModel');

const X_BASE = process.env.XENDIT_BASE_URL || 'https://api.xendit.co';
const X_KEY = process.env.XENDIT_SECRET_KEY || '';
const HDRS = { 'Content-Type': 'application/json' };

/* ===== Helper umum ===== */
async function ensureOrderForPayment(orderId) {
  const o = await Order.findById(orderId);
  if (!o) throw new Error('Order tidak ditemukan');
  if (['paid', 'verified'].includes(o.payment_status)) {
    throw new Error('Order sudah dibayar');
  }
  // jumlah yang dibayar SELALU = grand_total (sudah termasuk PPN)
  const amount = Number(o.grand_total || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Nominal order tidak valid');
  }
  return { o, amount };
}

/* =========================================================
 * 1) QRIS DINAMIS (in-app)
 *  - Endpoint Xendit: POST /qr_codes (header `api-version: 2022-07-31`)
 *  - Simpan id & expiry ke Order
 *  - Return qr_string + expiry ke FE
 * ========================================================= */
exports.createQris = async (req, res, next) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'orderId wajib' });

    const { o, amount } = await ensureOrderForPayment(orderId);

    // Reuse session kalau masih aktif
    if (
      o.payment_provider === 'xendit' &&
      o.payment_invoice_id &&
      o.payment_expires_at &&
      new Date(o.payment_expires_at) > new Date()
    ) {
      return res.json({
        success: true,
        data: {
          orderId: String(o._id),
          channel: 'QRIS',
          amount,
          qris: {
            qr_string: o.payment_invoice_url || '', // kita pakai field ini sebagai penampung qr_string
            expiry_at: o.payment_expires_at
          },
          status: o.payment_status || 'unpaid'
        }
      });
    }

    const reference_id = `ORDER-${o._id}-${Date.now()}`;
    const payload = {
      reference_id,
      type: 'DYNAMIC',
      currency: 'IDR',
      amount,
      // (opsional) metadata untuk trace balik
      metadata: { orderId: String(o._id) }
    };

    const resp = await axios.post(`${X_BASE}/qr_codes`, payload, {
      auth: { username: X_KEY, password: '' },
      headers: { ...HDRS, 'api-version': '2022-07-31' },
      timeout: 15000
    });

    // Catatan: response berisi id (qr_code_id), qr_string, expires_at
    const qr = resp.data;
    o.payment_provider = 'xendit';
    o.payment_method = 'qris';
    o.payment_invoice_id = qr.id;
    o.payment_invoice_external_id = reference_id;
    o.payment_invoice_url = qr.qr_string; // simpan string QR di sini
    o.payment_expires_at = qr.expires_at ? new Date(qr.expires_at) : null;
    o.payment_status = 'unpaid';
    await o.save();

    return res.json({
      success: true,
      data: {
        orderId: String(o._id),
        channel: 'QRIS',
        amount,
        qris: {
          qr_string: qr.qr_string,
          expiry_at: qr.expires_at
        },
        status: 'unpaid'
      }
    });
  } catch (err) {
    next(err);
  }
};

/* =========================================================
 * 4) POLLING STATUS RINGKAS (FE cek tiap 3–5s)
 * ========================================================= */
exports.getPaymentStatus = async (req, res, next) => {
  try {
    const { id } = req.params || {};
    const o = await Order.findById(id).lean();
    if (!o) return res.status(404).json({ message: 'Order tidak ditemukan' });

    return res.json({
      orderId: String(o._id),
      payment_status: o.payment_status || 'unpaid',
      method: o.payment_method || null,
      provider: o.payment_provider || null,
      amount: o.grand_total || 0,
      expiry_at: o.payment_expires_at || null
    });
  } catch (err) {
    next(err);
  }
};
