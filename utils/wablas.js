// utils/wablas.js
const axios = require('axios');

const BASE = process.env.WABLAS_BASE || 'https://tegal.wablas.com/api';
const BASE_V2 = process.env.WABLAS_BASE_V2 || 'https://tegal.wablas.com/api/v2';
const AUTH = `${process.env.WABLAS_TOKEN}.${process.env.WABLAS_SECRET}`;

/* ===== Formatter kecil yang bisa dipakai ulang ===== */
const rp = (n) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;
const fmtDT = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
};

function fmtRp(n) {
  try {
    return `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
  } catch {
    return `Rp ${n || 0}`;
  }
}

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

async function sendOtpText(phone, code) {
  const message = `
  🔐 Kode OTP Archers : *${code}*

_Jangan bagikan kode ini ke siapa pun._
_Berlaku 5 menit._

_
`;
  const res = await axios.get(`${BASE}/send-message`, {
    params: { phone, message, token: AUTH },
    timeout: 10000
  });
  return res.data;
}

function buildOrderReceiptMessage({ order, uiTotals }) {
  const lines = [];

  lines.push('🏹 *Archers Cafe*');
  lines.push('');

  // Kode + Customer
  lines.push(`*Order:* ${order.transaction_code}`);
  lines.push(`*Customer:* ${order.customer_name || 'Tamu'}`);
  lines.push(`*Waktu:* ${new Date(order.placed_at).toLocaleString('id-ID')}`);
  lines.push('');

  lines.push('=== Rincian Pesanan ===');

  // Item list
  for (const it of order.items) {
    const name = it.name || it.menu_code || 'Item';
    const qty = Number(it.quantity ?? it.qty ?? 1);
    const price = Number(it.base_price || it.price || 0);
    const lineTotal = qty * price;

    lines.push(`${name} x${qty}  Rp ${lineTotal.toLocaleString('id-ID')}`);
  }

  lines.push('');

  // Totals breakdown
  lines.push('=== Ringkasan Harga ===');
  lines.push(
    `Sub-total: Rp ${uiTotals.items_subtotal.toLocaleString('id-ID')}`
  );

  if (uiTotals.items_discount > 0)
    lines.push(
      `Diskon: -Rp ${uiTotals.items_discount.toLocaleString('id-ID')}`
    );

  if (uiTotals.shipping_discount > 0)
    lines.push(
      `Potongan Ongkir: -Rp ${uiTotals.shipping_discount.toLocaleString(
        'id-ID'
      )}`
    );

  lines.push(`Service fee: Rp ${uiTotals.service_fee.toLocaleString('id-ID')}`);
  lines.push(`Pajak: Rp ${uiTotals.tax_amount.toLocaleString('id-ID')}`);

  if (uiTotals.rounding_delta !== 0)
    lines.push(
      `Pembulatan: Rp ${uiTotals.rounding_delta.toLocaleString('id-ID')}`
    );

  lines.push('');
  lines.push(
    `*Total Bayar:* Rp ${uiTotals.grand_total.toLocaleString('id-ID')}`
  );
  lines.push(`*Metode:* ${order.payment_method.toUpperCase()}`);

  // Voucher, promo, free item, dll
  if (Array.isArray(order.appliedVouchers) && order.appliedVouchers.length) {
    lines.push('');
    lines.push('Voucher digunakan:');
    for (const v of order.appliedVouchers) {
      lines.push(`• ${v.voucherId}`);
    }
  }

  if (order.appliedPromo?.promoSnapshot) {
    const p = order.appliedPromo.promoSnapshot;
    lines.push('');
    lines.push(`Promo: *${p.name || 'Promo'}*`);
    if (p.description) lines.push(p.description);

    // free items snapshot
    if (Array.isArray(p.freeItemsSnapshot) && p.freeItemsSnapshot.length) {
      lines.push('Bonus:');
      for (const f of p.freeItemsSnapshot) {
        lines.push(`• ${f.name || 'Free Item'} x${f.qty}`);
      }
    }
  }

  lines.push('');
  lines.push('Terima kasih telah memesan!');
  lines.push('');
  lines.push('');
  lines.push('Pesanan sedang diproses, mohon ditunggu sebentar ✨');
  lines.push('Archers Cafe 🏹');

  return lines.join('\n');
}

function buildClosingShiftMessage({ closingShift = {}, totals = {} } = {}) {
  const lines = [];
  const type = (closingShift.type || 'unknown').toUpperCase();
  const dateStr = closingShift.date
    ? new Date(closingShift.date).toLocaleDateString('id-ID')
    : '-';

  // Header
  lines.push(`🏹 *Archers Cafe — Laporan Closing (${type})*`);
  lines.push(`Tanggal: ${dateStr}`);
  lines.push(`Status: *${closingShift.status || '-'}*`);
  lines.push('');

  // --- SHIFT 1 ---
  if (closingShift.shift1) {
    const s1 = closingShift.shift1;
    lines.push(
      `*Shift 1* — ${s1.staff.name} ${
        s1.staff.position ? `(${s1.staff.position})` : ''
      }`
    );

    if (type === 'CASHIER' && s1.cashier) {
      lines.push(`Opening Turnover: ${fmtRp(s1.cashier.previousTurnover)}`);
      lines.push('Opening Breakdown:');
      lines.push(` • Cash: ${fmtRp(s1.cashier.openingBreakdown?.cash)}`);
      lines.push(` • QRIS: ${fmtRp(s1.cashier.openingBreakdown?.qris)}`);
      lines.push(
        ` • Transfer: ${fmtRp(s1.cashier.openingBreakdown?.transfer)}`
      );
      lines.push(` • Card: ${fmtRp(s1.cashier.openingBreakdown?.card)}`);
    }

    if (
      (type === 'BAR' || type === 'KITCHEN') &&
      Array.isArray(s1.stockItemsStart)
    ) {
      lines.push('');
      lines.push('Opname Awal:');
      for (const r of s1.stockItemsStart) {
        lines.push(` • ${r.name}: ${r.qty}`);
      }
    }
  }

  lines.push('');

  // --- SHIFT 2 ---
  if (closingShift.shift2) {
    const s2 = closingShift.shift2;
    lines.push(
      `*Shift 2* — ${s2.staff.name} ${
        s2.staff.position ? `(${s2.staff.position})` : ''
      }`
    );

    if (type === 'CASHIER' && s2.cashier) {
      lines.push('Closing Breakdown:');
      lines.push(` • Cash: ${fmtRp(s2.cashier.closingBreakdown?.cash)}`);
      lines.push(` • QRIS: ${fmtRp(s2.cashier.closingBreakdown?.qris)}`);
      lines.push(
        ` • Transfer: ${fmtRp(s2.cashier.closingBreakdown?.transfer)}`
      );
      lines.push(` • Card: ${fmtRp(s2.cashier.closingBreakdown?.card)}`);
      lines.push(`Selisih Shift 1 → 2: ${fmtRp(s2.diffFromShift1)}`);
    }

    if (
      (type === 'BAR' || type === 'KITCHEN') &&
      Array.isArray(s2.stockItemsEnd)
    ) {
      lines.push('');
      lines.push('Opname Akhir:');
      for (const r of s2.stockItemsEnd) {
        lines.push(` • ${r.name}: ${r.qty}`);
      }
    }

    if (s2.note) {
      lines.push('');
      lines.push('*Catatan Shift:*');
      lines.push(s2.note);
    }

    if (s2.requestPurchase) {
      lines.push('');
      lines.push('🔔 *Permintaan Pembelian:* Ya ');
    }
  } else {
    lines.push('*Shift 2 belum disubmit*');
  }

  lines.push('');

  // --- SUMMARY FOR OWNER ---
  lines.push('=== *Ringkasan Hari Ini* ===');

  if (type === 'CASHIER') {
    if (totals && Object.keys(totals).length) {
      lines.push(`Omset (Sistem): ${fmtRp(totals.turnover)}`);
      lines.push(`Pembayaran:`);
      lines.push(` • Cash: ${fmtRp(totals.cash)}`);
      lines.push(` • QRIS: ${fmtRp(totals.qris)}`);
      lines.push(` • Transfer: ${fmtRp(totals.transfer)}`);
      lines.push(` • Card: ${fmtRp(totals.card)}`);
    } else {
      lines.push('(Data omset sistem tidak tersedia)');
    }
  }

  if (type === 'BAR') {
    lines.push(
      'Ringkasan stok bar sudah dicatat. Mohon cek item yang turun signifikan.'
    );
  }

  if (type === 'KITCHEN') {
    lines.push(
      'Ringkasan stok kitchen sudah dicatat. Mohon cek bahan yang perlu restock.'
    );
  }

  lines.push('');
  lines.push('Laporan ini otomatis dikirim ke Owner untuk monitoring harian.');
  lines.push('🏹 Archers Cafe');

  return lines.join('\n');
}

function buildOwnerVerifyMessage(order, verifyLink, expireHours = 6) {
  const lines = [];

  lines.push('🔔 *Verifikasi Pembayaran Diperlukan*');
  lines.push(`Kode Order: *${order.transaction_code || '-'}*`);
  lines.push(
    `Waktu Pesan: ${fmtDT(order.placed_at || order.createdAt || new Date())}`
  );

  /* ===== Tipe order ===== */
  const mode = order?.delivery?.mode || 'none';
  let typeLabel = '';

  if (mode === 'none') {
    typeLabel = `Dine-in${
      order.table_number ? ` (Meja ${order.table_number})` : ''
    }`;
  } else if (mode === 'pickup') {
    typeLabel = 'Pickup';
  } else {
    typeLabel = 'Delivery';
  }

  lines.push(`Tipe: ${typeLabel}`);

  if (mode === 'delivery') {
    if (order.delivery?.address_text)
      lines.push(`Alamat: ${order.delivery.address_text}`);
    if (order.delivery?.distance_km)
      lines.push(`Jarak: ${order.delivery.distance_km} km`);
  }

  lines.push('');

  /* ===== Informasi pemesan ===== */
  const name = order.customer_name || '-';
  const phone = order.customer_phone || '-';
  lines.push(`Pemesan: ${name} (${phone})`);

  /* ===== Ringkasan harga ===== */
  lines.push(`Total: *${rp(order.grand_total)}*`);
  const pm = order.payment_method ? order.payment_method.toUpperCase() : '-';
  lines.push(`Metode: *${pm}*`);

  if (order.payment_proof_url) {
    lines.push('');
    lines.push('*Bukti Pembayaran:*');
    lines.push(order.payment_proof_url);
  }

  /* ===== Mini ringkasan items ===== */
  if (Array.isArray(order.items) && order.items.length) {
    lines.push('');
    lines.push('*Rincian Item:*');

    const maxItemsPreview = 3;
    const preview = order.items.slice(0, maxItemsPreview);

    for (const it of preview) {
      const nm = it.name || it.menu_code || 'Item';
      const qty = Number(it.quantity || it.qty || 1);
      lines.push(`• ${nm} x${qty}`);
    }

    if (order.items.length > maxItemsPreview) {
      lines.push(`• +${order.items.length - maxItemsPreview} item lainnya`);
    }
  }

  lines.push('');
  lines.push('Silakan verifikasi pembayaran melalui link berikut:');
  lines.push(verifyLink);
  lines.push(`(Berlaku *${expireHours} jam*, satu kali pakai)`);

  lines.push('');
  lines.push('— Archer System 🏹');

  return lines.join('\n');
}

module.exports = {
  sendText,
  sendOtpText,
  buildOrderReceiptMessage,
  buildClosingShiftMessage,
  buildOwnerVerifyMessage,
  rp,
  fmtDT
};
