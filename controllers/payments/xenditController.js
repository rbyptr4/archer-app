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
 * 2) VIRTUAL ACCOUNT (in-app, Fixed VA sekali pakai per order)
 *  - Endpoint Xendit: POST /callback_virtual_accounts
 *  - Simpan id VA & expiry ke Order
 *  - Return va_number + bank + expiry ke FE
 * ========================================================= */
exports.createVA = async (req, res, next) => {
  try {
    const { orderId, bank = 'BCA' } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'orderId wajib' });

    const BANK = String(bank || 'BCA').toUpperCase(); // BCA, BNI, MANDIRI, BRI, dll.
    const { o, amount } = await ensureOrderForPayment(orderId);

    // Kalau sudah punya VA aktif & belum expired -> reuse
    if (
      o.payment_provider === 'xendit' &&
      o.payment_method === 'transfer' &&
      o.payment_invoice_id &&
      o.payment_expires_at &&
      new Date(o.payment_expires_at) > new Date()
    ) {
      return res.json({
        success: true,
        data: {
          orderId: String(o._id),
          channel: 'VA',
          amount,
          va: {
            bank: o.payment_invoice_external_id || BANK,
            va_number: o.payment_invoice_url || '',
            expiry_at: o.payment_expires_at
          },
          status: o.payment_status || 'unpaid'
        }
      });
    }

    const external_id = `ORDER-${o._id}-${Date.now()}`;
    const payload = {
      external_id,
      bank_code: BANK,
      name:
        o.member && o.customer_name
          ? o.customer_name
          : o.customer_name || 'Guest',
      is_closed: true, // fix amount
      is_single_use: true,
      expected_amount: amount,
      expiration_date: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 jam
    };

    const resp = await axios.post(
      `${X_BASE}/callback_virtual_accounts`,
      payload,
      {
        auth: { username: X_KEY, password: '' },
        headers: HDRS,
        timeout: 15000
      }
    );

    const va = resp.data; // ada fields: id, account_number, bank_code, expiration_date
    o.payment_provider = 'xendit';
    o.payment_method = 'transfer';
    o.payment_invoice_id = va.id;
    o.payment_invoice_external_id = va.bank_code; // simpan bank
    o.payment_invoice_url = va.account_number; // simpan nomor VA di field ini
    o.payment_expires_at = va.expiration_date
      ? new Date(va.expiration_date)
      : null;
    o.payment_status = 'unpaid';
    await o.save();

    return res.json({
      success: true,
      data: {
        orderId: String(o._id),
        channel: 'VA',
        amount,
        va: {
          bank: va.bank_code,
          va_number: va.account_number,
          expiry_at: va.expiration_date
        },
        status: 'unpaid'
      }
    });
  } catch (err) {
    next(err);
  }
};

/* =========================================================
 * 3) E-WALLET (opsional) — klik langsung (mobile) / QR di desktop
 *  - Endpoint Xendit: POST /ewallets/charges
 *  - FE bisa pakai deeplink_url (mobile) atau checkout_url/qr (desktop)
 * ========================================================= */
exports.createEwallet = async (req, res, next) => {
  try {
    const { orderId, wallet = 'DANA', mobile = false } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'orderId wajib' });

    const WL = String(wallet || 'DANA').toUpperCase(); // DANA|OVO|SHOPEEPAY|GOPAY|LINKAJA
    const { o, amount } = await ensureOrderForPayment(orderId);

    const reference_id = `ORDER-${o._id}-${Date.now()}`;
    const payload = {
      reference_id,
      currency: 'IDR',
      amount,
      checkout_method: mobile ? 'ONE_TIME_PAYMENT' : 'TOKENIZATION', // Xendit akan mengembalikan deeplink/qr sesuai channel
      channel_code: `ID_${WL}`,
      channel_properties: {
        success_redirect_url: `${process.env.FRONTEND_URL}/orders/${o._id}/thank-you`,
        failure_redirect_url: `${process.process.FRONTEND_URL || ''}/orders/${
          o._id
        }/payment-failed`
      },
      metadata: { orderId: String(o._id) }
    };

    const resp = await axios.post(`${X_BASE}/ewallets/charges`, payload, {
      auth: { username: X_KEY, password: '' },
      headers: HDRS,
      timeout: 15000
    });

    const ew = resp.data; // bisa mengandung actions: { mobile_web_checkout_url / mobile_deeplink / qr_checkout_string ... }
    o.payment_provider = 'xendit';
    o.payment_method = 'qris'; // atau tandai 'ewallet' kalau kamu tambahkan enum
    o.payment_invoice_id = ew.id;
    o.payment_invoice_external_id = reference_id;
    o.payment_expires_at = ew?.expires_at ? new Date(ew.expires_at) : null;
    o.payment_status = 'unpaid';
    await o.save();

    return res.json({
      success: true,
      data: {
        orderId: String(o._id),
        channel: 'EWALLET',
        amount,
        ewallet: {
          provider: WL,
          actions: ew.actions || {}, // FE bisa pilih deeplink/qr/url sesuai device
          expiry_at: ew.expires_at || null
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
