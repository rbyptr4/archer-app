// utils/wablas.js
const axios = require('axios');

const BASE = process.env.WABLAS_BASE || 'https://tegal.wablas.com/api';
const BASE_V2 = process.env.WABLAS_BASE_V2 || 'https://tegal.wablas.com/api/v2';
const AUTH = `${process.env.WABLAS_TOKEN}.${process.env.WABLAS_SECRET}`;

/** Kirim text sederhana */
async function sendText(phone, message) {
  if (!phone || !message) return { ok: false, reason: 'empty phone/message' };
  try {
    const res = await axios.get(`${BASE}/send-message`, {
      params: { phone, message, token: AUTH },
      timeout: 10000
    });
    return res.data;
  } catch (err) {
    return { ok: false, error: err?.message || 'wa_send_failed' };
  }
}

/** Sudah ada di kamu, biarkan tetap tersedia */
async function sendOtpText(phone, code) {
  const message = `
  🔐 Kode OTP Archers : *${code}*

_Jangan bagikan kode ini ke siapa pun._
_Berlaku 5 menit._
`;
  const res = await axios.get(`${BASE}/send-message`, {
    params: { phone, message, token: AUTH },
    timeout: 10000
  });
  return res.data;
}

/* ===== Formatter kecil yang bisa dipakai ulang ===== */
const rp = (n) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;
const fmtDT = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
};

function buildOrderReceiptMessage(order) {
  const lines = [];
  lines.push(`✅ *Pembayaran Terverifikasi*`);
  lines.push(`Kode Transaksi: *${order.transaction_code || '-'}*`);
  lines.push(
    `Waktu: ${fmtDT(order.verified_at || order.paid_at || order.placed_at)}`
  );
  lines.push('');
  if (order.fulfillment_type === 'delivery') {
    lines.push(`Tipe: Delivery`);
    if (order.delivery?.address_text)
      lines.push(`Alamat: ${order.delivery.address_text}`);
    if (typeof order.delivery?.delivery_fee === 'number')
      lines.push(`Ongkir: ${rp(order.delivery.delivery_fee)}`);
  } else {
    lines.push(
      `Tipe: Dine-in${
        order.table_number ? ` (Meja ${order.table_number})` : ''
      }`
    );
  }
  lines.push('');
  lines.push(`*Rincian Pesanan:*`);
  for (const it of order.items || []) {
    const base = `• ${it.name} x${it.quantity} — ${rp(it.line_subtotal)}`;
    lines.push(base);
    if (Array.isArray(it.addons) && it.addons.length) {
      for (const ad of it.addons) {
        lines.push(
          `   ◦ + ${ad.name} x${ad.qty} (${rp(ad.price * (ad.qty || 1))})`
        );
      }
    }
    if (it.notes) lines.push(`   ◦ Catatan: _${it.notes}_`);
  }
  lines.push('');
  if (order.items_discount)
    lines.push(`Diskon Item: -${rp(order.items_discount)}`);
  if (order.shipping_discount)
    lines.push(`Diskon Ongkir: -${rp(order.shipping_discount)}`);
  lines.push(`Total: *${rp(order.grand_total)}*`);
  lines.push('');
  lines.push(`Metode: ${order.payment_method?.toUpperCase() || '-'}`);
  lines.push(`Status Bayar: ${order.payment_status || '-'}`);
  lines.push('');
  lines.push(`Terima kasih telah memesan di *Archer*. 🙏`);
  return lines.join('\n');
}

function buildClosingShiftMessage(doc, phase = 'step2') {
  // phase: 'step2' | 'locked'
  const badge =
    phase === 'locked'
      ? '🔒 Laporan Closing (FINAL)'
      : '📝 Laporan Closing (Shift-2)';
  const lines = [];
  lines.push(`${badge}`);
  lines.push(`Tanggal: ${fmtDT(doc.date || doc.createdAt).split(',')[0]}`);
  lines.push(`Tipe: *${String(doc.type || '').toUpperCase()}*`);
  lines.push(`Status: *${doc.status}*`);
  lines.push('');

  if (doc.shift1?.staff?.name)
    lines.push(
      `Shift-1: ${doc.shift1.staff.name}${
        doc.shift1.staff.position ? ` (${doc.shift1.staff.position})` : ''
      }`
    );
  if (doc.shift2?.staff?.name)
    lines.push(
      `Shift-2: ${doc.shift2.staff.name}${
        doc.shift2.staff.position ? ` (${doc.shift2.staff.position})` : ''
      }`
    );
  lines.push('');

  if (doc.type === 'cashier') {
    const s1 = doc.shift1?.cashier || {};
    const s2 = doc.shift2?.cashier || {};
    lines.push(`*Kasir*`);
    if (typeof s1.previousTurnover === 'number')
      lines.push(`Omzet Awal: ${rp(s1.previousTurnover)}`);
    if (typeof s2.diffFromShift1 === 'number')
      lines.push(`Selisih Shift-2: ${rp(s2.diffFromShift1)}`);
    if (s2.closingBreakdown) {
      lines.push(`Rincian Closing:`);
      lines.push(`• Cash: ${rp(s2.closingBreakdown.cash)}`);
      lines.push(`• QRIS: ${rp(s2.closingBreakdown.qris)}`);
      lines.push(`• Transfer: ${rp(s2.closingBreakdown.transfer)}`);
    }
  } else {
    const s1 = doc.shift1?.stockItemsStart || [];
    const s2 = doc.shift2?.stockItemsEnd || [];
    lines.push(`*Stok*`);
    if (s1.length) {
      lines.push(`Awal:`);
      for (const r of s1) lines.push(`• ${r.name}: ${r.qty}`);
    }
    if (s2.length) {
      lines.push(`Akhir:`);
      for (const r of s2) lines.push(`• ${r.name}: ${r.qty}`);
    }
    if (doc.shift2?.requestPurchase) lines.push(`Permintaan Pembelian: *YA*`);
  }

  if (doc.shift2?.note) {
    lines.push('');
    lines.push(`Catatan: _${doc.shift2.note}_`);
  }

  if (phase === 'locked' && doc.lockAt) {
    lines.push('');
    lines.push(`Dikunci pada: ${fmtDT(doc.lockAt)}`);
  }

  lines.push('');
  lines.push(`— Archer System`);
  return lines.join('\n');
}

module.exports = {
  sendText,
  sendOtpText,
  buildOrderReceiptMessage,
  buildClosingShiftMessage,
  rp,
  fmtDT
};
