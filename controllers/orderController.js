// controllers/orderController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const axios = require('axios');
const mongoose = require('mongoose');

const PaymentSession = require('../models/paymentSessionModel');
const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const User = require('../models/userModel');
const Member = require('../models/memberModel');
const Order = require('../models/orderModel');
const MemberSession = require('../models/memberSessionModel');
const VoucherClaim = require('../models/voucherClaimModel');
const Voucher = require('../models/voucherModel');
const Promo = require('../models/promoModel');

const {
  emitToCashier,
  emitToKitchen,
  emitToStaff,
  emitToMember,
  emitToGuest,
  emitToCourier,
  emitOrdersStream
} = require('./socket/socketBus');

const { evaluateMemberLevel } = require('../utils/loyalty');
const throwError = require('../utils/throwError');
const { createMember } = require('../utils/memberService');
const { DELIVERY_SLOTS } = require('../config/onlineConfig');
const {
  sendText,
  buildOrderReceiptMessage,
  buildOwnerVerifyMessage,
  rp
} = require('../utils/wablas');
const { buildUiTotalsFromCart } = require('../utils/cartUiCache');
const { applyPromoThenVoucher } = require('../utils/priceEngine');
const { getOwnerPhone } = require('../utils/ownerPhone');
const {
  consumePromoForOrder,
  releasePromoForOrder
} = require('../utils/promoConsume');

const {
  findApplicablePromos,
  applyPromo,
  executePromoActions
} = require('../utils/promoEngine');

const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom,
  int
} = require('../utils/money');
const { baseCookie } = require('../utils/authCookies');
const { buildOrderProofFileName } = require('../utils/makeFileName');
const {
  uploadBuffer,
  deleteFile,
  extractDriveIdFromUrl
} = require('../utils/googleDrive');
const { getDriveFolder } = require('../utils/driveFolders');

const { haversineKm } = require('../utils/distance');
const { nextDailyTxCode } = require('../utils/txCode');
const { validateAndPrice } = require('../utils/voucherEngine');
const { awardPointsIfEligible } = require('../utils/loyalty');

dayjs.extend(utc);
dayjs.extend(tz);

const LOCAL_TZ = 'Asia/Jakarta';

const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  REFRESH_TTL_MS,
  signAccessToken,
  generateOpaqueToken,
  hashToken
} = require('../utils/memberToken');

const QRIS_USE_STATIC =
  String(process.env.QRIS_USE_STATIC || 'false').toLowerCase() === 'true';
const QRIS_REQUIRE_PROOF =
  String(process.env.QRIS_REQUIRE_PROOF || 'true').toLowerCase() === 'true';

const OWNER_VERIFY_REQUIRED = (
  process.env.OWNER_VERIFY_REQUIRED || 'qris,transfer'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function paymentRequiresOwnerVerify(method) {
  return OWNER_VERIFY_REQUIRED.includes(String(method || '').toLowerCase());
}

const EXPIRE_HOURS = Number(process.env.OWNER_VERIFY_EXPIRE_HOURS || 6);

const {
  DELIVERY_MAX_RADIUS_KM,
  CAFE_COORD,
  DELIVERY_FLAT_FEE
} = require('../config/onlineConfig');

const X_BASE = process.env.XENDIT_BASE_URL;
const X_KEY = process.env.XENDIT_SECRET_KEY;
const HDRS = { 'Content-Type': 'application/json' };

/* ================= Cookie presets ================= */
const cookieAccess = { ...baseCookie, httpOnly: true, maxAge: 15 * 60 * 1000 };
const cookieRefresh = { ...baseCookie, httpOnly: true, maxAge: REFRESH_TTL_MS };
const cookieDevice = { ...baseCookie, httpOnly: false, maxAge: REFRESH_TTL_MS };

/* ================= Konstanta & helper status ================= */
const ALLOWED_STATUSES = ['created', 'accepted', 'completed'];
const ALLOWED_PAY_STATUS = ['verified', 'paid', 'refunded', 'void'];

const DELIVERY_ALLOWED = ['pending', 'assigned', 'delivered', 'failed'];

function parseSlotLabelToDate(slotLabel, day = null) {
  const base = (day ? day : dayjs().tz(LOCAL_TZ)).startOf('day');
  if (!slotLabel) return null;
  // jika sudah ISO (mengandung 'T' atau '-' di awal) coba parse
  if (/T/.test(slotLabel) || /-/.test(slotLabel)) {
    const d = dayjs(slotLabel).tz(LOCAL_TZ);
    return d.isValid() ? d : null;
  }
  // format 'HH:mm'
  const [hh, mm] = String(slotLabel)
    .split(':')
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return base.hour(hh).minute(mm).second(0).millisecond(0);
}

// function getSlotsForDate(dateDay = null) {
//   const day = dateDay
//     ? dateDay.tz(LOCAL_TZ).startOf('day')
//     : dayjs().tz(LOCAL_TZ).startOf('day');
//   const now = dayjs().tz(LOCAL_TZ);
//   return (DELIVERY_SLOTS || []).map((label) => {
//     const dt = parseSlotLabelToDate(label, day);
//     const available = dt && dt.isValid() && now.isBefore(dt); // only future slots allowed (strict: now < slot)
//     return {
//       label,
//       datetime: dt ? dt.toDate() : null,
//       available
//     };
//   });
// }

function getSlotsForDate(dateDay = null) {
  const day = dateDay
    ? dateDay.tz(LOCAL_TZ).startOf('day')
    : dayjs().tz(LOCAL_TZ).startOf('day');
  // const now = dayjs().tz(LOCAL_TZ); // tidak diperlukan lagi untuk testing "always available"
  return (DELIVERY_SLOTS || []).map((label) => {
    const dt = parseSlotLabelToDate(label, day);
    // Untuk testing: anggap semua slot yang parse-able sebagai available
    const available = !!(dt && dt.isValid());
    return {
      label,
      datetime: dt ? dt.toDate() : null,
      available
    };
  });
}

function isSlotAvailable(label, dateDay = null) {
  const slot = getSlotsForDate(dateDay).find((s) => s.label === label);
  return !!(slot && slot.available);
}

async function enrichFreeItemsForImpact(items = []) {
  if (!Array.isArray(items) || !items.length) return [];
  const ids = items
    .map((f) => (f.menuId ? String(f.menuId) : null))
    .filter(Boolean);
  let map = {};
  if (ids.length) {
    const docs = await Menu.find({ _id: { $in: ids } })
      .select('name imageUrl menu_code price bigCategory subcategory')
      .lean()
      .catch(() => []);
    map = Object.fromEntries(docs.map((d) => [String(d._id), d]));
  }

  return items.map((f) => {
    const mid = f.menuId ? String(f.menuId) : null;
    const md = mid ? map[mid] : null;
    return {
      menuId: mid,
      qty: Number(f.qty || 1),
      category: f.category || (md ? md.bigCategory || null : null),
      name: f.name || (md ? md.name || null : null),
      imageUrl: f.imageUrl || (md ? md.imageUrl || null : null),
      note: f.note || null
    };
  });
}

async function buildPromoCompactFromApplied({ applied }) {
  if (!applied) return null;
  const impact = applied.impact || {};
  const actions = applied.actions || [];

  const rewards = [];

  // free items
  if (Array.isArray(impact.addedFreeItems) && impact.addedFreeItems.length) {
    const enriched = await enrichFreeItemsForImpact(impact.addedFreeItems);
    for (const f of enriched) {
      rewards.push({
        type: 'free_item',
        label: `Gratis: ${f.name || 'Item'}`,
        amount: 0,
        meta: {
          menuId: f.menuId || null,
          qty: Number(f.qty || 1),
          name: f.name || null,
          imageUrl: f.imageUrl || null
        }
      });
    }
  }

  // discount
  const discountAmount = Number(
    impact.itemsDiscount || impact.cartDiscount || 0
  );
  if (discountAmount > 0) {
    rewards.push({
      type: 'discount',
      label: applied.name || 'Diskon',
      amount: discountAmount,
      meta: { note: impact.note || null }
    });
  }

  // points from impact or actions
  const pointsFromImpact = Number(impact.points || 0);
  if (pointsFromImpact > 0) {
    rewards.push({
      type: 'points',
      label: 'Poin',
      amount: pointsFromImpact,
      meta: {}
    });
  } else if (Array.isArray(actions) && actions.length) {
    for (const a of actions) {
      const typ = String(a.type || '').toLowerCase();
      if (typ === 'award_points' || typ === 'points') {
        rewards.push({
          type: 'points',
          label: a.label || 'Poin',
          amount: Number(a.points ?? a.amount ?? 0),
          meta: a.meta || {}
        });
      } else {
        // generic action
        rewards.push({
          type: a.type || 'action',
          label: a.label || a.name || null,
          amount: a.amount ?? null,
          meta: a.meta || {}
        });
      }
    }
  }

  // membership flag if promo target member-only
  if (applied.target && String(applied.target).toLowerCase() === 'member') {
    rewards.push({
      type: 'membership',
      label: 'Member only',
      amount: null,
      meta: {}
    });
  }

  return {
    appliedPromoId: applied.promoId || null,
    appliedPromoName: applied.name || null,
    type: applied.type || null,
    description: applied.description || impact.note || null,
    rewards
  };
}

function genTokenRaw(lenBytes = 32) {
  return crypto.randomBytes(lenBytes).toString('hex'); // 64 chars hex for 32 bytes
}

function hashTokenVerification(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function computeUnitPriceWithAddons(item) {
  const base = Number(item.base_price ?? item.unit_price ?? item.price ?? 0);
  const addons = Array.isArray(item.addons) ? item.addons : [];
  const addonsPerUnit = addons.reduce((sum, a) => {
    const ap = Number(a?.price || 0);
    const aq = Number(a?.qty || 1);
    return sum + ap * Math.max(1, aq);
  }, 0);
  // kalau addon memiliki isActive false abaikan
  return Math.round(base + addonsPerUnit);
}

function chooseAutoPromo(eligiblePromos = []) {
  if (!Array.isArray(eligiblePromos) || eligiblePromos.length === 0)
    return null;
  // preserve original order from DB (findApplicablePromos already sorts by priority desc in query, but be safe)
  const auto = eligiblePromos.filter((p) => !!p.autoApply);
  const pool = auto.length ? auto : eligiblePromos;
  // sort by priority desc but stable; if priorities equal, keep original order
  const withIndex = pool.map((p, idx) => ({ p, idx }));
  withIndex.sort((a, b) => {
    const pa = Number(a.p.priority || 0);
    const pb = Number(b.p.priority || 0);
    if (pb !== pa) return pb - pa;
    return a.idx - b.idx; // stable tie-break: earlier first
  });
  return withIndex.length ? withIndex[0].p : null;
}

// normalisasi cart buat price engine (pastikan semua panggilan ke engine pakai ini)
function normalizeCartForEngine(cart) {
  return {
    items: (Array.isArray(cart.items) ? cart.items : []).map((it) => {
      const qty = Number(it.quantity ?? it.qty ?? 0) || 0;
      const unit_price = computeUnitPriceWithAddons(it); // sudah incl addons
      return {
        menuId: it.menu || it.menuId || it.id || null,
        name: it.name || null,
        qty,
        price: unit_price,
        category: it.category || null,
        // optional: forward addons raw jika engine butuh detail per-addon
        addons: Array.isArray(it.addons)
          ? it.addons.map((a) => ({
              name: a.name,
              price: Number(a.price || 0),
              qty: Number(a.qty || 1)
            }))
          : []
      };
    })
  };
}

// transform cart -> order.items (pakai unit_price yang sama)
function transformCartToOrderItems(cart) {
  return (Array.isArray(cart.items) ? cart.items : []).map((it) => {
    const unit_price = computeUnitPriceWithAddons(it);
    const qty = Number(it.quantity ?? it.qty ?? 0) || 0;
    return {
      menu: it.menu,
      menu_code: it.menu_code,
      name: it.name,
      imageUrl: it.imageUrl,
      base_price: unit_price, // simpan unit price yang udah include addons
      quantity: qty,
      addons: it.addons || [],
      notes: String(it.notes || '').trim(),
      category: it.category || null,
      line_before_tax: int(unit_price * qty)
    };
  });
}

const short = (arr, n = 3) => (Array.isArray(arr) ? arr.slice(0, n) : arr);

const toWa62 = (phone) => {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let d = s.replace(/\D+/g, '');
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (d.startsWith('+62')) return '62' + d.slice(3);
  return d;
};

const canTransitDelivery = (from, to) => {
  const flow = {
    pending: ['assigned', 'failed'],
    assigned: ['delivered', 'failed'],
    delivered: [],
    failed: []
  };
  return (flow[from] || []).includes(to);
};

/* ================= Utils umum (DRY) ================= */
const asInt = (v, def = 0) => (Number.isFinite(+v) ? +v : def);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const normalizePhone = (phone = '') =>
  String(phone || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(\+62|62|0)/, '0');

const normalizeAddons = (addons = []) =>
  (Array.isArray(addons) ? addons : [])
    .filter((a) => a && a.name)
    .map((a) => ({
      name: String(a.name).trim(),
      price: asInt(a.price, 0),
      qty: clamp(asInt(a.qty ?? 1, 1), 1, 999)
    }));

const makeLineKey = ({ menuId, addons = [], notes = '' }) => {
  const keyAddons = normalizeAddons(addons)
    .sort((a, b) => (a.name + a.price).localeCompare(b.name + b.price))
    .map((a) => `${a.name}:${a.price}x${a.qty}`)
    .join('|');
  const notesPart = String(notes || '').trim();
  return `${menuId}__${keyAddons}__${notesPart}`;
};

const priceFinal = (p = {}) => {
  const original = Number(p?.original || 0);
  const mode = String(p?.discountMode || 'none');
  if (mode === 'percent') {
    const pct = Math.min(100, Math.max(0, Number(p?.discountPercent || 0)));
    return Math.max(0, Math.round(original * (1 - pct / 100)));
  }
  if (mode === 'manual') return Math.max(0, Number(p?.manualPromoPrice || 0));
  return original;
};

const recomputeTotals = (cart) => {
  let totalQty = 0;
  for (const it of cart.items) {
    const addonsTotal = (it.addons || []).reduce(
      (s, a) => s + asInt(a.price) * asInt(a.qty, 1),
      0
    );
    it.line_subtotal =
      (asInt(it.base_price, 0) + addonsTotal) *
      clamp(asInt(it.quantity, 1), 1, 999);
    totalQty += it.quantity;
  }
  cart.total_quantity = totalQty;
  cart.total_items = cart.items.length;
  cart.total_price = cart.items.reduce(
    (s, it) => s + asInt(it.line_subtotal, 0),
    0
  );
  return cart;
};

/* =============== Delivery Fee helper (flat) =============== */
const calcDeliveryFee = () =>
  Number(DELIVERY_FLAT_FEE ?? process.env.DELIVERY_FLAT_FEE ?? 5000);

/* =============== Payment matrix & helpers =============== */
// Resmi: transfer, qris, card, cash
const PM = {
  QRIS: 'qris',
  TRANSFER: 'transfer',
  CASH: 'cash',
  CARD: 'card'
};

function isPaymentMethodAllowed(source, fulfillment, method) {
  // Delivery: non-cash, non-card → hanya qris / transfer
  if (fulfillment === 'delivery') {
    return method === PM.QRIS || method === PM.TRANSFER;
  }

  // Dine-in via QR (self-order di meja)
  if (source === 'qr') {
    // umumnya: qris / transfer / cash (card jarang di sini)
    return [PM.QRIS, PM.TRANSFER, PM.CASH].includes(method);
  }

  // Dine-in via POS
  if (source === 'pos') {
    // kasir bebas pakai semua
    return [PM.QRIS, PM.TRANSFER, PM.CASH, PM.CARD].includes(method);
  }

  // Online dine-in (bukan QR): aman non-cash
  return method === PM.QRIS || method === PM.TRANSFER;
}

function needProof(method) {
  if (!method) return false;
  if (method === PM.TRANSFER) return true;
  if (method === PM.QRIS && QRIS_USE_STATIC && QRIS_REQUIRE_PROOF) return true;
  return false;
}

/* =============== Upload bukti transfer =============== */
async function handleTransferProofIfAny(req, method, opts = {}) {
  if (!needProof(method)) return '';

  const file = req.file;
  if (!file) {
    // pesan disesuaikan supaya FE tahu kenapa gagal
    if (method === PM.TRANSFER) {
      throwError('Bukti transfer wajib diunggah untuk metode transfer', 400);
    } else if (method === PM.QRIS) {
      throwError(
        'Bukti pembayaran QRIS wajib diunggah (screenshot/scan) untuk metode QRIS statis',
        400
      );
    } else {
      throwError('Bukti pembayaran wajib diunggah', 400);
    }
  }

  const mime = (file.mimetype || '').toLowerCase();

  const folderId = getDriveFolder('invoice');

  const tx =
    (opts && opts.transactionCode) ||
    (req.body && req.body.transaction_code) ||
    '';
  let filename;
  if (tx) {
    filename = buildOrderProofFileName(
      tx,
      file.originalname || '',
      file.mimetype || ''
    );
  } else {
    // fallback: prefix + timestamp + random
    const prefix =
      method === PM.TRANSFER ? 'TRF' : method === PM.QRIS ? 'QRIS' : 'PAY';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyyMMdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate()
    )}`;
    const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(
      now.getSeconds()
    )}`;
    const rand = Math.random().toString(36).slice(2, 8);
    // sertakan original extension jika tersedia
    const extMatch = (file.originalname || '')
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/);
    const ext = extMatch
      ? extMatch[1]
      : (file.mimetype || '').split('/').pop() || 'jpg';
    filename = `${prefix}_${yyyyMMdd}_${hhmmss}_${rand}.${ext}`;
  }

  // upload
  let uploaded;
  try {
    uploaded = await uploadBuffer(
      file.buffer,
      filename,
      file.mimetype || 'image/jpeg',
      folderId
    );
  } catch (err) {
    console.error('[handleTransferProofIfAny][uploadBuffer]', err);
    throwError('Gagal menyimpan bukti pembayaran', 500);
  }

  const id = uploaded && (uploaded.id || uploaded.fileId || uploaded._id);
  if (!id) {
    throwError('Gagal menyimpan bukti pembayaran', 500);
  }

  return `https://drive.google.com/uc?export=view&id=${id}`;
}

exports.modeResolver = asyncHandler(async (req, _res, next) => {
  const ft = String(
    req.body?.fulfillment_type || req.query?.fulfillment_type || ''
  ).toLowerCase();
  const headerSrc = String(req.headers['x-order-source'] || '').toLowerCase(); // 'online' | 'qr' | ''
  const querySrc = String(req.query?.source || '').toLowerCase(); // 'online' | 'qr' | ''
  const wantSrc = headerSrc || querySrc; // kalau ada, ini override eksplisit dari FE

  // default
  let source = 'online';
  let mode = 'online';

  // 1) Delivery selalu ONLINE, apapun yang lain
  if (ft === 'delivery') {
    source = 'online';
    mode = 'online';
  } else if (wantSrc === 'online') {
    // 2) FE minta ONLINE eksplisit
    source = 'online';
    mode = 'online';
  } else if (wantSrc === 'qr') {
    // 3) FE minta QR eksplisit
    source = 'qr';
    mode = 'self_order';
  } else {
    // 4) Tidak ada ft delivery dan tidak ada override source
    //    Baru lihat table_number sebagai sinyal QR
    const tnRaw = req.body?.table_number ?? req.query?.table_number;
    const tn = Number(tnRaw);
    if (!Number.isNaN(tn) && tn > 0) {
      source = 'qr';
      mode = 'self_order';
      req.table_number = tn; // simpan hanya bila benar2 QR
    }
  }

  // Session id: cookie lebih prioritas
  const cookieDev = req.cookies?.[DEVICE_COOKIE];
  const headerDev =
    req.get('x-online-session') ||
    req.get('x-qr-session') ||
    req.get('x-device-id') ||
    req.body?.online_session_id ||
    req.body?.session_id ||
    null;

  const sessionHeader = cookieDev || headerDev;

  req.orderMode = mode; // 'online' | 'self_order'
  req.orderSource = source; // 'online' | 'qr'
  req.session_id = sessionHeader ? String(sessionHeader).trim() : null;

  next();
});

/* Ambil identitas caller (member/session) + mode/source */
const getIdentity = (req) => {
  const iden = {
    mode: req.orderMode || null,
    source: req.orderSource || null,
    memberId: null,
    session_id: null,
    table_number: req.table_number || null
  };

  // === session / device id ===
  iden.session_id =
    req.session_id ||
    req.cookies?.[DEVICE_COOKIE] ||
    req.header?.('x-device-id') ||
    req.header?.('session_id') ||
    null;

  // === 1) prioritas: req.member (middleware-auth) ===
  if (req.member && (req.member.id || req.member._id)) {
    iden.memberId = req.member.id || req.member._id;
    return iden;
  }

  // === 2) coba header explicit (x-member-id / memberid) ===
  const hdrMember =
    req.header?.('x-member-id') ||
    req.header?.('memberid') ||
    req.header?.('member-id') ||
    req.header?.('x-user-id') ||
    null;
  if (hdrMember) {
    iden.memberId = String(hdrMember);
    return iden;
  }

  // === 3) coba cookie / authorization token (memberToken / bearer) ===
  const token = req.cookies?.memberToken;

  if (token) {
    try {
      // pastikan SECRET sama dengan saat token dibuat
      const payload = jwt.verify(token, process.env.MEMBER_TOKEN_SECRET || '');
      // toleransi terhadap berbagai nama field
      iden.memberId = payload?.id || payload?._id || payload?.userId || null;

      // optionally attach some quick info
      if (!iden.memberId && payload?.phone) iden.memberPhone = payload.phone;
      if (!iden.memberId && payload?.name) iden.memberName = payload.name;
    } catch (e) {
      // jangan throw; hanya log untuk debugging
      console.warn('[getIdentity] token verify failed:', e?.message || e);
    }
  }

  return iden;
};

const mergeTwoCarts = (dst, src) => {
  for (const it of src.items || []) {
    const key = String(it.line_key);
    const i = dst.items.findIndex((d) => String(d.line_key) === key);
    if (i >= 0) {
      const sum =
        (Number(dst.items[i].quantity) || 0) + (Number(it.quantity) || 0);
      dst.items[i].quantity = Math.max(1, Math.min(999, sum));
    } else {
      dst.items.push(it.toObject ? it.toObject() : { ...it });
    }
  }
  recomputeTotals(dst);
};

const attachOrMergeCartsForIdentity = async (iden) => {
  if (!iden || (!iden.memberId && !iden.session_id)) return;

  // 1) hanya memberId (tidak ada session) -> dedupe multiple member carts
  if (iden.memberId && !iden.session_id) {
    const carts = await Cart.find({
      status: 'active',
      member: iden.memberId
    }).sort({ updatedAt: -1 });
    if (carts.length <= 1) return;
    const primary = carts[0];
    for (let i = 1; i < carts.length; i++) {
      mergeTwoCarts(primary, carts[i]);
      try {
        await carts[i].deleteOne();
      } catch (e) {
        console.error(
          '[attachOrMergeCartsForIdentity] gagal delete member cart',
          carts[i]._id,
          e?.message || e
        );
      }
    }
    primary.member = iden.memberId;
    primary.session_id = null;
    await primary.save();
    return;
  }

  // 2) hanya session_id (guest) -> dedupe multiple session carts
  if (!iden.memberId && iden.session_id) {
    const carts = await Cart.find({
      status: 'active',
      session_id: iden.session_id
    }).sort({ updatedAt: -1 });
    if (carts.length <= 1) return;
    const primary = carts[0];
    for (let i = 1; i < carts.length; i++) {
      mergeTwoCarts(primary, carts[i]);
      try {
        await carts[i].deleteOne();
      } catch (e) {
        console.error(
          '[attachOrMergeCartsForIdentity] gagal delete session cart',
          carts[i]._id,
          e?.message || e
        );
      }
    }
    primary.session_id = iden.session_id;
    await primary.save();
    return;
  }

  // 3) KEDUANYA: memberId + session_id => user baru login:
  //    HAPUS semua cart yang terikat session_id (guest carts) agar tidak tercampur.
  try {
    // hapus semua guest carts terkait session_id
    const sessionCarts = await Cart.find({
      status: 'active',
      session_id: iden.session_id
    }).lean();
    if (sessionCarts && sessionCarts.length) {
      for (const sc of sessionCarts) {
        try {
          await Cart.deleteOne({ _id: sc._id });
        } catch (e) {
          console.error(
            '[attachOrMergeCartsForIdentity] gagal delete guest cart on login',
            sc._id,
            e?.message || e
          );
        }
      }
    }

    // dedupe member carts jika ada >1
    const memberCarts = await Cart.find({
      status: 'active',
      member: iden.memberId
    }).sort({ updatedAt: -1 });
    if (memberCarts.length > 1) {
      const primary = memberCarts[0];
      for (let i = 1; i < memberCarts.length; i++) {
        mergeTwoCarts(primary, memberCarts[i]);
        try {
          await memberCarts[i].deleteOne();
        } catch (e) {
          console.error(
            '[attachOrMergeCartsForIdentity] gagal delete duplicate member cart (both-case)',
            memberCarts[i]._1,
            e?.message || e
          );
        }
      }
      primary.member = iden.memberId;
      primary.session_id = null;
      await primary.save();
    }
  } catch (e) {
    console.error(
      '[attachOrMergeCartsForIdentity] unexpected error',
      e?.message || e
    );
  }
};

const getActiveCartForIdentity = async (
  iden,
  {
    allowCreateOnline = false,
    allowCreate = false,
    defaultFt = null,
    skipAttach = false
  } = {}
) => {
  if (!skipAttach) await attachOrMergeCartsForIdentity(iden);

  const canCreate = allowCreate || allowCreateOnline; // kompatibilitas
  const filter = iden.memberId
    ? { status: 'active', member: iden.memberId }
    : iden.session_id
    ? { status: 'active', session_id: iden.session_id }
    : null;

  if (!filter) return null;

  let cart = await Cart.findOne(filter).sort({ updatedAt: -1 }).lean();
  if (cart) return cart;

  if (!canCreate) return null;

  const sid = iden.memberId ? null : iden.session_id || crypto.randomUUID();
  cart = await Cart.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        member: iden.memberId || null,
        session_id: sid,
        source: iden.source || 'online', // metadata kanal terakhir
        table_number: null,
        fulfillment_type: defaultFt
          ? String(defaultFt).toLowerCase()
          : 'dine_in',
        items: [],
        total_items: 0,
        total_quantity: 0,
        total_price: 0,
        status: 'active'
      }
    },
    { new: true, upsert: true, lean: true }
  );
  return cart;
};

/* =============== Member helper (unified) =============== */
const ensureMemberForCheckout = async (req, res, joinChannel) => {
  let memberDoc = null;
  if (req.member?.id) {
    memberDoc = await Member.findById(req.member.id).lean();
    if (!memberDoc) throwError('Member tidak ditemukan', 404);
  } else {
    const { name, phone } = req.body || {};
    if (!name || !phone) {
      throwError(
        'Checkout membutuhkan akun member. Sertakan name & phone untuk daftar otomatis.',
        401
      );
    }

    const normalizedPhone = normalizePhone(phone);
    let member = await Member.findOne({ phone: normalizedPhone });
    if (!member) {
      member = await Member.create({
        name: String(name).trim(),
        phone: normalizedPhone,
        join_channel: joinChannel, // 'self_order' | 'online' | 'pos'
        visit_count: 1,
        last_visit_at: new Date(),
        is_active: true
      });
      memberDoc = member.toObject ? member.toObject() : member;
    } else {
      if (name && member.name !== name) member.name = String(name).trim();
      member.visit_count += 1;
      member.last_visit_at = new Date();
      if (!member.is_active) member.is_active = true;
      await member.save();
      memberDoc = member.toObject ? member.toObject() : member;
    }
  }

  if (memberDoc && memberDoc.toObject) memberDoc = memberDoc.toObject();

  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

  const accessToken = signAccessToken(memberDoc);
  const refreshToken = generateOpaqueToken();
  const refreshHash = hashToken(refreshToken);

  const now = Date.now();
  const existing = await MemberSession.findOne({
    member: memberDoc._id,
    device_id,
    revoked_at: null,
    expires_at: { $gt: new Date(now) }
  });

  if (existing) {
    existing.refresh_hash = refreshHash;
    existing.expires_at = new Date(now + REFRESH_TTL_MS);
    existing.user_agent = req.get('user-agent') || existing.user_agent || '';
    existing.ip = req.ip || existing.ip || '';
    await existing.save();
  } else {
    await MemberSession.create({
      member: memberDoc._id,
      device_id,
      refresh_hash: refreshHash,
      user_agent: req.get('user-agent') || '',
      ip: req.ip,
      expires_at: new Date(now + REFRESH_TTL_MS)
    });
  }

  try {
    const old = await MemberSession.find({ member: memberDoc._id, device_id })
      .sort({ createdAt: -1 })
      .skip(3)
      .select('_id')
      .lean();
    if (old?.length) {
      await MemberSession.deleteMany({ _id: { $in: old.map((x) => x._id) } });
    }
  } catch (_) {}

  res.cookie(ACCESS_COOKIE, accessToken, cookieAccess);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieRefresh);
  res.cookie(DEVICE_COOKIE, device_id, cookieDevice);

  const session_id =
    req.session_id ||
    req.cookies?.[DEVICE_COOKIE] ||
    req.header('x-device-id') ||
    null;

  try {
    const iden = { memberId: memberDoc._id, session_id };
    await attachOrMergeCartsForIdentity(iden);
  } catch (_) {}

  return memberDoc;
};

exports.getCart = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);

  /* ========== 0) Baca FT & delivery_mode dari query ========== */
  const hasFtQuery = Object.prototype.hasOwnProperty.call(
    req.query || {},
    'fulfillment_type'
  );
  const qFtRaw = String(req.query?.fulfillment_type || '')
    .toLowerCase()
    .trim();
  const qFt =
    qFtRaw === 'delivery'
      ? 'delivery'
      : qFtRaw === 'dine_in'
      ? 'dine_in'
      : null;

  const hasDeliveryModeQuery = Object.prototype.hasOwnProperty.call(
    req.query || {},
    'delivery_mode'
  );
  const qDeliveryModeRaw = String(req.query?.delivery_mode || '')
    .toLowerCase()
    .trim();
  const qDeliveryMode =
    qDeliveryModeRaw === 'delivery'
      ? 'delivery'
      : qDeliveryModeRaw === 'pickup'
      ? 'pickup'
      : qDeliveryModeRaw === 'none'
      ? 'none'
      : null;

  /* ========== 1) Ambil / auto-create cart aktif ========== */
  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreate: true,
    defaultFt: hasFtQuery ? qFt : null,
    skipAttach: true
  });

  if (!cartObj) {
    const empty = {
      items_subtotal: 0,
      service_fee: 0,
      items_discount: 0,
      delivery_fee:
        hasFtQuery && qFt === 'delivery'
          ? Number(process.env.DELIVERY_FLAT_FEE || 0) || 0
          : 0,
      shipping_discount: 0,
      tax_rate_percent: 11,
      tax_amount: 0,
      rounding_delta: 0,
      grand_total: 0,
      grand_total_with_delivery: 0
    };
    return res.status(200).json({ cart: null, ui_totals: empty });
  }

  /* ========== 2) Update fulfillment_type jika query ada ========== */
  if (hasFtQuery && qFt && cartObj.fulfillment_type !== qFt) {
    try {
      await Cart.findByIdAndUpdate(cartObj._id, {
        $set: { fulfillment_type: qFt }
      });
    } catch (e) {
      console.error('[getCart] failed set fulfillment_type:', e?.message || e);
    }
  }

  /* ========== 3) Jika ada delivery_mode in query -> simpan ke delivery_draft (doc.save) ========== */
  if (hasDeliveryModeQuery && qDeliveryMode) {
    try {
      const ENV_DELIV = Number(process.env.DELIVERY_FLAT_FEE || 0) || 0;

      const doc = await Cart.findById(cartObj._id);
      if (!doc) {
        throwError(`Cart not found for id ${String(cartObj._id)}`, 404);
      }

      const existingDraft =
        doc.delivery_draft && typeof doc.delivery_draft === 'object'
          ? { ...doc.delivery_draft }
          : {};

      // set sesuai query
      if (qDeliveryMode === 'delivery') {
        existingDraft.mode = 'delivery';
        // jika sebelumnya sudah ada delivery_fee > 0, pertahankan; else pakai ENV
        const cur = Number(existingDraft.delivery_fee ?? 0);
        existingDraft.delivery_fee = cur > 0 ? cur : ENV_DELIV;
        // optional: set fulfillment_type juga supaya charge ongkir terjadi
        doc.fulfillment_type = 'delivery';
      } else if (qDeliveryMode === 'pickup') {
        existingDraft.mode = 'pickup';
        if (
          Object.prototype.hasOwnProperty.call(existingDraft, 'delivery_fee')
        ) {
          delete existingDraft.delivery_fee;
        }
      } else if (qDeliveryMode === 'none') {
        existingDraft.mode = 'none';
        if (
          Object.prototype.hasOwnProperty.call(existingDraft, 'delivery_fee')
        ) {
          delete existingDraft.delivery_fee;
        }
      }

      doc.delivery_draft = existingDraft;

      try {
        await doc.save();
      } catch (saveErr) {
        throwError(
          `Failed to persist delivery_mode for cart ${String(cartObj._id)}: ${
            saveErr?.message || saveErr
          }`,
          500
        );
      }
    } catch (err) {
      // err bisa berasal dari throwError di atas atau error lain — re-throw supaya masuk ke global error handler
      // Jika err sudah objek yg dihasilkan throwError (mis. punya statusCode), re-throw langsung
      throw err;
    }
  }

  /* ========== 4) Ambil cart terbaru & normalisasi delivery dari delivery_draft ========== */
  const cart = await Cart.findById(cartObj._id)
    .select(
      'items total_items total_quantity total_price delivery_draft updatedAt fulfillment_type table_number status member session_id source items'
    )
    .lean();

  // normalisasi supaya kode lain pakai cart.delivery
  cart.delivery = cart.delivery_draft || undefined;

  /* ========== 5) Hitung UI totals: tanpa delivery dan dengan delivery final ========== */
  const ENV_DELIV = Number(process.env.DELIVERY_FLAT_FEE || 0) || 0;
  const cartDeliveryMode = (cart?.delivery?.mode || '').toLowerCase() || null;

  // totals tanpa mempertimbangkan delivery (FE mungkin butuh ini)
  const ui_no_delivery = buildUiTotalsFromCart(cart, {
    deliveryMode: null, // paksa tanpa ongkir
    envDeliveryFee: ENV_DELIV
  });

  // totals final sesuai mode/engine (ini yang dipakai FE untuk tampil)
  const ui_with_delivery = buildUiTotalsFromCart(cart, {
    deliveryMode: cartDeliveryMode,
    envDeliveryFee: ENV_DELIV
  });

  // kalau kamu ingin memastikan struktur, kita bisa masukkan kedua variant ke response
  const ui = {
    ...ui_with_delivery,
    // tambahkan field helper
    items_subtotal_after_discount:
      ui_no_delivery.items_subtotal_after_discount ??
      ui_with_delivery.items_subtotal_after_discount,
    items_subtotal: ui_with_delivery.items_subtotal
  };

  // sediakan both values agar FE bisa bandingkan
  ui.grand_total_without_delivery = ui_no_delivery.grand_total;
  ui.grand_total_with_delivery = ui_with_delivery.grand_total;

  /* ========== 6) Response ========== */
  const items = Array.isArray(cart.items) ? cart.items : [];

  return res.status(200).json({
    ...cart,
    fulfillment_type: cart.fulfillment_type || 'dine_in',
    delivery_mode: cartDeliveryMode,
    items,
    ui_totals: ui
  });
});

exports.addItem = asyncHandler(async (req, res) => {
  const { menu_id, quantity = 1, addons = [], notes = '' } = req.body || {};
  if (!menu_id) throwError('menu_id wajib', 400);

  // Identitas awal dari modeResolver
  const iden0 = getIdentity(req);

  // SAFETY NET: kalau body/query bilang delivery, paksa laci ONLINE
  const ftIncoming = String(
    req.body?.fulfillment_type || req.query?.fulfillment_type || ''
  ).toLowerCase();

  const desiredSource =
    ftIncoming === 'delivery' ? 'online' : iden0.source || 'online';

  // Pakai identitas dengan source final yang sudah “dipaksa” kalau perlu
  const iden = { ...iden0, source: desiredSource };

  // Ambil menu
  const menu = await Menu.findById(menu_id).lean();
  if (!menu || !menu.isActive)
    throwError('Menu tidak ditemukan / tidak aktif', 404);

  // Boleh create cart baru hanya kalau source = online
  const allowCreateOnline = desiredSource !== 'qr';
  let cart = await getActiveCartForIdentity(iden, {
    allowCreateOnline,
    defaultFt: req.query?.fulfillment_type || req.body?.fulfillment_type || null
  });

  // Guard khusus QR: harus sudah ada nomor meja
  if (desiredSource === 'qr' && !cart.table_number) {
    throwError('Nomor meja belum di-assign.', 400);
  }

  // (Opsional) Guard tambahan: kalau delivery tapi kebetulan cart yang didapat QR, tolak
  if (ftIncoming === 'delivery' && cart.source === 'qr') {
    throwError('Context tidak sesuai: delivery harus memakai cart online', 409);
  }

  // Siapkan item
  const qty = clamp(asInt(quantity, 1), 1, 999);
  const normAddons = normalizeAddons(addons);
  const line_key = makeLineKey({ menuId: menu._id, addons: normAddons, notes });

  // Pastikan kita pegang dokumen Mongoose hidup (bukan plain object)
  if (!cart.save) {
    cart = await Cart.findById(cart._id);
  }

  // Upsert line
  const idx = cart.items.findIndex((it) => it.line_key === line_key);
  if (idx >= 0) {
    cart.items[idx].quantity = clamp(cart.items[idx].quantity + qty, 1, 999);
  } else {
    const unit = priceFinal(menu.price);
    cart.items.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: unit,
      quantity: qty,
      addons: normAddons,
      notes: String(notes || '').trim(),
      line_key,
      category: {
        big: menu.bigCategory || null,
        subId: menu.subcategory || null
      }
    });
  }

  // Recompute & simpan
  recomputeTotals(cart);
  await cart.save();

  res.status(200).json(cart.toObject());
});

exports.updateItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params; // bisa _id atau line_key
  const { quantity, addons, notes } = req.body || {};
  const iden = getIdentity(req);

  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreateOnline: false
  });
  if (!cartObj) {
    throwError('Cart tidak ditemukan', 404);
  }

  const cart = await Cart.findById(cartObj._id);
  if (!cart) {
    throwError('Cart tidak ditemukan', 404);
  }

  const ref = String(itemId || '').trim();
  if (!ref) {
    throwError('Parameter itemId kosong', 400);
  }

  let idx = cart.items.findIndex(
    (it) => String(it._id) === ref || String(it.line_key) === ref
  );

  // Fallback diagnosis kalau tidak ketemu
  if (idx < 0) {
    if (cart.items.length === 0) {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const otherCartQuery = {
        _id: { $ne: cart._id },
        'items._id': ref,
        updatedAt: { $gte: dayAgo }
      };
      const other = await Cart.findOne(otherCartQuery)
        .select('_id fulfillment_type status updatedAt')
        .lean();
      if (other) {
        return res.status(409).json({
          error: 'WRONG_CART',
          message: 'Item berada di cart yang berbeda. Muat ulang cart aktif.',
          data: {
            currentCartId: String(cart._id),
            otherCartId: String(other._id),
            otherMeta: {
              fulfillment_type: other.fulfillment_type || null,
              status: other.status || null,
              updatedAt: other.updatedAt
            }
          }
        });
      }
    }

    throwError('Item tidak ditemukan di cart', 404);
  }

  // ================== Update field ==================
  if (quantity !== undefined) {
    const q = clamp(asInt(quantity, 0), 0, 999);
    if (q === 0) {
      cart.items.splice(idx, 1);
      recomputeTotals(cart);
      await cart.save();
      return res.status(200).json(cart.toObject());
    } else {
      cart.items[idx].quantity = q;
    }
  }

  if (cart.items[idx]) {
    if (addons !== undefined) {
      const normalized = normalizeAddons(addons);
      cart.items[idx].addons = normalized;
    }
    if (notes !== undefined) {
      cart.items[idx].notes = String(notes || '').trim();
    }

    // Rebuild & merge jika perlu
    const beforeKey = cart.items[idx].line_key;
    cart.items[idx].line_key = makeLineKey({
      menuId: cart.items[idx].menu,
      addons: cart.items[idx].addons,
      notes: cart.items[idx].notes
    });
    const newKey = cart.items[idx].line_key;

    if (newKey !== beforeKey) {
      const dupIdx = cart.items.findIndex(
        (it, i) => i !== idx && String(it.line_key) === String(newKey)
      );
      if (dupIdx >= 0) {
        const qtyA = cart.items[dupIdx].quantity || 0;
        const qtyB = cart.items[idx].quantity || 0;
        const merged = clamp(asInt(qtyA + qtyB, 0), 0, 999);

        cart.items[dupIdx].quantity = merged;
        cart.items.splice(idx, 1);
      }
    }
  }

  recomputeTotals(cart);
  await cart.save();

  res.status(200).json(cart.toObject());
});

exports.removeItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const iden = getIdentity(req);

  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreateOnline: false
  });
  if (!cartObj) throwError('Cart tidak ditemukan', 404);

  const cart = await Cart.findById(cartObj._id);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  const ref = String(itemId || '').trim();
  if (!ref) throwError('Parameter itemId kosong', 400);

  const before = cart.items.length;

  // 1) Coba hapus by _id terlebih dulu (paling presisi)
  let idx = cart.items.findIndex((it) => String(it._id) === ref);
  if (idx >= 0) {
    cart.items.splice(idx, 1);
  } else {
    // 2) Fallback: hapus semua item dengan line_key yang sama
    cart.items = cart.items.filter((it) => String(it.line_key) !== ref);
  }

  if (cart.items.length === before) {
    throwError('Item tidak ditemukan di cart', 404);
  }

  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

exports.clearCart = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreateOnline: false
  });
  if (!cartObj) throwError('Cart tidak ditemukan', 404);
  const cart = await Cart.findById(cartObj._id);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  cart.items = [];
  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

// PATCH /cart/fulfillment-type  { fulfillment_type: 'dine_in'|'delivery', table_number?, delivery_draft? }
exports.setFulfillmentType = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const ft = String(req.body?.fulfillment_type || '').toLowerCase();
  if (!['dine_in', 'delivery'].includes(ft))
    throwError('fulfillment_type tidak valid', 400);

  const filter = iden.memberId
    ? { status: 'active', member: iden.memberId }
    : { status: 'active', session_id: iden.session_id };

  const cart = await Cart.findOne(filter);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  // simpan metadata kanal terakhir (opsional)
  if (iden.source) cart.source = iden.source;

  if (ft === 'delivery') {
    // Pindah ke delivery → simpan nomor meja terakhir biar bisa auto-restore
    if (cart.table_number) {
      cart.dine_in_cache = cart.dine_in_cache || {};
      cart.dine_in_cache.last_table_number = cart.table_number;
    }
    cart.table_number = null;
    cart.fulfillment_type = 'delivery';

    // simpan draft delivery bila ada
    if (req.body?.delivery_draft) {
      const ENV_DELIV = Number(process.env.DELIVERY_FLAT_FEE || 0) || 0;

      // normalisasi draft yang masuk
      const draftIn = req.body.delivery_draft;
      const newDraft = {
        address_text: String(draftIn.address_text || ''),
        location: draftIn.location || null,
        note_to_rider: String(draftIn.note_to_rider || '')
      };

      // kalau draftIn menyertakan mode, gunakan; else default ke 'delivery'
      const draftMode =
        typeof draftIn.mode === 'string'
          ? String(draftIn.mode).toLowerCase()
          : 'delivery';

      newDraft.mode =
        draftMode === 'pickup'
          ? 'pickup'
          : draftMode === 'none'
          ? 'none'
          : 'delivery';

      // set delivery_fee only when draft mode === 'delivery'
      if (newDraft.mode === 'delivery') {
        const cur = Number(draftIn.delivery_fee ?? 0);
        newDraft.delivery_fee = cur > 0 ? cur : ENV_DELIV;
      } else {
      }

      cart.delivery_draft = newDraft;
    }
  } else {
    // Balik ke dine_in → pakai nomor meja dari body ATAU cache
    const incomingTable = Number(req.body?.table_number) || 0;
    let finalTable =
      incomingTable ||
      cart.table_number || // (kalau kebetulan sudah ada)
      cart.dine_in_cache?.last_table_number ||
      0;

    // Jika self-order QR, wajib punya nomor meja
    if ((iden.source || 'online') === 'qr' && !finalTable) {
      throwError('Nomor meja wajib untuk dine_in (QR).', 400);
    }

    // Set konteks dine-in
    cart.fulfillment_type = 'dine_in';
    cart.table_number = finalTable || null;
    cart.delivery_draft = undefined;

    // Update cache kalau body kirim nomor baru
    if (incomingTable) {
      cart.dine_in_cache = cart.dine_in_cache || {};
      cart.dine_in_cache.last_table_number = incomingTable;
    }
  }

  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

/* ===================== DELIVERY ESTIMATE ===================== */
exports.estimateDelivery = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const ft = req.body?.fulfillment_type || req.query?.fulfillment_type;

  if (String(ft) !== 'delivery' && iden.mode !== 'online') {
    return res.status(200).json({
      distance_km: null,
      delivery_fee: 0,
      within_radius: true,
      max_radius_km: Number(DELIVERY_MAX_RADIUS_KM || 0)
    });
  }

  const lat = Number(req.query.lat ?? req.body?.lat);
  const lng = Number(req.query.lng ?? req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throwError('lat & lng wajib untuk delivery', 400);
  }

  const distance_km = haversineKm(CAFE_COORD, { lat, lng });
  const within_radius =
    distance_km <= Number(DELIVERY_MAX_RADIUS_KM || 0) + 1e-9;

  const delivery_fee = within_radius ? calcDeliveryFee() : null;

  res.status(200).json({
    distance_km: Number(distance_km.toFixed(2)),
    delivery_fee,
    within_radius,
    max_radius_km: Number(DELIVERY_MAX_RADIUS_KM || 0)
  });
});

exports.checkout = asyncHandler(async (req, res) => {
  const {
    name,
    phone,
    fulfillment_type,
    payment_method,
    idempotency_key,
    register_decision = 'register',
    usePoints = false
  } = req.body || {};

  let guestToken =
    (req.body && String(req.body.guestToken || '').trim()) ||
    (req.headers && String(req.headers['x-guest-token'] || '').trim()) ||
    (req.cookies && String(req.cookies.guestToken || '').trim()) ||
    null;

  if (guestToken === '') guestToken = null;
  console.log('[checkout.debug] incoming raw body snippet (top):', {
    bodyKeys: Object.keys(req.body || {}).slice(0, 20),
    voucherClaimIds_raw:
      req.body?.voucherClaimIds ??
      req.body?.voucher?.chosenClaimIds ??
      req.body?.voucher?.chosen_claim_ids ??
      req.body?.voucher_claim_ids ??
      req.body?.voucher_claim_id ??
      null,
    xGuestToken: req.headers?.['x-guest-token'] || null,
    cookieGuestToken: req.cookies?.guestToken || null
  });
  // --- normalize voucherClaimIds (support multiple FE shapes) ---
  // taruh di sini: setelah guestToken resolved & sebelum log incoming body snippet
  let voucherClaimIds = [];

  // prefer explicit camelCase array
  if (
    Array.isArray(req.body?.voucherClaimIds) &&
    req.body.voucherClaimIds.length
  ) {
    voucherClaimIds = req.body.voucherClaimIds;
  } else if (
    Array.isArray(req.body?.voucher?.chosenClaimIds) &&
    req.body?.voucher?.chosenClaimIds.length
  ) {
    voucherClaimIds = req.body.voucher.chosenClaimIds;
  } else if (
    Array.isArray(req.body?.voucher?.chosen_claim_ids) &&
    req.body?.voucher?.chosen_claim_ids.length
  ) {
    voucherClaimIds = req.body.voucher.chosen_claim_ids;
  } else if (
    Array.isArray(req.body?.voucher_claim_ids) &&
    req.body?.voucher_claim_ids.length
  ) {
    voucherClaimIds = req.body.voucher_claim_ids;
  } else if (
    typeof req.body?.voucher_claim_id !== 'undefined' &&
    req.body.voucher_claim_id
  ) {
    voucherClaimIds = [req.body.voucher_claim_id];
  }

  // --- defensive: accept stringified JSON or comma-separated strings from FE ---
  // contoh FE bad-shape: voucherClaimIds: '["6935b582b10efc0ff7bd1d84"]' atau '6935b582b10efc0ff7bd1d84'
  if (!Array.isArray(voucherClaimIds)) {
    // collect candidate raw values FE might have sent (prefer the top-level one first)
    const rawCandidates = [
      req.body?.voucherClaimIds,
      req.body?.voucher_claim_ids,
      req.body?.voucher?.chosenClaimIds,
      req.body?.voucher?.chosen_claim_ids,
      req.body?.voucher_claim_id
    ].filter(Boolean);

    if (rawCandidates.length === 1 && typeof rawCandidates[0] === 'string') {
      const raw = String(rawCandidates[0]).trim();
      try {
        // try parse JSON (e.g. '["id1","id2"]')
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          voucherClaimIds = parsed;
          console.log(
            '[checkout.debug] parsed voucherClaimIds from JSON-string:',
            voucherClaimIds
          );
        } else if (typeof parsed === 'string' && parsed) {
          voucherClaimIds = [parsed];
          console.log(
            '[checkout.debug] parsed single voucherClaimId from JSON-string:',
            voucherClaimIds
          );
        }
      } catch (e) {
        // fallback: accept comma-separated string or single id string
        const maybe = raw
          .replace(/^\[|\]$/g, '') // strip surrounding brackets if any
          .split(',')
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        if (maybe.length) {
          voucherClaimIds = maybe;
          console.log(
            '[checkout.debug] parsed voucherClaimIds from comma/string:',
            voucherClaimIds
          );
        }
      }
    }
  }

  // coerce to string, remove falsy
  voucherClaimIds = (Array.isArray(voucherClaimIds) ? voucherClaimIds : [])
    .filter(Boolean)
    .map((v) => String(v));

  console.log('[voucher] normalizedClaimIds:', voucherClaimIds);

  console.log('[checkout] incoming body snippet', {
    fulfillment_type,
    payment_method,
    voucherClaimIds_length: Array.isArray(voucherClaimIds)
      ? voucherClaimIds.length
      : 0,
    register_decision
  });

  const iden0 = getIdentity(req);

  const ft =
    iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
  if (!['dine_in', 'delivery'].includes(ft)) {
    console.error('[checkout] invalid fulfillment_type', ft);
    throwError('fulfillment_type tidak valid', 400);
  }

  const method = String(payment_method || '').toLowerCase();

  const originallyLoggedIn = !!iden0.memberId;
  const wantRegister = String(register_decision || 'register') === 'register';
  let MemberDoc = null;
  let customer_name = '';
  let customer_phone = '';

  try {
    if (originallyLoggedIn || wantRegister) {
      const joinChannel = iden0.mode === 'self_order' ? 'self_order' : 'online';
      MemberDoc = await ensureMemberForCheckout(req, res, joinChannel);
    } else {
      customer_name = String(name || '').trim();
      const rawPhone = String(phone || '').trim();
      if (!customer_name && !rawPhone) {
        console.error('[checkout] missing name & phone for guest');
        throwError('Tanpa member: isi minimal nama atau no. telp', 400);
      }
      if (rawPhone) {
        const digits = rawPhone.replace(/\D+/g, '');
        if (!digits) {
          console.error('[checkout] invalid phone format', rawPhone);
          throwError('Nomor telepon harus berupa angka', 400);
        }
        customer_phone = normalizePhone(rawPhone);
      } else {
        customer_phone = '';
      }
    }
  } catch (e) {
    console.error('[checkout] ensureMemberForCheckout failed', e?.message || e);
    throw e;
  }

  if (method === 'points') {
    if (!MemberDoc) {
      console.error('[checkout] payment_method=points attempted by guest');
      throwError('Pembayaran dengan poin hanya untuk member terdaftar', 400);
    }
  } else {
    if (!isPaymentMethodAllowed(iden0.source || 'online', ft, method)) {
      console.error('[checkout] payment method not allowed', {
        method,
        source: iden0.source,
        ft
      });
      throwError('Metode pembayaran tidak diizinkan untuk mode ini', 400);
    }
  }

  if (usePoints && !MemberDoc) {
    console.error('[checkout] guest attempted to use points');
    throwError('Poin hanya dapat digunakan oleh member terdaftar', 400);
  }

  const iden = {
    ...iden0,
    memberId: MemberDoc?._id || iden0.memberId || null,
    session_id:
      iden0.session_id ||
      req.cookies?.[DEVICE_COOKIE] ||
      req.header('x-device-id') ||
      null
  };

  // --- ambil cart aktif ---
  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreateOnline: false
  });
  if (!cartObj) {
    console.error('[checkout] cartObj not found for identity', iden);
    throwError('Cart tidak ditemukan / kosong', 404);
  }
  const cart = await Cart.findById(cartObj._1 || cartObj._id);
  if (!cart) {
    console.error('[checkout] cart actual doc not found', cartObj);
    throwError('Cart tidak ditemukan / kosong', 404);
  }
  if (!cart.items?.length) {
    console.error('[checkout] cart empty', { cartId: cart._id });
    throwError('Cart kosong', 400);
  }

  // --- delivery / slot / pickup handling ---
  const delivery_mode =
    ft === 'dine_in'
      ? 'none'
      : String(req.body?.delivery_mode || 'delivery').toLowerCase();

  const providedSlot = (req.body?.delivery_slot || '').trim();
  const providedScheduledAtRaw = req.body?.scheduled_at || null;
  const providedScheduledAt = providedScheduledAtRaw
    ? dayjs(providedScheduledAtRaw).tz(LOCAL_TZ)
    : null;

  let slotLabel = null;
  let slotDt = null;
  if (
    delivery_mode === 'delivery' &&
    providedScheduledAt &&
    providedScheduledAt.isValid()
  ) {
    slotDt = providedScheduledAt.startOf('minute');
    slotLabel = slotDt.format('HH:mm');
  } else if (delivery_mode === 'delivery' && providedSlot) {
    const maybeDt = parseSlotLabelToDate(providedSlot);
    if (!maybeDt || !maybeDt.isValid()) {
      console.error('[checkout] invalid delivery slot', providedSlot);
      throwError('delivery_slot tidak valid', 400);
    }
    slotDt = maybeDt;
    slotLabel = providedSlot;
  }

  if (
    slotLabel &&
    ft !== 'dine_in' &&
    delivery_mode === 'delivery' &&
    !isSlotAvailable(slotLabel, null, delivery_mode)
  ) {
    console.error('[checkout] slot not available', slotLabel);
    throwError('Slot sudah tidak tersedia / sudah lewat', 409);
  }

  let deliveryObj = {
    mode: ft === 'dine_in' ? 'none' : delivery_mode,
    slot_label: slotLabel || null,
    scheduled_at: slotDt ? slotDt.toDate() : null,
    status: 'pending'
  };

  // PICKUP window handling
  const pickupFromRaw =
    req.body?.pickup_from || req.body?.pickupWindow?.from || null;
  const pickupToRaw = req.body?.pickup_to || req.body?.pickupWindow?.to || null;

  if (delivery_mode === 'pickup') {
    deliveryObj.mode = 'pickup';
    deliveryObj.status = 'pending';
    if (pickupFromRaw) {
      const pf = dayjs(pickupFromRaw).tz(LOCAL_TZ);
      if (!pf.isValid()) {
        console.error('[checkout] invalid pickup_from', pickupFromRaw);
        throwError('pickup_from tidak valid', 400);
      }
      deliveryObj.pickup_window = deliveryObj.pickup_window || {};
      deliveryObj.pickup_window.from = pf.toDate();
    }
    if (pickupToRaw) {
      const pt = dayjs(pickupToRaw).tz(LOCAL_TZ);
      if (!pt.isValid()) {
        console.error('[checkout] invalid pickup_to', pickupToRaw);
        throwError('pickup_to tidak valid', 400);
      }
      deliveryObj.pickup_window = deliveryObj.pickup_window || {};
      deliveryObj.pickup_window.to = pt.toDate();
    }
    if (providedSlot) deliveryObj.slot_label = slotLabel || providedSlot;
    if (slotDt) deliveryObj.scheduled_at = slotDt.toDate();
  }

  if (delivery_mode === 'delivery' && ft !== 'dine_in') {
    const latN = Number(req.body?.lat);
    const lngN = Number(req.body?.lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
      console.error('[checkout] missing lat/lng for delivery');
      throwError('Lokasi (lat,lng) wajib untuk delivery', 400);
    }
    const distance_km = haversineKm(CAFE_COORD, { lat: latN, lng: lngN });
    if (distance_km > Number(DELIVERY_MAX_RADIUS_KM || 0)) {
      console.error('[checkout] outside delivery radius', { distance_km });
      throwError(`Di luar radius ${DELIVERY_MAX_RADIUS_KM} km`);
    }
    deliveryObj.address_text = String(req.body?.address_text || '').trim();
    deliveryObj.location = { lat: latN, lng: lngN };
    deliveryObj.distance_km = Number(distance_km.toFixed(2));
    const localDeliveryCalc = calcDeliveryFee();
    deliveryObj.delivery_fee = localDeliveryCalc;
    deliveryObj.delivery_fee_raw = localDeliveryCalc;
  } else {
    deliveryObj.note_to_rider = String(req.body?.note_to_rider || '');
  }

  // --- normalisasi item dan simpan cart totals ---
  cart.items = (Array.isArray(cart.items) ? cart.items : [])
    .filter(Boolean)
    .map((it) => {
      const rawAddons = Array.isArray(it.addons) ? it.addons : [];
      const safeAddons = rawAddons
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({
          name: String(a.name || '').trim(),
          price: int(a.price || 0),
          qty: clamp(int(a.qty || 1), 1, 999),
          ...(typeof a.isActive === 'boolean' ? { isActive: !!a.isActive } : {})
        }));
      return {
        ...it,
        addons: safeAddons,
        notes: String(it.notes || '').trim()
      };
    });

  try {
    recomputeTotals(cart);
    await cart.save();
  } catch (err) {
    throwError(
      err?.message
        ? `Gagal menyimpan cart: ${String(err.message)}`
        : 'Gagal menyimpan cart',
      err?.status || 500
    );
  }

  // --- VOUCHER filtering (robust fallback + diagnostics) ---
  let eligibleClaimIds = [];

  if (MemberDoc) {
    try {
      console.log(
        '[checkout][voucher-check] incoming voucherClaimIds (raw):',
        voucherClaimIds
      );
      console.log(
        '[checkout][voucher-check] types:',
        voucherClaimIds?.map?.((v) => typeof v)
      );

      if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
        // ambil semua doc sesuai id yg diminta (no filters) -> buat diagnosa + fallback
        const rawById = await VoucherClaim.find({
          _id: { $in: voucherClaimIds }
        })
          .lean()
          .catch((e) => {
            console.error(
              '[checkout][voucher-check] find rawById error',
              e?.message || e
            );
            return [];
          });

        console.log('[checkout][voucher-check] rawById count:', rawById.length);
        rawById.forEach((d) => {
          console.log('[checkout][voucher-check][rawDoc]', {
            id: String(d._id),
            member: String(d.member || null),
            status: d.status || null,
            remainingUse: d.remainingUse ?? null,
            validUntil: d.validUntil || null,
            voucher: String(d.voucher || null),
            createdAt: d.createdAt || null
          });
        });
        console.log('[voucher] rawById:', rawById.length);

        // Build eligibleClaimIds dari rawById (manual checks)
        const now = new Date();
        eligibleClaimIds = (rawById || [])
          .filter((d) => {
            const memberMatch =
              String(d.member || '') === String(MemberDoc._id || '');
            const statusOk = d.status === 'claimed';
            const notExpired = !d.validUntil || new Date(d.validUntil) > now;
            if (!memberMatch || !statusOk || !notExpired) {
              console.log('[checkout][voucher-check][rawDoc-rejected]', {
                id: String(d._id),
                memberMatch,
                status: d.status,
                statusOk,
                validUntil: d.validUntil || null,
                notExpired
              });
            }
            return memberMatch && statusOk && notExpired;
          })
          .map((d) => String(d._id));

        console.log('[voucher] eligibleClaimIds:', eligibleClaimIds);

        console.log(
          '[checkout.debug] normalized voucherClaimIds (to-server):',
          voucherClaimIds
        );

        // Optional: compare with query-by-filter (for diagnosis)
        try {
          const rawClaimsQuery = await VoucherClaim.find({
            _id: { $in: voucherClaimIds },
            member: MemberDoc._id,
            status: 'claimed'
          }).lean();
          console.log(
            '[checkout][voucher-check] rawClaimsQuery count (member+status):',
            rawClaimsQuery.length
          );
        } catch (e) {
          console.error(
            '[checkout][voucher-check] rawClaimsQuery error',
            e?.message || e
          );
        }

        // If FE requested but none eligible -> fail-fast with friendly message
        if (
          Array.isArray(voucherClaimIds) &&
          voucherClaimIds.length &&
          eligibleClaimIds.length === 0
        ) {
          console.error(
            '[checkout][voucher-check][FAIL] requested vouchers not eligible. requested:',
            voucherClaimIds
          );
          throwError(
            'Voucher tidak valid/expired/atau bukan milik member ini. Silakan periksa wallet Anda atau refresh halaman.',
            400
          );
        }
      }
    } catch (e) {
      console.error('[checkout][voucher-check][fatal]', e?.message || e);
      throwError('Kesalahan saat memvalidasi voucher', 500);
    }
  } else if (voucherClaimIds?.length) {
    console.error('[checkout] non-member tried to use vouchers', {
      voucherClaimIds
    });
    throwError('Voucher hanya untuk member. Silakan daftar/login.', 400);
  }

  // DEBUG: log incoming voucher ids & eligible ids
  console.log('[checkout] incoming voucherClaimIds:', voucherClaimIds);
  console.log('[checkout] eligibleClaimIds after filter:', eligibleClaimIds);

  // --- PANGGIL price engine (sumber kebenaran) ---
  const normalizedForEngine = {
    items: (cart.items || []).map((it) => {
      const menuBase = Number(it.base_price ?? it.unit_price ?? it.price ?? 0);
      const addons = Array.isArray(it.addons) ? it.addons : [];
      const addonsPerUnit = addons.reduce(
        (s, a) => s + Number(a?.price || 0) * Math.max(1, Number(a?.qty || 1)),
        0
      );
      const unit_price = Math.round(menuBase + addonsPerUnit);
      return {
        base_price: menuBase,
        unit_price: unit_price,
        price: unit_price,
        quantity: Number(it.quantity ?? it.qty ?? 0),
        qty: Number(it.quantity ?? it.qty ?? 0),
        menuId: it.menu || it.menuId || it.id || null,
        name: it.name || null,
        category: it.category || null
      };
    })
  };

  // promo usage fetchers (sama seperti preview)
  const promoUsageFetchers = {
    getMemberUsageCount: async (promoId, memberId, sinceDate) => {
      try {
        if (!memberId) return 0;
        if (MemberDoc && Array.isArray(MemberDoc.promoUsageHistory)) {
          return MemberDoc.promoUsageHistory.filter(
            (h) =>
              String(h.promoId) === String(promoId) &&
              new Date(h.usedAt || h.date) >= sinceDate
          ).length;
        }
        const q = {
          'appliedPromo.promoId': promoId,
          member: memberId,
          createdAt: { $gte: sinceDate }
        };
        return await Order.countDocuments(q);
      } catch (e) {
        console.warn('[checkout] getMemberUsageCount failed', e?.message || e);
        return 0;
      }
    },
    getGlobalUsageCount: async (promoId, sinceDate) => {
      try {
        const q = {
          'appliedPromo.promoId': promoId,
          createdAt: { $gte: sinceDate }
        };
        return await Order.countDocuments(q);
      } catch (e) {
        console.warn('[checkout] getGlobalUsageCount failed', e?.message || e);
        return 0;
      }
    }
  };

  let eligiblePromosList = [];
  try {
    eligiblePromosList = await findApplicablePromos(
      normalizedForEngine,
      MemberDoc,
      new Date(),
      { fetchers: promoUsageFetchers }
    );
  } catch (e) {
    console.warn('[checkout] findApplicablePromos failed', e?.message || e);
    eligiblePromosList = [];
  }

  let autoAppliedPromo = null;
  try {
    if (Array.isArray(eligiblePromosList) && eligiblePromosList.length) {
      const autos = eligiblePromosList.filter((p) => !!p.autoApply);
      if (autos.length) {
        autos.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
        const chosen = autos[0];
        // applyPromo hanya untuk preview impact (non-mutating)
        const { impact, actions } = await applyPromo(chosen, {
          items: normalizedForEngine.items
        });
        autoAppliedPromo = {
          promoId: String(chosen._id),
          name: chosen.name || null,
          impact,
          actions: actions || []
        };
      }
    }
  } catch (e) {
    console.warn('[checkout] autoApply preview failed', e?.message || e);
    autoAppliedPromo = null;
  }

  const selectedForEngine = req.body?.selectedPromoId
    ? req.body?.selectedPromoId
    : autoAppliedPromo
    ? String(autoAppliedPromo.promoId)
    : null;

  const autoApplyForEngine = req.body?.selectedPromoId
    ? false
    : selectedForEngine
    ? false
    : true;

  const engineDeliveryFee = Number(
    deliveryObj.delivery_fee_raw ??
      deliveryObj.delivery_fee ??
      Number(process.env.DELIVERY_FLAT_FEE || 0)
  );

  console.log('[checkout] engineDeliveryFee ->', engineDeliveryFee);
  console.log('[checkout.debug] calling applyPromoThenVoucher with:', {
    memberId: MemberDoc?._id || null,
    fulfillmentType: ft,
    engineDeliveryFee,
    voucherClaimIds_forEngine: eligibleClaimIds,
    normalizedForEngine_summary: {
      items_len: (normalizedForEngine.items || []).length,
      first:
        normalizedForEngine.items && normalizedForEngine.items[0]
          ? {
              menuId: String(normalizedForEngine.items[0].menuId || ''),
              qty: normalizedForEngine.items[0].qty,
              price: normalizedForEngine.items[0].price
            }
          : null
    }
  });

  priced = await applyPromoThenVoucher({
    memberId: MemberDoc ? MemberDoc._id : null,
    memberDoc: MemberDoc || null,
    cart: normalizedForEngine,
    fulfillmentType: ft,
    deliveryFee: engineDeliveryFee,
    voucherClaimIds: eligibleClaimIds,
    selectedPromoId: selectedForEngine,
    autoApplyPromo: autoApplyForEngine,
    promoUsageFetchers
  });
  console.log('[voucher] engineChosenClaimIds:', priced?.chosenClaimIds || []);

  // --- END PANGGIL price engine ---

  if (!priced || !priced.ok) {
    console.error('[checkout] price engine failed:', priced?.reasons || priced);
    throwError(
      (priced && priced.reasons && priced.reasons.join?.(', ')) ||
        'Gagal menghitung harga (engine)',
      400
    );
  }

  console.log('[checkout][engine-debug]', {
    engineDeliveryFee,
    priced_totals: priced?.totals || {},
    priced_breakdown: priced?.breakdown || [],
    priced_chosenClaimIds: priced?.chosenClaimIds || []
  });

  if (
    (!eligibleClaimIds || eligibleClaimIds.length === 0) &&
    Array.isArray(priced?.chosenClaimIds) &&
    priced.chosenClaimIds.length
  ) {
    console.warn(
      '[checkout][fallback] eligibleClaimIds empty; using priced.chosenClaimIds from engine'
    );
    eligibleClaimIds = priced.chosenClaimIds.map(String);
    console.log(
      '[checkout][fallback] eligibleClaimIds replaced ->',
      eligibleClaimIds
    );
  }

  // jika FE minta voucher tapi eligibleClaimIds kosong -> log detail (sudah ada log, ini tambahan)
  if (
    Array.isArray(voucherClaimIds) &&
    voucherClaimIds.length &&
    eligibleClaimIds.length === 0
  ) {
    console.error(
      '[checkout][voucher-debug][NO_ELIGIBLE] requested but none eligible',
      {
        requested: voucherClaimIds,
        memberId: MemberDoc ? String(MemberDoc._id) : null,
        rawByIdSummary: rawById.map((d) => ({
          id: String(d._id),
          member: String(d.member || null),
          status: d.status,
          remainingUse: d.remainingUse ?? null,
          validUntil: d.validUntil || null,
          voucherId: d.voucher ? String(d.voucher) : null
        }))
      }
    );
  }

  // --- pastikan voucher yang dikirim FE benar-benar diaplikasikan (tetap ada) ---
  const breakdown = Array.isArray(priced.breakdown) ? priced.breakdown : [];
  const claimedInBreakdown = new Set(
    breakdown
      .map((b) => b.claimId)
      .filter(Boolean)
      .map(String)
  );

  if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
    const anyApplied = eligibleClaimIds.some((cid) =>
      claimedInBreakdown.has(String(cid))
    );
    if (!anyApplied) {
      console.error(
        '[checkout] requested voucherClaimIds not applied by engine',
        {
          requested: voucherClaimIds,
          eligible: eligibleClaimIds,
          breakdown
        }
      );
      const reasonMsg =
        (priced && priced.reasons && priced.reasons.join?.(', ')) ||
        'Voucher tidak bisa diterapkan saat checkout';
      throwError(reasonMsg, 400);
    }
  }

  const discounts = [];
  const appliedVoucherIdSet = new Set();

  const engineDiscounts = Array.isArray(priced.discounts)
    ? priced.discounts
    : Array.isArray(priced.breakdown)
    ? priced.breakdown
    : [];

  const isObjectIdLike = (s) =>
    typeof s === 'string' && /^[0-9a-fA-F]{24}$/.test(s);
  const claimIdsNeeded = engineDiscounts
    .flatMap((d) =>
      (d.items || []).map((it) => it.claimId || it.claim_id || null)
    )
    .filter(Boolean)
    .map(String)
    .filter(isObjectIdLike);

  let claimDocsMap = {};
  if (claimIdsNeeded.length) {
    const claimDocs = await VoucherClaim.find({ _id: { $in: claimIdsNeeded } })
      .lean()
      .catch(() => []);
    claimDocsMap = claimDocs.reduce((acc, cd) => {
      acc[String(cd._id)] = cd;
      return acc;
    }, {});
  }

  for (const d of engineDiscounts) {
    // normalize fields differences from older engine.breakdown
    const id = d.id || d.claimId || d.claim_id || null;
    const source = d.source || (d.voucherId || d.voucher ? 'voucher' : 'promo');
    const label = d.label || d.name || d.title || '';
    const amount = Number(d.amount ?? d.amountTotal ?? d.itemsDiscount ?? 0);
    const items = Array.isArray(d.items)
      ? d.items.map((it) => ({
          menuId: it.menuId || it.menu || it.menu_id || null,
          qty: Number(it.qty || it.quantity || 0),
          amount: int(it.amount || it.line_discount || 0)
        }))
      : [];

    discounts.push({
      claimId: id && source === 'voucher' ? String(id) : null,
      voucherId:
        id && source === 'voucher' && claimDocsMap[String(id)]
          ? String(claimDocsMap[String(id)].voucher || null)
          : null,
      id: id ? String(id) : null,
      source,
      label,
      amount: int(amount),
      items,
      meta: d.meta || {},
      raw: d
    });

    // collect voucher ids for appliedVouchers array
    if (source === 'voucher') {
      // if engine provided voucherId directly
      if (d.voucherId || d.voucher_id || d.voucher) {
        appliedVoucherIdSet.add(
          String(d.voucherId || d.voucher_id || d.voucher)
        );
      } else if (
        id &&
        claimDocsMap[String(id)] &&
        claimDocsMap[String(id)].voucher
      ) {
        appliedVoucherIdSet.add(String(claimDocsMap[String(id)].voucher));
      }
    }
  }

  const appliedVoucherIds = Array.from(appliedVoucherIdSet);

  // --- ambil totals engine untuk hitung uiTotals & order pricing ---
  const baseItemsSubtotal = int(priced.totals?.baseSubtotal || 0);
  const items_discount = int(priced.totals?.itemsDiscount || 0);
  const shipping_discount = int(priced.totals?.shippingDiscount || 0);
  const reportedDelivery = int(priced.totals?.deliveryFee || 0);
  const engineGrand = priced.totals?.grandTotal ?? null;

  const delivery_fee_net = Math.max(0, reportedDelivery - shipping_discount);

  if (
    typeof deliveryObj.delivery_fee_raw === 'undefined' ||
    deliveryObj.delivery_fee_raw === null
  ) {
    deliveryObj.delivery_fee_raw = int(
      reportedDelivery + shipping_discount || deliveryObj.delivery_fee || 0
    );
  }

  deliveryObj.delivery_fee = int(delivery_fee_net);
  deliveryObj.shipping_discount = int(shipping_discount || 0);

  const items_subtotal_after_discount = Math.max(
    0,
    baseItemsSubtotal - items_discount
  );
  const service_fee = int(
    Math.round(items_subtotal_after_discount * SERVICE_FEE_RATE)
  );
  const rateForTax = parsePpnRate();
  const taxAmount = int(Math.round(items_subtotal_after_discount * rateForTax));
  const taxRatePercent = Math.round(rateForTax * 100 * 100) / 100;

  const beforeRound = int(
    items_subtotal_after_discount +
      service_fee +
      deliveryObj.delivery_fee -
      shipping_discount +
      taxAmount
  );

  const requested_bvt = engineGrand
    ? int(engineGrand)
    : int(roundRupiahCustom(beforeRound));
  const rounding_delta = int(requested_bvt - beforeRound);

  if (requested_bvt <= 0) {
    console.error('[checkout] invalid total requested_bvt', {
      requested_bvt,
      beforeRound
    });
    throwError('Total pembayaran tidak valid.', 400);
  }

  const uiTotals = {
    items_subtotal: int(baseItemsSubtotal),
    items_discount: int(items_discount || 0),
    delivery_fee: int(deliveryObj.delivery_fee || 0),
    shipping_discount: int(shipping_discount || 0),
    service_fee: int(service_fee || 0),
    tax_rate_percent: Number(taxRatePercent || 0),
    tax_amount: int(taxAmount || 0),
    rounding_delta: int(rounding_delta || 0),
    grand_total: int(requested_bvt || 0),
    items_subtotal_after_discount: int(items_subtotal_after_discount || 0),
    discounts // langsung dari engine (normalisasi)
  };

  // safe read points dari MemberDoc
  let memberPointsBalance = 0;
  try {
    if (MemberDoc) {
      // pastikan MemberDoc bukan null dan memiliki field points
      memberPointsBalance = Math.floor(Number(MemberDoc.points ?? 0));
    } else {
      memberPointsBalance = 0;
    }
  } catch (e) {
    console.warn(
      '[checkout] failed read MemberDoc.points, default to 0',
      e?.message || e
    );
    memberPointsBalance = 0;
  }

  const grandBeforePoints = Number(uiTotals.grand_total || 0); // engine rounded total

  const points_candidate_use = usePoints
    ? Math.min(memberPointsBalance, Math.max(0, Math.round(grandBeforePoints)))
    : 0;

  const raw_after_points = Math.max(
    0,
    grandBeforePoints - points_candidate_use
  );

  const grand_after_points = roundRupiahCustom(Math.round(raw_after_points));
  const rounding_delta_after =
    Number(grand_after_points) - Number(raw_after_points);

  try {
    uiTotals.grand_total = int(grand_after_points);
    uiTotals.rounding_delta = int(
      (uiTotals.rounding_delta || 0) + rounding_delta_after
    );

    uiTotals.points_candidate_use = int(points_candidate_use || 0);
    uiTotals.grand_total_before_points = int(
      grandBeforePoints || uiTotals.grand_total_before_points || 0
    );
    uiTotals.grand_total_after_points = int(grand_after_points);
    uiTotals.rounding_delta_after_points = int(rounding_delta_after || 0);
  } catch (e) {
    console.warn(
      '[checkout] failed to patch uiTotals after points',
      e?.message || e
    );
  }

  uiTotals.grand_total_before_points = int(grandBeforePoints);
  uiTotals.points_candidate_use = int(points_candidate_use);
  uiTotals.grand_total_after_points = int(grand_after_points);
  uiTotals.rounding_delta_after_points = int(rounding_delta_after);

  const initialIsPaid = !needProof(method);
  const initialPaymentStatus = initialIsPaid ? 'paid' : 'unpaid';
  const initialPaidAt = initialIsPaid ? new Date() : null;

  const itemAdjustmentsMap = priced.itemAdjustments || {}; // menuId -> [ { type, amount, reason, promoId, voucherClaimId, qty } ]
  const orderItems = (cart.items || []).map((it) => {
    const menuBase = Number(it.base_price ?? it.unit_price ?? it.price ?? 0);
    const addons = Array.isArray(it.addons) ? it.addons : [];
    const addonsPerUnit = addons.reduce(
      (s, a) => s + Number(a?.price || 0) * Math.max(1, Number(a?.qty || 1)),
      0
    );
    const unit_price = Math.round(menuBase + addonsPerUnit);
    const qty = Number(it.quantity ?? it.qty ?? 0) || 0;
    const menuId = it.menu;

    const lineSubtotal = int(unit_price * qty);
    // fetch adjustments from engine map by menuId (stringified)
    const adjustments = itemAdjustmentsMap?.[String(menuId)] || [];

    // calc adj total
    const adjTotal = (adjustments || []).reduce(
      (s, a) => s + Number(a.amount || 0),
      0
    );

    return {
      menu: menuId,
      menu_code: it.menu_code || it.menuCode || null,
      name: it.name || null,
      imageUrl: it.imageUrl || null,
      base_price: int(menuBase),
      quantity: qty,
      addons: it.addons || [],
      notes: String(it.notes || '').trim(),
      category: it.category || null,
      line_subtotal: int(lineSubtotal),
      adjustments: (adjustments || []).map((a) => ({
        type: a.type || 'promo',
        amount: int(a.amount || 0),
        reason: a.reason || a.label || '',
        promoId: a.promoId || a.promo || null,
        voucherClaimId: a.voucherClaimId || a.claimId || null,
        qty: Number(a.qty || 0)
      })),
      line_total_after_adjustments: Math.max(0, int(lineSubtotal - adjTotal))
    };
  });

  const promoApplied = priced.promoApplied || null;
  const promoRewards = []; // untuk simpan ke order
  if (
    promoApplied &&
    promoApplied.impact &&
    Array.isArray(promoApplied.impact.addedFreeItems)
  ) {
    // enrich free items with Menu data
    for (const f of promoApplied.impact.addedFreeItems) {
      let menuDoc = null;
      try {
        if (f.menuId) menuDoc = await Menu.findById(f.menuId).lean();
      } catch (e) {
        console.warn(
          '[checkout] fetch Menu for free item failed',
          e?.message || e
        );
      }
      const freeName = menuDoc?.name || f.name || 'Free item';
      const freeImage = menuDoc?.imageUrl || f.imageUrl || null;

      orderItems.push({
        menu: f.menuId || null,
        menu_code: menuDoc?.code || null,
        name: freeName,
        imageUrl: freeImage,
        base_price: 0,
        quantity: Number(f.qty || 1),
        addons: [],
        notes: `Free item (promo ${promoApplied.name || ''})`,
        category: f.category || null,
        line_subtotal: 0
      });

      promoRewards.push({
        type: 'free_item',
        menuId: f.menuId || null,
        name: freeName,
        qty: Number(f.qty || 1),
        note: f.note || null
      });
    }
  }

  // Jika promo memberikan actions (points/membership), masukkan juga ke promoRewards
  if (promoApplied && Array.isArray(promoApplied.actions)) {
    for (const a of promoApplied.actions) {
      promoRewards.push({
        type: a.type || 'action',
        amount: a.amount || null,
        meta: a.meta || {}
      });
    }
  }

  // --- siapkan appliedPromo snapshot untuk disimpan ke order.appliedPromo ---
  const appliedPromoSnapshot = promoApplied
    ? {
        promoId: promoApplied.promoId || null,
        name: promoApplied.name || null,
        impact: promoApplied.impact || {},
        actions: promoApplied.actions || []
      }
    : null;

  // --- siapkan orderPriceSnapshot untuk audit (simpan uiTotals + engine data) ---
  const orderPriceSnapshot = {
    ui_totals: uiTotals || {},
    engineTotals: priced.totals || {},
    breakdown: priced.breakdown || []
  };
  const ownerVerified = !paymentRequiresOwnerVerify(method);
  let order;
  function sumPointsAwardedFromPromoActions(actions = []) {
    // standar: actions array mungkin berisi { type: 'award_points', points: 123 } atau reward details
    if (!Array.isArray(actions)) return 0;
    let sum = 0;
    for (const a of actions) {
      if (!a) continue;
      if (String(a.type || '').toLowerCase() === 'award_points') {
        // support both a.points or a.amount
        sum += Number(a.points ?? a.amount ?? 0);
      } else if (a?.reward && typeof a.reward === 'object') {
        // legacy shaped action
        sum += Number(a.reward.points ?? 0);
      }
    }
    return Math.max(0, Math.round(sum));
  }

  // uiTotals dan priced sudah tersedia lebih atas di fungsi checkout (per kode asli)
  const session = await mongoose.startSession();
  let createdOrder = null;
  try {
    await session.withTransaction(async () => {
      // prepare payload for order creation (mirror existing payload)
      const payload = {
        member: MemberDoc ? MemberDoc._id : null,
        customer_name: MemberDoc ? MemberDoc.name || '' : customer_name,
        customer_phone: MemberDoc ? MemberDoc.phone || '' : customer_phone,
        table_number: ft === 'dine_in' ? cart.table_number ?? null : null,
        source: iden.source || 'online',
        fulfillment_type: ft,
        transaction_code: await nextDailyTxCode('ARCH'), // keep original helper
        guestToken: guestToken || null,
        items: orderItems,
        items_subtotal: int(uiTotals.items_subtotal || 0),
        items_discount: int(uiTotals.items_discount || 0),
        delivery_fee: int(uiTotals.delivery_fee || 0),
        shipping_discount: int(uiTotals.shipping_discount || 0),
        discounts: discounts || [],
        appliedVouchers: (appliedVoucherIds || []).map((id) => ({
          voucherId: id,
          voucherSnapshot: {}
        })),
        appliedVouchersIds: appliedVoucherIds || [], // optional, keep older field if used elsewhere
        appliedPromo: priced.promoApplied
          ? {
              promoId:
                priced.promoApplied.promoId || priced.promoApplied.promoId,
              promoSnapshot: priced.promoApplied
            }
          : appliedPromoSnapshot || { promoId: null, promoSnapshot: {} },
        promoRewards: priced.promoRewards || promoRewards || [],
        points_awarded_details: priced.points_awarded_details || {
          total: 0,
          actions: []
        },
        engineSnapshot: priced.engineSnapshot || {},

        ownerVerified, // existing logic
        ownerVerifiedBy: ownerVerified ? req.user?.id || null : null,
        ownerVerifiedAt: ownerVerified ? new Date() : null,
        orderPriceSnapshot,
        service_fee: int(uiTotals.service_fee || 0),
        tax_rate_percent: Number(uiTotals.tax_rate_percent || 0),
        tax_amount: int(uiTotals.tax_amount || 0),
        rounding_delta: int(uiTotals.rounding_delta || 0),
        grand_total: int(uiTotals.grand_total || 0),
        payment_method: method,
        payment_provider:
          method === PM.QRIS && !QRIS_USE_STATIC ? 'xendit' : null,
        payment_status: initialPaymentStatus,
        paid_at: initialPaidAt,
        payment_proof_url: null,
        status: 'created',
        placed_at: new Date(),
        delivery: {
          ...deliveryObj,
          delivery_fee: int(uiTotals.delivery_fee || 0),
          shipping_discount: int(uiTotals.shipping_discount || 0),
          delivery_fee_raw: int(deliveryObj.delivery_fee_raw || 0)
        }
      };

      // --- Prepare loyalty/points snapshot values BEFORE any DB change ---
      const member_level_before = MemberDoc
        ? String(MemberDoc.level || 'bronze')
        : null;
      const total_spend_before = MemberDoc
        ? Number(MemberDoc.total_spend || 0)
        : 0;

      let freshMember = null;
      if (MemberDoc) {
        freshMember = await Member.findById(MemberDoc._id).session(session);
        if (!freshMember) throwError('Member tidak ditemukan saat commit', 404);
      } else {
        freshMember = null;
      }

      // pastikan integer points (floor)
      const memberPointsInt = freshMember
        ? Math.floor(Number(freshMember.points || 0))
        : 0;

      const engineGrandBefore = Number(
        uiTotals.grand_total_before_points ??
          grandBeforePoints ??
          uiTotals.grand_total
      );

      // compute candidate points to use
      let pointsUsedReq = 0;
      if (usePoints) {
        if (!freshMember && !MemberDoc) {
          throwError('Poin hanya dapat digunakan oleh member terdaftar', 400);
        }
        const memberForPoints = freshMember || MemberDoc;
        const memberBalance = Math.max(
          0,
          Math.floor(Number(memberForPoints?.points || 0))
        );

        // gunakan engineGrandBefore (sebelum points) untuk hitung berapa poin yg mungkin dipakai
        pointsUsedReq = Math.min(
          memberBalance,
          Math.max(0, Math.round(engineGrandBefore))
        );
      } else {
        // legacy: allow FE to explicitly pass points_used (floor it)
        pointsUsedReq = Math.floor(
          Number(req.body?.points_used ?? priced?.totals?.points_used ?? 0) || 0
        );
      }

      // raw after deduction (integer math)
      const raw_after_points = Math.max(0, engineGrandBefore - pointsUsedReq);

      // perform final rounding AFTER points deduction
      const grand_after_points = roundRupiahCustom(
        Math.round(raw_after_points)
      );
      const rounding_delta_after =
        Number(grand_after_points) - Number(raw_after_points);

      // buat nilai ini tersedia untuk dipakai ketika membangun payload di bawah
      // (kamu sebelumnya pakai grandBefore/pointsUsedReq; sekarang gunakan grand_after_points)

      // If payment_method = 'points', enforce rules:
      if (String(method) === 'points') {
        if (!MemberDoc) {
          throwError('Pembayaran dengan point hanya untuk member', 400);
        }

        const memberBalanceQuick = Math.max(
          0,
          Math.floor(Number(MemberDoc.points || 0))
        );

        const engineGrandBefore = Number(
          uiTotals.grand_total_before_points ??
            grandBeforePoints ??
            uiTotals.grand_total
        );

        let pointsUsedReqCandidate = 0;
        if (usePoints) {
          pointsUsedReqCandidate = Math.min(
            memberBalanceQuick,
            Math.max(0, Math.round(engineGrandBefore))
          );
        } else if (
          typeof req.body?.points_used !== 'undefined' &&
          req.body?.points_used !== null
        ) {
          const parsed = Math.floor(Number(req.body.points_used) || 0);
          pointsUsedReqCandidate = Math.max(0, parsed);
        } else if (
          typeof priced?.totals?.points_used !== 'undefined' &&
          priced?.totals?.points_used
        ) {
          pointsUsedReqCandidate = Math.floor(
            Number(priced.totals.points_used || 0)
          );
        }

        pointsUsedReqCandidate = Math.min(
          pointsUsedReqCandidate,
          memberBalanceQuick
        );

        const grandAfterPointsCheck = Math.max(
          0,
          engineGrandBefore - pointsUsedReqCandidate
        );
        if (grandAfterPointsCheck !== 0) {
          throwError(
            'Pembayaran dengan point hanya diperbolehkan jika poin yang digunakan menutup seluruh jumlah (grand total setelah poin = 0). Pastikan usePoints=true atau kirim points_used yang cukup.',
            400
          );
        }

        pointsUsedReq = pointsUsedReqCandidate;

        const freshMember = await Member.findById(MemberDoc._id).session(
          session
        );
        if (!freshMember) throwError('Member tidak ditemukan', 404);
        if (Number(freshMember.points || 0) < pointsUsedReq) {
          throwError('Saldo point tidak mencukupi', 400);
        }
      }

      const promoActions =
        priced.points_awarded_details && priced.points_awarded_details.actions
          ? priced.points_awarded_details.actions
          : appliedPromoSnapshot?.actions ||
            priced?.promoApplied?.actions ||
            [];
      const points_awarded = Math.max(
        0,
        Math.round(
          priced?.points_awarded_details?.total ??
            sumPointsAwardedFromPromoActions(promoActions)
        )
      );
      const points_awarded_details =
        priced.points_awarded_details ||
        (promoActions?.length
          ? { actions: promoActions, total: points_awarded }
          : {});

      const total_spend_delta = Number(
        payload.grand_total ||
          uiTotals.grand_total_after_points ||
          uiTotals.grand_total ||
          0
      );

      payload.member_level_before = member_level_before;
      payload.total_spend_before = total_spend_before;
      payload.total_spend_delta = int(total_spend_delta);
      payload.member_level_after = null; // set after computing new total
      payload.points_used = int(pointsUsedReq);
      payload.points_awarded = int(points_awarded);
      payload.points_awarded_details = points_awarded_details;

      // gunakan hasil rounding-after-deduction sebagai grand_total final
      payload.rounding_delta = int(
        (payload.rounding_delta || 0) + rounding_delta_after
      );
      payload.grand_total = int(grand_after_points);

      const pointsDiscountEntry = {
        id: null,
        source: 'manual',
        orderIdx: 3,
        type: 'points',
        label: 'Poin',
        amount: int(pointsUsedReq || 0),
        items: [],
        meta: { via: 'points_toggle' }
      };
      payload.discounts = Array.isArray(payload.discounts)
        ? payload.discounts
        : [];
      if (pointsUsedReq > 0) payload.discounts.push(pointsDiscountEntry);

      // if grand_after_points == 0 => mark paid by points (override payment fields)
      if (Number(grand_after_points) === 0) {
        payload.payment_method = 'points';
        payload.payment_status = 'paid';
        payload.paid_at = new Date();
      } else {
        // biarkan payment_method = method (request)
        payload.payment_method = method;
        payload.payment_status =
          payload.payment_status || (initialIsPaid ? 'paid' : 'unpaid');
      }

      // Create order document inside session
      const [doc] = await Order.create([payload], { session });
      // ==============================
      // FORCE SET order totals dari uiTotals (agar konsisten dengan orderPriceSnapshot)
      // ==============================
      try {
        const pointsUsedInt = int(pointsUsedReq || 0);
        const itemsDiscountFinal =
          int(uiTotals.items_discount || 0) + pointsUsedInt;

        await Order.updateOne(
          { _id: doc._id },
          {
            $set: {
              items_subtotal: int(uiTotals.items_subtotal || 0),
              // pastikan saved items_discount sudah include points
              items_discount: itemsDiscountFinal,
              items_subtotal_after_discount: int(
                uiTotals.items_subtotal_after_discount || 0
              ),

              delivery_fee: int(uiTotals.delivery_fee || 0),
              shipping_discount: int(uiTotals.shipping_discount || 0),

              service_fee: int(uiTotals.service_fee || 0),
              tax_rate_percent: Number(uiTotals.tax_rate_percent || 0),
              tax_amount: int(uiTotals.tax_amount || 0),

              rounding_delta: int(
                payload.rounding_delta ??
                  uiTotals.rounding_delta_after_points ??
                  uiTotals.rounding_delta ??
                  0
              ),
              grand_total: int(
                payload.grand_total ??
                  uiTotals.grand_total_after_points ??
                  uiTotals.grand_total ??
                  0
              ),

              orderPriceSnapshot: orderPriceSnapshot
            }
          },
          { session }
        );
        // debug: verifikasi singkat (opsional)
        const check = await Order.findById(doc._id).session(session).lean();
      } catch (e) {
        console.warn(
          '[checkout] failed to force-set order totals from uiTotals',
          e?.message || e
        );
        throwError('Gagal menyimpan order totals', 500);
      }

      // Update member (if exists): apply point deduction, award points, update total_spend, evaluate level after
      if (MemberDoc) {
        const memberId = MemberDoc._id;
        // Re-fetch inside session to be safe
        const memberLive = await Member.findById(memberId).session(session);
        if (!memberLive) throwError('Member tidak ditemukan saat commit', 404);

        // compute new points balance
        const currentPoints = Number(memberLive.points || 0);
        const newPointsAfterUsage = Math.max(
          0,
          currentPoints - int(pointsUsedReq)
        );
        const newPointsAfterAward = newPointsAfterUsage + int(points_awarded);

        // compute new total spend
        const newTotalSpend =
          Number(memberLive.total_spend || 0) + Number(total_spend_delta || 0);

        // evaluate new level
        const newLevel = evaluateMemberLevel(newTotalSpend);

        // update member fields atomically inside session
        await Member.updateOne(
          { _id: memberId },
          {
            $set: {
              points: int(newPointsAfterAward),
              last_visit_at: new Date()
            },
            $inc: {
              total_spend: int(total_spend_delta),
              spend_point_total: int(pointsUsedReq)
            }
          },
          { session }
        );

        // set member_level_after into order doc (update)
        await Order.updateOne(
          { _id: doc._id },
          {
            $set: {
              member_level_after: newLevel
            }
          },
          { session }
        );

        // also persist level on member (if changed)
        if (String(memberLive.level || '') !== String(newLevel)) {
          await Member.updateOne(
            { _id: memberId },
            { $set: { level: newLevel } },
            { session }
          );
        }
      }

      try {
        if (
          payload.appliedPromo &&
          payload.appliedPromo.promoSnapshot &&
          payload.appliedPromo.promoSnapshot.promoId
        ) {
          const promoId = String(
            payload.appliedPromo.promoSnapshot.promoId ||
              payload.appliedPromo.promoId ||
              ''
          );
          if (promoId) {
            await consumePromoForOrder({
              promoId,
              memberId: payload.member || null,
              orderId: doc._id,
              session
            });
          }
        } else if (payload.appliedPromo && payload.appliedPromo.promoId) {
          const promoId = String(payload.appliedPromo.promoId);
          await consumePromoForOrder({
            promoId,
            memberId: payload.member || null,
            orderId: doc._id,
            session
          });
        }
      } catch (e) {
        console.error(
          '[checkout] consumePromoForOrder failed',
          e?.message || e
        );
        throwError(
          e?.message || 'Gagal mengamankan penggunaan promo',
          e?.status || 500
        );
      }

      createdOrder = doc;
    }); // end withTransaction
  } finally {
    session.endSession();
  }

  if (!createdOrder) {
    throwError('Gagal create order (unknown)', 500);
  }

  // assign to order variable used further down
  order = createdOrder;

  // --- handle upload bukti jika perlu (sama seperti sebelumnya) ---
  try {
    if (needProof(method)) {
      if (!req.file) {
        await Order.deleteOne({ _id: order._id }).catch(() => {});
        console.error(
          '[checkout] missing proof file for method that requires it'
        );
        throwError('Bukti pembayaran wajib diunggah untuk metode ini', 400);
      }

      const proofUrl = await handleTransferProofIfAny(req, method, {
        transactionCode: order.transaction_code
      });

      if (proofUrl) {
        order.payment_proof_url = proofUrl;
        order.payment_status = 'paid';
        order.paid_at = new Date();
        await order.save();
      } else {
        await Order.deleteOne({ _id: order._id }).catch(() => {});
        console.error('[checkout] proof upload returned empty url');
        throwError('Gagal mengunggah bukti pembayaran', 500);
      }
    }
  } catch (err) {
    try {
      await Order.deleteOne({ _id: order._id });
    } catch (ee) {
      console.error('[checkout][rollback][deleteOrder]', ee?.message || ee);
    }
    console.error('[checkout] handle proof error', err?.message || err);
    throwError(
      err?.message
        ? `Gagal upload bukti pembayaran: ${String(err.message)}`
        : 'Gagal upload bukti pembayaran',
      err?.status || 500
    );
  }

  // --- konsumsi voucher claims (non-fatal) berdasarkan priced.chosenClaimIds ---
  if (MemberDoc) {
    console.log('[voucher] consuming:', priced.chosenClaimIds || []);

    for (const claimId of priced.chosenClaimIds || []) {
      try {
        const c = await VoucherClaim.findById(claimId);
        if (
          c &&
          c.status === 'claimed' &&
          String(c.member) === String(MemberDoc._id)
        ) {
          c.remainingUse = Math.max(0, (c.remainingUse || 1) - 1);
          if (c.remainingUse <= 0) c.status = 'used';
          c.history = c.history || [];
          c.history.push({
            at: new Date(),
            action: 'USE',
            ref: String(order._id),
            note: 'dipakai pada order'
          });
          await c.save();
          console.log('[checkout] voucher claim consumed', {
            claimId: c._id,
            remainingUse: c.remainingUse,
            status: c.status
          });

          // jika voucher pakai global_stock dan stok = 0 -> revoke klaim lain
          try {
            const v = await Voucher.findById(c.voucher).lean();
            if (v && v.visibility && v.visibility.mode === 'global_stock') {
              const remaining = Number(v.visibility.globalStock || 0);
              if (remaining <= 0) {
                await VoucherClaim.updateMany(
                  { voucher: v._id, status: 'claimed' },
                  {
                    $set: { status: 'revoked' },
                    $push: {
                      history: {
                        at: new Date(),
                        action: 'REVOKE',
                        note: 'stok global habis - otomatis revoke'
                      }
                    }
                  }
                );
                console.log(
                  '[checkout] global stock empty -> revoked other claims',
                  { voucher: v._id }
                );
              }
            }
          } catch (ee) {
            console.error(
              '[voucher][consume][revoke-if-stock-empty] failed',
              ee?.message || ee
            );
          }
        } else {
          console.warn('[checkout] voucher claim not consumable', {
            claimId,
            found: !!c,
            status: c?.status
          });
        }
      } catch (err) {
        console.error('[voucher][consume] gagal update', err?.message || err);
      }
    }
  } else {
    console.log('[checkout] no MemberDoc -> skip consuming vouchers');
  }

  // --- update cart status checked_out ---
  try {
    await Cart.findByIdAndUpdate(cart._id, {
      $set: {
        status: 'checked_out',
        checked_out_at: new Date(),
        order_id: order._id,
        last_idempotency_key: idempotency_key || null,
        items: [],
        total_items: 0,
        total_quantity: 0,
        total_price: 0
      }
    });
    console.log('[checkout] cart updated to checked_out', { cartId: cart._id });
  } catch (err) {
    console.error(
      '[checkout] gagal update cart setelah order dibuat',
      err?.message || err
    );
  }

  try {
    const summary = {
      id: String(order._id),
      transaction_code: order.transaction_code || '',
      delivery_mode:
        order.delivery?.mode ||
        (order.fulfillment_type === 'dine_in' ? 'none' : 'delivery'),
      grand_total: Number(order.grand_total || 0),
      fulfillment_type: order.fulfillment_type || null,
      customer_name:
        (order.member && order.member.name) || order.customer_name || '',
      customer_phone:
        (order.member && order.member.phone) || order.customer_phone || '',
      placed_at: order.placed_at || order.createdAt || null,
      table_number:
        order.fulfillment_type === 'dine_in'
          ? order.table_number || null
          : null,
      payment_status: order.payment_status || null,
      status: order.status || null,
      total_quantity: Number(order.total_quantity || 0),
      pickup_window: order.delivery?.pickup_window
        ? {
            from: order.delivery.pickup_window.from || null,
            to: order.delivery.pickup_window.to || null
          }
        : null,
      delivery_slot_label: order.delivery?.slot_label || null,
      member_id: order.member ? String(order.member) : null,
      items_discount: Number(order.items_discount || 0),
      shipping_discount: Number(order.shipping_discount || 0),
      delivery_fee: Number(
        order.delivery_fee || order.delivery?.delivery_fee || 0
      ),
      discounts: Array.isArray(order.discounts) ? order.discounts : [],
      applied_voucher_ids: Array.isArray(order.applied_voucher_ids)
        ? order.applied_voucher_ids
        : []
    };

    emitToCashier('staff:notify', {
      message: 'Ada pesanan yang masuk, silakan cek halaman pesanan Anda'
    });

    emitOrdersStream({ target: 'cashier', action: 'insert', item: summary });

    emitToStaff('staff:notify', { message: 'Pesanan baru dibuat.' });
    console.log('[checkout] emitted order summary to streams', {
      orderId: order._id
    });
  } catch (e) {
    console.error('[emit][checkout]', e?.message || e);
  }

  (async () => {
    try {
      const full =
        (await Order.findById(order._1 ? order._1 : order._id).lean?.()) ||
        (await Order.findById(order._id).lean());
      if (!full) return;

      // hanya kirim WA jika payment method membutuhkan owner verify
      if (!paymentRequiresOwnerVerify(full.payment_method)) return;

      // generate token & hash, expiry (hours from env)
      const EXPIRE_HOURS = Number(process.env.OWNER_VERIFY_EXPIRE_HOURS || 6);
      const tokenRaw = genTokenRaw(); // raw token -> dikirim via WA
      const tokenHash = hashTokenVerification(tokenRaw);
      const expiresAt = new Date(Date.now() + EXPIRE_HOURS * 60 * 60 * 1000);

      // simpan tokenHash & expiresAt di order (non-blocking update)
      await Order.updateOne(
        { _id: full._id },
        {
          $set: {
            'verification.tokenHash': tokenHash,
            'verification.expiresAt': expiresAt,
            // clear previous used meta if any
            'verification.usedAt': null,
            'verification.usedFromIp': '',
            'verification.usedUserAgent': ''
          }
        }
      ).catch((e) =>
        console.error(
          '[checkout][notify] failed update verification',
          e?.message || e
        )
      );

      // build verify link with raw token
      const DASHBOARD_URL =
        process.env.DASHBOARD_URL || 'https://dashboard.example.com';
      const verifyLink = `${DASHBOARD_URL}/public/owner-verify?orderId=${
        full._id
      }&token=${encodeURIComponent(tokenRaw)}`;

      const msg = buildOwnerVerifyMessage(full, verifyLink, EXPIRE_HOURS);

      const owners = getOwnerPhone();
      if (!owners.length) {
        console.warn('[notify][owner] OWNER_WA not set, skip WA');
        return;
      }

      const sendPromises = owners.map((rawPhone) => {
        const phone =
          typeof toWa62 === 'function' ? toWa62(rawPhone) : rawPhone;
        return sendText(phone, msg).then(
          (r) => ({ ok: true, phone: rawPhone, res: r }),
          (e) => ({ ok: false, phone: rawPhone, err: e?.message || e })
        );
      });

      const results = await Promise.allSettled(sendPromises);
      results.forEach((r) => {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v.ok)
            console.log('[notify][owner] WA sent', {
              phone: v.phone,
              orderId: String(full._id)
            });
          else
            console.error('[notify][owner] WA failed', {
              phone: v.phone,
              err: v.err
            });
        } else {
          console.error('[notify][owner] WA promise rejected', r.reason);
        }
      });
    } catch (e) {
      console.error('[notify][owner] unexpected error', e?.message || e);
    }
  })();

  res.status(201).json({
    order: order.toObject(),
    uiTotals,
    message: 'Checkout berhasil.'
  });
});

exports.createQrisFromCart = asyncHandler(async (req, res, next) => {
  try {
    const iden0 = getIdentity(req);
    const {
      name,
      phone,
      fulfillment_type,
      address_text,
      lat,
      lng,
      note_to_rider,
      voucherClaimIds = [],
      register_decision = 'register'
    } = req.body || {};

    const ft =
      iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
    if (!['dine_in', 'delivery'].includes(ft))
      throwError('fulfillment_type tidak valid', 400);

    // Member / guest resolution
    const originallyLoggedIn = !!iden0.memberId;
    const wantRegister = String(register_decision || 'register') === 'register';
    let member = null;
    let customer_name = '';
    let customer_phone = '';

    if (originallyLoggedIn || wantRegister) {
      const joinChannel = iden0.mode === 'self_order' ? 'self_order' : 'online';
      member = await ensureMemberForCheckout(req, res, joinChannel);
      if (member) {
        customer_name =
          String(member.name || '').trim() || String(name || '').trim();
        customer_phone =
          String(member.phone || '').trim() || String(phone || '').trim();
      }
    }

    if (!member) {
      customer_name = String(name || '').trim();
      customer_phone = String(phone || '').trim();
      if (!customer_name && !customer_phone) {
        throwError('Tanpa member: isi minimal nama atau no. telp', 400);
      }
    }

    const finalMemberId = member ? member._id : null;
    const iden = {
      ...iden0,
      memberId: finalMemberId || iden0.memberId || null,
      session_id:
        iden0.session_id ||
        req.cookies?.[DEVICE_COOKIE] ||
        req.header('x-device-id') ||
        null
    };

    // get active cart
    const cartObj = await getActiveCartForIdentity(iden, {
      allowCreateOnline: false
    });
    if (!cartObj) throwError('Cart tidak ditemukan / kosong', 404);

    const cart = await Cart.findById(cartObj._1d || cartObj._id);
    // (di beberapa codebase ada typo _1d; pastikan pakai cartObj._id)
    if (!cart || !cart.items?.length) throwError('Cart kosong', 404);

    if (
      ft === 'dine_in' &&
      (iden.source || 'online') === 'qr' &&
      !cart.table_number
    ) {
      throwError('Silakan assign nomor meja terlebih dahulu', 400);
    }

    if (finalMemberId && !cart.member) {
      cart.member = finalMemberId;
      cart.session_id = null;
    }

    const delivery_mode =
      ft === 'dine_in'
        ? 'none'
        : String(req.body?.delivery_mode || 'delivery').toLowerCase();

    // --- slot/pickup validation ---
    const providedSlot = (req.body?.delivery_slot || '').trim();
    const providedScheduledAtRaw = req.body?.scheduled_at || null;
    const providedScheduledAt = providedScheduledAtRaw
      ? dayjs(providedScheduledAtRaw).tz(LOCAL_TZ)
      : null;
    const pickup_from_iso = req.body?.pickup_from || null;
    const pickup_to_iso = req.body?.pickup_to || null;

    if (ft !== 'dine_in') {
      if (delivery_mode === 'delivery') {
        if (
          !providedSlot &&
          (!providedScheduledAt || !providedScheduledAt.isValid())
        ) {
          throwError('Jadwal pengantaran wajib diisi (delivery_slot)', 400);
        }
      } else if (delivery_mode === 'pickup') {
        if (!pickup_from_iso || !pickup_to_iso) {
          throwError(
            'Jadwal pengambilan wajib diisi (pickup_from & pickup_to)',
            400
          );
        }
      } else {
        throwError('delivery_mode tidak valid', 400);
      }
    }

    // sanitize items & addons
    cart.items = (Array.isArray(cart.items) ? cart.items : [])
      .filter(Boolean)
      .map((it) => {
        const rawAddons = Array.isArray(it.addons) ? it.addons : [];
        const safeAddons = rawAddons
          .filter((a) => a && typeof a === 'object')
          .map((a) => ({
            name: String(a.name || '').trim(),
            price: int(a.price || 0),
            qty: clamp(int(a.qty || 1), 1, 999),
            ...(typeof a.isActive === 'boolean'
              ? { isActive: !!a.isActive }
              : {})
          }));

        return {
          ...it,
          addons: safeAddons,
          notes: String(it.notes || '').trim()
        };
      });

    // recompute cart totals and persist
    recomputeTotals(cart);
    await cart.save();

    // voucher filtering (if member)
    let eligibleClaimIds = [];
    if (finalMemberId) {
      if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
        const rawClaims = await VoucherClaim.find({
          _id: { $in: voucherClaimIds },
          member: finalMemberId,
          status: 'claimed'
        }).lean();
        const now = new Date();
        eligibleClaimIds = rawClaims
          .filter((c) => !c.validUntil || c.validUntil > now)
          .map((c) => String(c._id));
      }
    } else if (voucherClaimIds?.length) {
      throwError('Voucher hanya untuk member. Silakan daftar/login.', 400);
    }

    const priced = await validateAndPrice({
      memberId: finalMemberId,
      cart: {
        items: cart.items.map((it) => {
          const addonsTotalPerItem = (
            Array.isArray(it.addons) ? it.addons : []
          ).reduce((s, a) => {
            const ap = Number(a?.price || 0);
            const aq = Number(a?.qty || 1);
            return s + ap * aq;
          }, 0);
          const unitPriceWithAddons =
            int(Number(it.base_price || 0)) + int(addonsTotalPerItem);

          return {
            menuId: it.menu,
            qty: it.quantity,
            price: unitPriceWithAddons,
            category: it.category || null
          };
        })
      },
      fulfillmentType: ft,
      deliveryFee: cart.delivery?.delivery_fee || 0,
      voucherClaimIds: eligibleClaimIds
    });

    // jika ada error saat inspect voucher, surfacing ke FE
    for (const b of priced.breakdown || []) {
      try {
        const voucherDoc = await Voucher.findById(
          b.voucherId || b.voucher
        ).lean();
        const scoped = filterItemsByScope(
          cart.items.map((it) => ({
            menuId: it.menu,
            qty: it.quantity,
            price: it.base_price,
            category: it.category
          })),
          voucherDoc.appliesTo
        );
        // (tidak ada console.log)
      } catch (e) {
        throwError(
          `Voucher inspection failed: ${e?.message || String(e)}`,
          500
        );
      }
    }

    // --- KEY: use cart UI totals as authoritative for payment amount ---
    // IMPORTANT FIX: sertakan mode:'delivery' kalau memang delivery agar buildUiTotalsFromCart menghitung delivery_fee
    const deliveryForUi =
      (priced.totals.deliveryFee || 0) > 0
        ? { delivery_fee: priced.totals.deliveryFee || 0, mode: 'delivery' }
        : { delivery_fee: 0, mode: ft === 'dine_in' ? 'none' : delivery_mode };

    const uiTotals = buildUiTotalsFromCart({
      total_price: priced.totals.baseSubtotal, // pre-discount
      items_discount: priced.totals.itemsDiscount || 0,
      shipping_discount: priced.totals.shippingDiscount || 0,
      delivery: deliveryForUi
    });

    const requested_bvt = int(Number(uiTotals.grand_total || 0));
    const rounding_delta = int(Number(uiTotals.rounding_delta || 0));

    if (!requested_bvt || requested_bvt <= 0) {
      throwError('Total pembayaran tidak valid.', 400);
    }

    // create payment session and attach uiTotals so FE can render identical numbers
    const reference_id = `QRIS-${cart._id}-${Date.now()}`;
    const sessionPayload = {
      member: finalMemberId || null,
      customer_name,
      customer_phone,
      source: iden.source || 'online',
      fulfillment_type: ft,
      table_number: ft === 'dine_in' ? cart.table_number ?? null : null,
      cart: cart._id,
      session_id: iden.session_id || null,
      items: cart.items.map((it) => ({
        menu: it.menu,
        menu_code: it.menu_code,
        name: it.name,
        imageUrl: it.imageUrl,
        base_price: it.base_price,
        quantity: it.quantity,
        addons: it.addons,
        notes: it.notes,
        category: it.category || null
      })),

      items_subtotal: int(priced.totals.baseSubtotal),
      items_discount: int(priced.totals.itemsDiscount || 0),
      delivery_fee: int(priced.totals.deliveryFee || 0),
      shipping_discount: int(priced.totals.shippingDiscount || 0),

      service_fee: int(uiTotals.service_fee || 0),
      tax_amount: int(uiTotals.tax_amount || 0),

      discounts: priced.breakdown || [],

      requested_amount: requested_bvt,
      rounding_delta,
      ui_totals: uiTotals,
      delivery_snapshot: cart.delivery || {},
      provider: 'xendit',
      channel: 'qris',
      external_id: reference_id
    };

    if (cart.delivery?.pickup_window) {
      sessionPayload.pickup_window = {
        from: cart.delivery.pickup_window.from,
        to: cart.delivery.pickup_window.to
      };
    }

    const session = await PaymentSession.create(sessionPayload);

    // call Xendit with authoritative amount from cart
    const xenditPayload = {
      reference_id,
      type: 'DYNAMIC',
      currency: 'IDR',
      amount: Number(requested_bvt),
      metadata: { payment_session_id: String(session._id) }
    };

    const resp = await axios.post(`${X_BASE}/qr_codes`, xenditPayload, {
      auth: { username: X_KEY, password: '' },
      headers: { ...HDRS, 'api-version': '2022-07-31' },
      timeout: 15000
    });

    const qr = resp.data;

    // persist back
    session.qr_code_id = qr.id;
    session.qr_string = qr.qr_string;
    session.expires_at = qr.expires_at ? new Date(qr.expires_at) : null;
    session.requested_amount = requested_bvt;
    session.ui_totals = uiTotals;
    await session.save();

    return res.json({
      success: true,
      data: {
        sessionId: String(session._id),
        channel: 'QRIS',
        amount: requested_bvt,
        qris: {
          qr_id: qr.id,
          qr_string: qr.qr_string,
          expiry_at: qr.expires_at
        },
        ui_totals: uiTotals,
        status: 'pending'
      }
    });
  } catch (err) {
    next(err);
  }
});

exports.assignTable = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);

  let table_number = req.body?.table_number;

  // ===== VALIDASI table_number =====
  if (table_number === undefined || table_number === null)
    throwError('table_number wajib', 400);

  // tidak boleh huruf atau tipe selain number
  if (typeof table_number === 'string') {
    // cek jika string numerik, kalau tidak, error
    if (!/^[0-9]+$/.test(table_number.trim())) {
      throwError('Nomor meja harus angka (1–50)', 400);
    }
    table_number = Number(table_number);
  }

  if (typeof table_number !== 'number' || Number.isNaN(table_number))
    throwError('Nomor meja harus angka valid', 400);

  // batasan nilai meja: 1–50
  if (table_number < 1 || table_number > 50)
    throwError('Nomor meja harus antara 1 sampai 50', 400);

  // =================================

  // ambil / buat session/device id
  let sessionId = iden.session_id || req.cookies?.[DEVICE_COOKIE];
  if (!sessionId && !iden.memberId) {
    sessionId = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, sessionId, {
      ...baseCookie,
      httpOnly: false,
      maxAge: REFRESH_TTL_MS
    });
  }

  // filter cart berdasarkan session/member
  const filter = iden.memberId
    ? { status: 'active', member: iden.memberId }
    : { status: 'active', session_id: sessionId };

  let cart = await Cart.findOne(filter);

  if (!cart) {
    cart = await Cart.create({
      member: iden.memberId || null,
      session_id: iden.memberId ? null : sessionId,
      source: 'qr',
      table_number,
      fulfillment_type: 'dine_in',
      items: [],
      total_items: 0,
      total_quantity: 0,
      total_price: 0,
      status: 'active',
      dine_in_cache: { last_table_number: table_number }
    });
  } else {
    cart.source = 'qr';
    cart.fulfillment_type = 'dine_in';
    cart.table_number = table_number;
    cart.dine_in_cache = cart.dine_in_cache || {};
    cart.dine_in_cache.last_table_number = table_number;
    await cart.save();
  }

  res.json({
    message: 'Nomor meja diset',
    cart: cart.toObject()
  });
});

exports.changeTable = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);

  const newNo = asInt(req.body?.table_number, 0);
  if (!newNo) throwError('Nomor meja baru wajib', 400);

  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreateOnline: false
  });
  const cart = await Cart.findById(cartObj._id);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  const oldNo = cart.table_number;
  cart.table_number = newNo;
  await cart.save();

  res.json({
    message: 'Nomor meja diperbarui',
    old_table: oldNo,
    new_table: newNo,
    cart: cart.toObject()
  });
});

exports.listMyOrders = asyncHandler(async (req, res) => {
  if (!req.member?.id) throwError('Harus login sebagai member', 401);

  const {
    status,
    source,
    fulfillment_type,
    limit = 20,
    cursor
  } = req.query || {};

  const q = { member: req.member.id };
  if (status && ALLOWED_STATUSES.includes(status)) q.status = status;
  if (source) q.source = source;
  if (fulfillment_type) q.fulfillment_type = fulfillment_type;
  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) q.createdAt = { $lt: d };
  }

  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

  // Pilih hanya field yang diperlukan supaya respon kecil
  const raw = await Order.find(q)
    .select(
      'transaction_code grand_total fulfillment_type customer_name customer_phone placed_at table_number payment_status total_quantity delivery.pickup_window delivery.slot_label status member createdAt delivery.mode verified_by verified_at'
    )
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate({ path: 'member', select: 'name phone' })
    .populate({ path: 'verified_by', select: 'name' }) // <-- ambil nama kasir yg verifikasi
    .lean();

  const items = (Array.isArray(raw) ? raw : []).map((o) => {
    const placedAt = o.placed_at || o.createdAt || null;
    const deliveryMode =
      (o.delivery && o.delivery.mode) ||
      o.delivery?.mode ||
      (o.fulfillment_type === 'dine_in' ? 'none' : 'delivery');

    const memberName =
      o.member && typeof o.member === 'object' ? o.member.name : null;

    return {
      id: String(o._id),
      transaction_code: o.transaction_code || '',
      delivery_mode: deliveryMode,
      grand_total: Number(o.grand_total || 0),
      fulfillment_type: o.fulfillment_type || null,
      customer_name: memberName || o.customer_name || '',
      customer_phone: (o.member && o.member.phone) || o.customer_phone || '',
      placed_at: placedAt,
      table_number:
        o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
      payment_status: o.payment_status || null,
      status: o.status || null,
      total_quantity: Number(o.total_quantity || 0),
      pickup_window:
        o.delivery && o.delivery.pickup_window
          ? {
              from: o.delivery.pickup_window.from || null,
              to: o.delivery.pickup_window.to || null
            }
          : null,
      delivery_slot_label: o.delivery ? o.delivery.slot_label || null : null,
      verified_by: o.verified_by
        ? { id: String(o.verified_by._id), name: o.verified_by.name || '' }
        : null,
      verified_at: o.verified_at || null,
      createdAt: o.createdAt
    };
  });

  const next_cursor = items.length ? items[items.length - 1].createdAt : null;

  return res.status(200).json({
    items,
    next_cursor
  });
});

exports.homeDashboard = asyncHandler(async (req, res) => {
  const startOfDay = dayjs().tz(LOCAL_TZ).startOf('day').toDate();
  const endOfDay = dayjs().tz(LOCAL_TZ).endOf('day').toDate();

  const pipeline = [
    {
      $match: {
        placed_at: { $gte: startOfDay, $lte: endOfDay }
      }
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total_orders: { $sum: 1 },
              total_delivery: {
                $sum: {
                  $cond: [{ $eq: ['$fulfillment_type', 'delivery'] }, 1, 0]
                }
              },
              total_dine_in: {
                $sum: {
                  $cond: [{ $eq: ['$fulfillment_type', 'dine_in'] }, 1, 0]
                }
              },
              total_completed: {
                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
              }
            }
          }
        ],
        omzet: [
          // Omzet: hanya ambil order yang sudah dibayar hari ini
          {
            $match: {
              // payment_status: { $in: ['verified'] },
              payment_status: 'verified',
              paid_at: { $gte: startOfDay, $lte: endOfDay }
            }
          },
          {
            $group: {
              _id: null,
              omzet: { $sum: { $ifNull: ['$grand_total', 0] } }
            }
          }
        ]
      }
    }
  ];

  const result = await Order.aggregate(pipeline).allowDiskUse(true);

  // Default fallback
  let total_orders = 0;
  let total_delivery = 0;
  let total_dine_in = 0;
  let total_completed = 0;
  let omzet = 0;

  if (!Array.isArray(result) || result.length === 0) {
    // tidak perlu error — kembalikan 0 semua
  } else {
    const r = result[0];
    if (Array.isArray(r.totals) && r.totals.length > 0) {
      const t = r.totals[0];
      total_orders = int(t.total_orders || 0);
      total_delivery = int(t.total_delivery || 0);
      total_dine_in = int(t.total_dine_in || 0);
      total_completed = int(t.total_completed || 0);
    }
    if (Array.isArray(r.omzet) && r.omzet.length > 0) {
      omzet = int(r.omzet[0].omzet || 0);
    }
  }

  return res.json({
    success: true,
    date: dayjs(startOfDay).tz(LOCAL_TZ).format('YYYY-MM-DD'),
    totals: {
      total_orders,
      total_delivery,
      total_dine_in,
      total_completed,
      omzet // dalam rupiah (integer)
    }
  });
});

exports.getMyOrder = asyncHandler(async (req, res) => {
  if (!req.member?.id) throwError('Harus login sebagai member', 401);

  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  // ambil order + populate member minimal + items.menu + verified_by
  const order = await Order.findById(id)
    .populate({ path: 'member', select: 'name phone email membershipTier' })
    .populate({
      path: 'items.menu',
      select: 'name imageUrl code price category',
      justOne: false
    })
    .populate({ path: 'verified_by', select: 'name' })
    .lean();
  if (!order) throwError('Order tidak ditemukan', 404);

  // if (String(order.member) !== String(req.member.id)) {
  //   throwError('Tidak berhak mengakses order ini', 403);
  // }

  const safeNumber = (v) => (Number.isFinite(+v) ? +v : 0);
  const intVal = (v) => Math.round(Number(v || 0));
  const int = (v) => intVal(v); // helper local mirip int()

  // --- applied promos normalization (non-redundant, addedFreeItems single source) ---
  const appliedPromos = [];
  const apSource =
    order.appliedPromos ||
    (order.appliedPromo
      ? Array.isArray(order.appliedPromo)
        ? order.appliedPromo
        : [order.appliedPromo]
      : null) ||
    (order.applied_promo
      ? Array.isArray(order.applied_promo)
        ? order.applied_promo
        : [order.applied_promo]
      : null) ||
    null;

  if (Array.isArray(apSource) && apSource.length) {
    for (const ap of apSource) {
      let snap = ap;
      if (ap.promoSnapshot) snap = ap.promoSnapshot;
      if (ap.promo) snap = ap.promo; // legacy

      // ensure single source addedFreeItems
      const addedFreeItems =
        snap.impact &&
        Array.isArray(snap.impact.addedFreeItems) &&
        snap.impact.addedFreeItems.length
          ? snap.impact.addedFreeItems
          : snap.freeItemsSnapshot &&
            Array.isArray(snap.freeItemsSnapshot) &&
            snap.freeItemsSnapshot.length
          ? snap.freeItemsSnapshot.map((f) => ({
              menuId: f.menuId || f._id || null,
              qty: Number(f.qty || 1),
              name: f.name || null,
              imageUrl: f.imageUrl || null,
              category: f.category || null
            }))
          : [];

      const rewards = [];

      // dari actions
      const actions = snap.actions || snap.promoSnapshot?.actions || [];
      if (Array.isArray(actions) && actions.length) {
        for (const a of actions) {
          const t = String(a.type || '').toLowerCase();
          if (t === 'award_points') {
            rewards.push({
              type: 'points',
              amount: Number(a.points ?? a.amount ?? 0),
              label: a.label || 'Poin',
              meta: a.meta || {}
            });
          } else if (t === 'grant_membership') {
            rewards.push({
              type: 'membership',
              amount: null,
              label: a.label || 'Grant membership',
              meta: a.meta || {}
            });
          } else {
            rewards.push({
              type: a.type || 'action',
              amount: a.amount ?? null,
              label: a.label || a.type || 'Reward',
              meta: a.meta || {}
            });
          }
        }
      }

      // dari addedFreeItems
      if (Array.isArray(addedFreeItems) && addedFreeItems.length) {
        for (const f of addedFreeItems) {
          rewards.push({
            type: 'free_item',
            amount: 0,
            label: f.name || `Free item ${f.menuId || ''}`,
            meta: {
              menuId: f.menuId,
              qty: Number(f.qty || 1),
              imageUrl: f.imageUrl || null
            }
          });
        }
      }

      // dari impact discount
      const promoDiscountValue =
        (snap.impact &&
          (snap.impact.itemsDiscount || snap.impact.cartDiscount)) ||
        0;
      if (promoDiscountValue && Number(promoDiscountValue) > 0) {
        rewards.push({
          type: 'discount',
          amount: intVal(promoDiscountValue),
          label: 'Diskon promo',
          meta: { promoId: snap.promoId || snap.id || null }
        });
      }

      appliedPromos.push({
        promoId:
          snap.promoId || snap.promo_id || (snap.id ? String(snap.id) : null),
        name: snap.name || snap.promoName || null,
        description: snap.description || snap.notes || null,
        type: snap.type || null,
        impact: Object.assign({}, snap.impact || {}, {
          addedFreeItems: addedFreeItems
        }),
        actions: actions || [],
        rewards
      });
    }
  }

  // --- applied vouchers normalization (ringkas) ---
  const appliedVouchers = [];
  if (Array.isArray(order.appliedVouchers) && order.appliedVouchers.length) {
    for (const av of order.appliedVouchers) {
      appliedVouchers.push({
        voucherId: av.voucherId
          ? String(av.voucherId)
          : av.voucher
          ? String(av.voucher)
          : null,
        snapshot: av.voucherSnapshot || av.snapshot || av || {}
      });
    }
  } else if (
    Array.isArray(order.applied_voucher_ids) &&
    order.applied_voucher_ids.length
  ) {
    try {
      const vids = order.applied_voucher_ids.map((v) => String(v));
      const Voucher = require('../models/voucherModel');
      const vdocs = await Voucher.find({ _id: { $in: vids } })
        .lean()
        .catch(() => []);
      const vmap = (vdocs || []).reduce((acc, v) => {
        acc[String(v._id)] = v;
        return acc;
      }, {});
      for (const vid of vids) {
        appliedVouchers.push({
          voucherId: String(vid),
          snapshot: vmap[String(vid)] || {}
        });
      }
    } catch (e) {
      for (const vid of order.applied_voucher_ids) {
        appliedVouchers.push({ voucherId: String(vid), snapshot: {} });
      }
    }
  }

  const itemsDetailed = (order.items || []).map((it, idx) => {
    const qty = safeNumber(it.quantity || it.qty || 0);
    const basePrice = safeNumber(
      it.base_price || it.price || it.unit_price || 0
    );
    const addons_unit = (it.addons || []).reduce(
      (s, a) => s + (Number.isFinite(+a.price) ? +a.price : 0) * (a.qty || 1),
      0
    );
    const unit_before_tax = basePrice + addons_unit;
    const line_subtotal = Number(it.line_subtotal ?? unit_before_tax * qty);
    const tax = safeNumber(it.tax_amount || it.tax || 0);
    const itemMenu = it.menu && typeof it.menu === 'object' ? it.menu : null;

    return {
      idx,
      id: it._id ? String(it._id) : null,
      name: it.name || (itemMenu && itemMenu.name) || null,
      menu: it.menu
        ? typeof it.menu === 'string'
          ? String(it.menu)
          : String(it.menu._id || it.menu)
        : null,
      menu_snapshot: itemMenu
        ? {
            name: itemMenu.name,
            imageUrl: itemMenu.imageUrl,
            code: itemMenu.code
          }
        : it.menuSnapshot || it.menu,
      menu_code: it.menu_code || (itemMenu && itemMenu.code) || '',
      imageUrl: it.imageUrl || (itemMenu && itemMenu.imageUrl) || null,
      qty,
      base_price: basePrice,
      unit_before_tax,
      addons: (it.addons || []).map((a) => ({
        id: a._id ? String(a._id) : null,
        name: a.name,
        price: safeNumber(a.price),
        qty: a.qty || 1,
        total: safeNumber(a.price) * (a.qty || 1)
      })),
      notes: it.notes || '',
      adjustments: Array.isArray(it.adjustments) ? it.adjustments : [],
      line_subtotal,
      tax,
      tax_rate_percent: safeNumber(it.tax_rate_percent || null),
      discount: safeNumber(it.line_discount || it.discount || 0),
      final_price: safeNumber(
        it.final_price ?? line_subtotal - (it.line_discount || 0) + tax
      )
    };
  });

  // --- build totals object (sama seperti detail) ---
  const totals = {
    items_subtotal: safeNumber(order.items_subtotal || 0),
    items_discount: safeNumber(order.items_discount || 0),
    service_fee: safeNumber(order.service_fee || 0),
    delivery_fee: safeNumber(order.delivery_fee || 0),
    shipping_discount: safeNumber(order.shipping_discount || 0),
    tax_rate_percent: safeNumber(
      order.tax_rate_percent || Math.round(0.11 * 100)
    ),
    tax_amount: safeNumber(order.tax_amount || 0),
    rounding_delta: safeNumber(order.rounding_delta || 0),
    grand_total: safeNumber(order.grand_total || 0),
    paid_total: safeNumber(order.paid_total || order.grand_total || 0),

    // tambahan points info agar client bisa lihat breakdown
    points_used: safeNumber(order.points_used || 0),
    points_awarded: safeNumber(order.points_awarded || 0)
  };

  // --- Local enrichment for free_item labels using order.items (no DB calls) ---
  try {
    const menuMap = {};
    (order.items || []).forEach((it) => {
      const mid = it.menu || it.menuId || (it.menu && it.menu._id) || null;
      if (!mid) return;
      const key = String(mid);
      if (!menuMap[key]) {
        const mObj = it.menu && typeof it.menu === 'object' ? it.menu : null;
        menuMap[key] = {
          name: it.name || (mObj && mObj.name) || null,
          imageUrl: it.imageUrl || (mObj && mObj.imageUrl) || null,
          code: it.menu_code || (mObj && mObj.code) || null
        };
      }
    });

    // enrich appliedPromos rewards free_item
    for (const ap of appliedPromos) {
      if (!Array.isArray(ap.rewards)) continue;
      for (const r of ap.rewards) {
        if (
          r &&
          String(r.type || '').toLowerCase() === 'free_item' &&
          r.meta &&
          r.meta.menuId
        ) {
          const mid = String(r.meta.menuId);
          const mdoc = menuMap[mid];
          if (mdoc) {
            r.label =
              r.label && r.label !== `Free item ${mid}`
                ? r.label
                : mdoc.name || r.label || `Free item ${mid}`;
            if (!r.meta.imageUrl && mdoc.imageUrl)
              r.meta.imageUrl = mdoc.imageUrl;
            if (!r.meta.menuName && mdoc.name) r.meta.menuName = mdoc.name;
            if (!r.meta.menuCode && mdoc.code) r.meta.menuCode = mdoc.code;
          } else {
            r.label = r.label || `Free item ${mid}`;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[getMyOrder] local enrichment failed', e?.message || e);
  }

  const full = Object.assign({}, order, {
    _id: order._id ? String(order._id) : null,
    id: order._id ? String(order._id) : null,
    member: order.member || null,
    applied_promos: appliedPromos,
    applied_vouchers: appliedVouchers,
    items: itemsDetailed,
    totals,
    payment: {
      method: order.payment_method || null,
      provider: order.payment_provider || null,
      status: order.payment_status || null,
      proof_url: order.payment_proof_url || null,
      paid_at: order.paid_at || null,
      raw: order.payment || null
    }
  });

  return res.status(200).json({ success: true, order: full });
});

exports.previewPrice = asyncHandler(async (req, res) => {
  const {
    cart,
    fulfillmentType = 'dine_in',
    voucherClaimIds = [],
    delivery_mode: deliveryModeFromBody = null,
    selectedPromoId = null,
    usePoints = false,
    applyPromos = true
  } = req.body || {};

  if (!cart?.items?.length) throwError('Cart kosong', 400);

  // resolve identity (support guest)
  const memberId = req.member?.id || null;
  const now = new Date();

  // ===== filter vouchers (guest cannot use vouchers) =====
  let eligible = [];
  if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
    if (!memberId) {
      eligible = [];
    } else {
      const rawClaims = await VoucherClaim.find({
        _id: { $in: voucherClaimIds },
        member: memberId,
        status: 'claimed'
      }).lean();
      eligible = rawClaims
        .filter((c) => !c.validUntil || new Date(c.validUntil) > now)
        .map((c) => String(c._id));
    }
  }

  // ===== delivery mode & fee =====
  const deliveryMode =
    (typeof deliveryModeFromBody === 'string' &&
      deliveryModeFromBody.trim().toLowerCase()) ||
    (fulfillmentType === 'delivery' ? 'delivery' : 'none');

  const envDeliveryFee = Number(process.env.DELIVERY_FLAT_FEE || 0) || 0;
  const effectiveDeliveryFee =
    fulfillmentType === 'delivery' && deliveryMode === 'delivery'
      ? envDeliveryFee
      : 0;

  // ===== normalize cart for engine =====
  const normalizedCart = {
    items: (Array.isArray(cart.items) ? cart.items : []).map((it) => {
      const addons = Array.isArray(it.addons) ? it.addons : [];
      const addonsPerUnit = addons.reduce((s, a) => {
        const ap = Number(a?.price || 0);
        const aq = Number(a?.qty || 1);
        return s + ap * aq;
      }, 0);
      const unitBase = Number(it.base_price ?? it.price ?? it.unit_price ?? 0);
      const unitPrice = Math.round(unitBase + addonsPerUnit);
      return {
        menuId: it.menu || it.menuId || it.id || null,
        qty: Number(it.quantity ?? it.qty ?? 0),
        price: unitPrice,
        category: it.category ?? it.cat ?? null,
        name: it.name || null
      };
    })
  };

  // ===== optional MemberDoc for fetchers =====
  let MemberDoc = null;
  if (memberId) {
    MemberDoc = await Member.findById(memberId)
      .lean()
      .catch(() => null);
  }

  // ===== promo usage fetchers =====
  const promoUsageFetchers = {
    getMemberUsageCount: async (promoId, mId, sinceDate) => {
      try {
        if (!mId) return 0;
        if (MemberDoc && Array.isArray(MemberDoc.promoUsageHistory)) {
          return MemberDoc.promoUsageHistory.filter(
            (h) =>
              String(h.promoId) === String(promoId) &&
              new Date(h.usedAt || h.date) >= sinceDate
          ).length;
        }
        const q = {
          'appliedPromo.promoId': promoId,
          member: mId,
          createdAt: { $gte: sinceDate }
        };
        return await Order.countDocuments(q);
      } catch (e) {
        return 0;
      }
    },
    getGlobalUsageCount: async (promoId, sinceDate) => {
      try {
        const q = {
          'appliedPromo.promoId': promoId,
          createdAt: { $gte: sinceDate }
        };
        return await Order.countDocuments(q);
      } catch (e) {
        return 0;
      }
    }
  };

  // ===== eligiblePromos list (for FE summary) =====
  let eligiblePromosList = [];
  if (applyPromos) {
    try {
      eligiblePromosList = await findApplicablePromos(
        normalizedCart,
        MemberDoc,
        now,
        { fetchers: promoUsageFetchers }
      );
    } catch (e) {
      eligiblePromosList = [];
    }
  } else {
    eligiblePromosList = [];
  }

  // ===== autoApplied suggestion (pick highest priority autoApply) =====
  let autoAppliedPromo = null;
  if (
    applyPromos &&
    Array.isArray(eligiblePromosList) &&
    eligiblePromosList.length
  ) {
    try {
      const autos = eligiblePromosList.filter((p) => !!p.autoApply);
      if (autos.length) {
        autos.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
        const chosen = autos[0];
        const { impact, actions } = await applyPromo(chosen, normalizedCart);
        autoAppliedPromo = {
          promoId: String(chosen._id),
          name: chosen.name || null,
          impact,
          actions: actions || []
        };
      }
    } catch (e) {
      autoAppliedPromo = null;
    }
  }

  // ---- select promo for engine
  const selectedForEngine = applyPromos
    ? selectedPromoId ||
      (autoAppliedPromo ? String(autoAppliedPromo.promoId) : null)
    : null;
  const autoApplyForEngine = applyPromos
    ? selectedForEngine
      ? false
      : true
    : false;

  // ===== call engine =====
  let result;
  try {
    result = await applyPromoThenVoucher({
      memberId,
      memberDoc: MemberDoc || null,
      cart: normalizedCart,
      fulfillmentType,
      deliveryFee:
        fulfillmentType === 'delivery' ? Number(effectiveDeliveryFee || 0) : 0,
      voucherClaimIds: eligible,
      selectedPromoId: selectedForEngine,
      autoApplyPromo: autoApplyForEngine,
      promoUsageFetchers
    });
  } catch (err) {
    throwError(
      err?.message
        ? `Gagal menghitung preview harga: ${String(err.message)}`
        : 'Gagal menghitung preview harga',
      err?.status || 500
    );
  }

  if (!result || !result.ok) {
    throwError(
      (result && result.reasons && result.reasons.join?.(', ')) ||
        'Gagal menghitung harga (engine)',
      400
    );
  }

  // ===== build ui_totals (single-source grand_total + rounding) =====
  const t = result.totals || result.voucherResult?.totals || {};

  const baseSubtotal = Number(t.baseSubtotal ?? t.base_subtotal ?? 0);
  const itemsDiscount = Number(t.itemsDiscount ?? t.items_discount ?? 0);
  const items_subtotal_after_discount = Number(
    t.items_subtotal_after_discount ??
      t.baseSubtotalAfterDiscount ??
      Math.max(0, baseSubtotal - itemsDiscount)
  );
  const shippingDiscount = Number(
    t.shippingDiscount ?? t.shipping_discount ?? 0
  );

  // deliveryFee: prefer engine, fallback effectiveDeliveryFee
  const deliveryFeeFromEngine = Number(
    t.deliveryFee ?? t.delivery_fee ?? effectiveDeliveryFee ?? 0
  );
  const deliveryFee = Number.isFinite(deliveryFeeFromEngine)
    ? deliveryFeeFromEngine
    : Number(effectiveDeliveryFee || 0);

  // taxable items (same logic as order compute)
  const taxableItems = Math.max(0, baseSubtotal - itemsDiscount);
  const service_fee = Math.round(taxableItems * SERVICE_FEE_RATE);
  const tax_amount = Math.round(taxableItems * parsePpnRate());

  // raw before rounding & before points (this is pre-rounding value)
  const raw_before_points = Math.round(
    taxableItems + service_fee + deliveryFee - shippingDiscount + tax_amount
  );

  const grand_before_points = roundRupiahCustom(Math.round(raw_before_points));

  const memberPoints = Math.floor(Number(MemberDoc?.points || 0));
  const points_used = usePoints
    ? Math.min(memberPoints, Math.max(0, Math.round(grand_before_points)))
    : 0;

  const raw_after_points = Math.max(
    0,
    Math.round(grand_before_points) - points_used
  );

  const grand_total = roundRupiahCustom(Math.round(raw_after_points));

  const rounding_delta_pre =
    Number(grand_before_points) - Math.round(raw_before_points);
  const rounding_delta_after =
    Number(grand_total) - Math.round(raw_after_points);
  const rounding_delta_total =
    Number(rounding_delta_pre || 0) + Number(rounding_delta_after || 0);

  const ui_totals = {
    items_subtotal: int(baseSubtotal),
    items_discount: int(itemsDiscount),
    items_subtotal_after_discount: int(items_subtotal_after_discount),
    service_fee: int(service_fee),
    tax_amount: int(tax_amount),
    delivery_fee: int(deliveryFee),
    shipping_discount: int(shippingDiscount),
    points_used: int(points_used),
    grand_total: int(grand_total),
    raw_total_before_rounding: int(raw_before_points),
    grand_total_before_points: int(grand_before_points),
    raw_total_after_points_before_rounding: int(raw_after_points),
    rounding_delta: int(rounding_delta_total)
  };

  // ===== promo / rewards normalization =====
  const appliedPromo = result.promoApplied || null;
  const engineRewards = Array.isArray(result.promoRewards)
    ? result.promoRewards
    : [];
  const pointsTotalFromEngine =
    (result.points_awarded_details && result.points_awarded_details.total) ||
    (Array.isArray(result.promoApplied?.actions)
      ? result.promoApplied.actions
          .filter((a) => String(a.type || '').toLowerCase() === 'award_points')
          .reduce((s, a) => s + Number(a.points ?? a.amount ?? 0), 0)
      : 0);

  const normalizedRewards = [];
  if (engineRewards.length) {
    for (const r of engineRewards) {
      normalizedRewards.push({
        type: r.type || 'unknown',
        amount: r.amount ?? null,
        label: r.label || null,
        meta: r.meta || {}
      });
    }
  } else if (appliedPromo) {
    if (appliedPromo.actions && Array.isArray(appliedPromo.actions)) {
      for (const a of appliedPromo.actions) {
        if (String(a.type || '').toLowerCase() === 'award_points') {
          normalizedRewards.push({
            type: 'points',
            amount: Number(a.points ?? a.amount ?? 0),
            label: 'Poin',
            meta: a.meta || {}
          });
        } else {
          normalizedRewards.push({
            type: a.type || 'action',
            amount: a.amount ?? null,
            label: a.label || null,
            meta: a.meta || {}
          });
        }
      }
    }
    if (
      appliedPromo.impact &&
      Array.isArray(appliedPromo.impact.addedFreeItems)
    ) {
      for (const f of appliedPromo.impact.addedFreeItems) {
        normalizedRewards.push({
          type: 'free_item',
          amount: 0,
          label: f.name || `Free item ${f.menuId || ''}`,
          meta: { menuId: f.menuId, qty: Number(f.qty || 1) }
        });
      }
    }
  }

  const eligiblePromosSummary = (eligiblePromosList || []).map((p) => ({
    id: String(p._id),
    name: p.name,
    type: p.type,
    autoApply: !!p.autoApply,
    priority: Number(p.priority || 0)
  }));

  const promoCompact = {
    appliedPromoId: appliedPromo ? appliedPromo.promoId : null,
    appliedPromoName: appliedPromo ? appliedPromo.name || null : null,
    description: appliedPromo ? appliedPromo.description || null : null,
    rewards: normalizedRewards,
    points_total: Number(pointsTotalFromEngine || 0),
    chosenClaimIds: result.chosenClaimIds || []
  };

  return res.status(200).json({
    ok: true,
    reasons: result.reasons || result.voucherResult?.reasons || [],
    eligiblePromosCount: eligiblePromosList.length,
    eligiblePromos: eligiblePromosSummary,
    promo: promoCompact,
    voucher: { chosenClaimIds: result.chosenClaimIds || [] },
    ui_totals,
    member_points: Number(MemberDoc?.points || 0),
    guest: !memberId,
    applied_promos_enabled: !!applyPromos
  });
});

exports.listOrders = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    status,
    payment_status,
    table,
    from,
    to,
    limit = 50,
    cursor,
    source,
    fulfillment_type
  } = req.query || {};

  const q = {};
  if (status)
    q.status = Array.isArray(status)
      ? { $in: status.filter((s) => ALLOWED_STATUSES.includes(s)) }
      : status;
  if (payment_status && ALLOWED_PAY_STATUS.includes(payment_status))
    q.payment_status = payment_status;
  if (table) q.table_number = Number(table);
  if (source) q.source = source;
  if (fulfillment_type) q.fulfillment_type = fulfillment_type;

  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }
  if (cursor) q.createdAt = { ...(q.createdAt || {}), $lt: new Date(cursor) };

  const lim = Math.min(parseInt(limit, 10) || 50, 200);

  const raw = await Order.find(q)
    .select(
      'transaction_code grand_total fulfillment_type customer_name customer_phone placed_at table_number payment_status total_quantity delivery.pickup_window delivery.slot_label status member createdAt delivery.mode ownerVerified verified_by verified_at'
    )
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate({ path: 'member', select: 'name phone' })
    .populate({ path: 'verified_by', select: 'name' }) // <-- kasir verifikator
    .lean();

  // Hitung batas hari ini (timezone Jakarta)
  const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
  const jNow = new Date(Date.now() + JAKARTA_OFFSET_MS);
  const Y = jNow.getUTCFullYear();
  const M = jNow.getUTCMonth();
  const D = jNow.getUTCDate();
  const startOfTodayJakartaMs = Date.UTC(Y, M, D) - JAKARTA_OFFSET_MS;
  const endOfTodayJakartaMs = startOfTodayJakartaMs + 86400000;

  const today = [];
  const other = [];

  const mapped = (Array.isArray(raw) ? raw : []).map((o) => {
    const placedAt = o.placed_at || o.createdAt || null;
    const placedMs = placedAt ? new Date(placedAt).getTime() : null;

    const out = {
      id: String(o._id),
      transaction_code: o.transaction_code || '',
      delivery_mode:
        (o.delivery && o.delivery.mode) ||
        o.delivery?.mode ||
        (o.fulfillment_type === 'dine_in' ? 'none' : 'delivery'),
      grand_total: Number(o.grand_total || 0),
      fulfillment_type: o.fulfillment_type || null,
      customer_name: o.member?.name || o.customer_name || '',
      customer_phone: o.member?.phone || o.customer_phone || '',
      placed_at: placedAt,
      table_number:
        o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
      payment_status: o.payment_status || null,
      ownerVerified: o.ownerVerified,
      status: o.status || null,
      total_quantity: Number(o.total_quantity || 0),
      pickup_window: o.delivery?.pickup_window
        ? {
            from: o.delivery.pickup_window.from || null,
            to: o.delivery.pickup_window.to || null
          }
        : null,
      delivery_slot_label: o.delivery?.slot_label || null,
      member_id: o.member ? String(o.member._id) : null,
      verified_by: o.verified_by
        ? { id: String(o.verified_by._id), name: o.verified_by.name || '' }
        : null,
      verified_at: o.verified_at || null,
      createdAt: o.createdAt
    };

    // klasifikasi today / other
    if (
      placedMs !== null &&
      placedMs >= startOfTodayJakartaMs &&
      placedMs < endOfTodayJakartaMs
    ) {
      today.push(out);
    } else {
      other.push(out);
    }

    return out;
  });

  // next cursor dari yang paling lama (other)
  const next_cursor =
    other.length > 0
      ? new Date(
          other[other.length - 1].placed_at || other[other.length - 1].createdAt
        ).toISOString()
      : null;

  return res.status(200).json({
    today,
    other,
    next_cursor
  });
});

exports.dineInBoard = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    status,
    payment_status,
    table,
    from,
    to,
    limit = 50,
    cursor,
    source
    // note: kita tidak menerima fulfillment_type dari client; selalu dine_in
  } = req.query || {};

  const q = { fulfillment_type: 'dine_in' }; // <-- dipaksa dine_in

  if (status)
    q.status = Array.isArray(status)
      ? { $in: status.filter((s) => ALLOWED_STATUSES.includes(s)) }
      : status;
  if (payment_status && ALLOWED_PAY_STATUS.includes(payment_status))
    q.payment_status = payment_status;
  if (table) q.table_number = Number(table);
  if (source) q.source = source;

  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }
  if (cursor) q.createdAt = { ...(q.createdAt || {}), $lt: new Date(cursor) };

  // safety cap limit
  const lim = Math.min(parseInt(limit, 10) || 50, 200);

  // Pilih hanya field yang diperlukan untuk response ringkas
  const raw = await Order.find(q)
    .select(
      'transaction_code grand_total fulfillment_type customer_name customer_phone placed_at table_number payment_status total_quantity delivery.pickup_window delivery.slot_label status member createdAt delivery.mode ownerVerified'
    )
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate({ path: 'member', select: 'name phone' })
    .lean();

  // Map ke bentuk yang sama seperti listOrders
  const items = (Array.isArray(raw) ? raw : []).map((o) => ({
    id: String(o._id),
    transaction_code: o.transaction_code || '',
    delivery_mode:
      (o.delivery && o.delivery.mode) ||
      o.delivery?.mode ||
      (o.fulfillment_type === 'dine_in' ? 'none' : 'delivery'),
    grand_total: Number(o.grand_total || 0),
    fulfillment_type: o.fulfillment_type || null,
    customer_name: (o.member && o.member.name) || o.customer_name || '',
    customer_phone: (o.member && o.member.phone) || o.customer_phone || '',
    placed_at: o.placed_at || o.createdAt || null,
    table_number:
      o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
    payment_status: o.payment_status || null,
    ownerVerified: o.ownerVerified,
    status: o.status || null,
    total_quantity: Number(o.total_quantity || 0),
    pickup_window:
      o.delivery && o.delivery.pickup_window
        ? {
            from: o.delivery.pickup_window.from || null,
            to: o.delivery.pickup_window.to || null
          }
        : null,
    delivery_slot_label: o.delivery ? o.delivery.slot_label || null : null,
    member_id: o.member ? String(o.member._id) : null
  }));

  return res.status(200).json({
    items,
    next_cursor: items.length
      ? new Date(
          items[items.length - 1].placed_at || raw[items.length - 1].createdAt
        ).toISOString()
      : null
  });
});

exports.getDetailOrder = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!req.user) throwError('Unauthorized', 401);
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const order = await Order.findById(id)
    .populate({ path: 'member', select: 'name phone email membershipTier' })
    .populate({
      path: 'items.menu',
      select: 'name imageUrl code price category',
      justOne: false
    })
    .lean();
  if (!order) throwError('Order tidak ditemukan', 404);

  const safeNumber = (v) => (Number.isFinite(+v) ? +v : 0);
  const intVal = (v) => Math.round(Number(v || 0));
  const int = (v) => intVal(v); // helper local mirip int()

  // --- build itemsDetailed (mirip implementasimu sebelumnya) ---
  const itemsDetailed = (order.items || []).map((it, idx) => {
    const qty = safeNumber(it.quantity || it.qty || 0);
    const basePrice = safeNumber(
      it.base_price || it.price || it.unit_price || 0
    );
    const addons_unit = (it.addons || []).reduce(
      (s, a) => s + (Number.isFinite(+a.price) ? +a.price : 0) * (a.qty || 1),
      0
    );
    const unit_before_tax = basePrice + addons_unit;
    const line_subtotal = Number(it.line_subtotal ?? unit_before_tax * qty);
    const tax = safeNumber(it.tax_amount || it.tax || 0);
    const itemMenu = it.menu && typeof it.menu === 'object' ? it.menu : null;

    return {
      idx,
      id: it._id ? String(it._id) : null,
      name: it.name || (itemMenu && itemMenu.name) || null,
      menu: it.menu
        ? typeof it.menu === 'string'
          ? String(it.menu)
          : String(it.menu._id || it.menu)
        : null,
      menu_snapshot: itemMenu
        ? {
            name: itemMenu.name,
            imageUrl: itemMenu.imageUrl,
            code: itemMenu.code
          }
        : it.menuSnapshot || it.menu,
      menu_code: it.menu_code || (itemMenu && itemMenu.code) || '',
      imageUrl: it.imageUrl || (itemMenu && itemMenu.imageUrl) || null,
      qty,
      base_price: basePrice,
      unit_before_tax,
      addons: (it.addons || []).map((a) => ({
        id: a._id ? String(a._id) : null,
        name: a.name,
        price: safeNumber(a.price),
        qty: a.qty || 1,
        total: safeNumber(a.price) * (a.qty || 1)
      })),
      notes: it.notes || '',
      adjustments: Array.isArray(it.adjustments) ? it.adjustments : [],
      line_subtotal,
      tax,
      tax_rate_percent: safeNumber(it.tax_rate_percent || null),
      discount: safeNumber(it.line_discount || it.discount || 0),
      final_price: safeNumber(
        it.final_price ?? line_subtotal - (it.line_discount || 0) + tax
      )
    };
  });

  // --- normalize appliedPromos (support various shapes) ---
  const appliedPromos = [];
  const apSource =
    order.appliedPromos ||
    (order.appliedPromo
      ? Array.isArray(order.appliedPromo)
        ? order.appliedPromo
        : [order.appliedPromo]
      : null) ||
    (order.applied_promo
      ? Array.isArray(order.applied_promo)
        ? order.applied_promo
        : [order.applied_promo]
      : null) ||
    null;

  if (Array.isArray(apSource) && apSource.length) {
    for (const apRaw of apSource) {
      let snap = apRaw;
      if (apRaw.promoSnapshot) snap = apRaw.promoSnapshot;
      if (apRaw.promo) snap = apRaw.promo;

      if (!snap) continue;

      const addedFreeItems =
        snap.impact &&
        Array.isArray(snap.impact.addedFreeItems) &&
        snap.impact.addedFreeItems.length
          ? snap.impact.addedFreeItems
          : snap.freeItemsSnapshot &&
            Array.isArray(snap.freeItemsSnapshot) &&
            snap.freeItemsSnapshot.length
          ? snap.freeItemsSnapshot.map((f) => ({
              menuId: f.menuId || f._id || null,
              qty: Number(f.qty || 1),
              name: f.name || null,
              imageUrl: f.imageUrl || null,
              category: f.category || null
            }))
          : [];

      const rewards = [];

      const actions = snap.actions || snap.promoSnapshot?.actions || [];
      if (Array.isArray(actions) && actions.length) {
        for (const a of actions) {
          const t = String(a.type || '').toLowerCase();
          if (t === 'award_points') {
            rewards.push({
              type: 'points',
              amount: Number(a.points ?? a.amount ?? 0),
              label: a.label || 'Poin',
              meta: a.meta || {}
            });
          } else if (t === 'grant_membership') {
            rewards.push({
              type: 'membership',
              amount: null,
              label: a.label || 'Grant membership',
              meta: a.meta || {}
            });
          } else {
            rewards.push({
              type: a.type || 'action',
              amount: a.amount ?? null,
              label: a.label || a.type || 'Reward',
              meta: a.meta || {}
            });
          }
        }
      }

      if (Array.isArray(addedFreeItems) && addedFreeItems.length) {
        for (const f of addedFreeItems) {
          rewards.push({
            type: 'free_item',
            amount: 0,
            label: f.name || `Free item ${f.menuId || ''}`,
            meta: {
              menuId: f.menuId,
              qty: Number(f.qty || 1),
              imageUrl: f.imageUrl || null,
              category: f.category || null
            }
          });
        }
      }

      const promoDiscountValue =
        (snap.impact &&
          (snap.impact.itemsDiscount || snap.impact.cartDiscount)) ||
        0;
      if (promoDiscountValue && Number(promoDiscountValue) > 0) {
        rewards.push({
          type: 'discount',
          amount: intVal(promoDiscountValue),
          label: 'Diskon promo',
          meta: { promoId: snap.promoId || snap.id || null }
        });
      }

      appliedPromos.push({
        promoId:
          snap.promoId || snap.promo_id || (snap.id ? String(snap.id) : null),
        name: snap.name || snap.promoName || null,
        description: snap.description || snap.notes || null,
        // pastikan type terisi dari snapshot/fallback
        type: snap.type || snap.promoSnapshot?.type || snap.promoType || null,
        impact: Object.assign({}, snap.impact || {}, { addedFreeItems }),
        actions: actions || [],
        rewards
      });
    }
  }

  // --- normalize appliedVouchers ---
  const appliedVouchers = [];
  if (Array.isArray(order.appliedVouchers) && order.appliedVouchers.length) {
    for (const av of order.appliedVouchers) {
      appliedVouchers.push({
        voucherId: av.voucherId
          ? String(av.voucherId)
          : av.voucher
          ? String(av.voucher)
          : null,
        snapshot: av.voucherSnapshot || av.snapshot || av || {}
      });
    }
  } else if (
    Array.isArray(order.applied_voucher_ids) &&
    order.applied_voucher_ids.length
  ) {
    // best-effort: include ids only
    for (const vid of order.applied_voucher_ids) {
      appliedVouchers.push({ voucherId: String(vid), snapshot: {} });
    }
  }

  // --- build totals object (mirip sebelumnya) ---
  const totals = {
    items_subtotal: safeNumber(order.items_subtotal || 0),
    items_discount: safeNumber(order.items_discount || 0),
    service_fee: safeNumber(order.service_fee || 0),
    delivery_fee: safeNumber(order.delivery_fee || 0),
    shipping_discount: safeNumber(order.shipping_discount || 0),
    tax_rate_percent: safeNumber(
      order.tax_rate_percent || Math.round(0.11 * 100)
    ),
    tax_amount: safeNumber(order.tax_amount || 0),
    rounding_delta: safeNumber(order.rounding_delta || 0),
    grand_total: safeNumber(order.grand_total || 0),
    paid_total: safeNumber(order.paid_total || order.grand_total || 0)
  };

  // --- Local enrichment for free_item labels using order.items (no DB calls) ---
  try {
    const menuMap = {};
    (order.items || []).forEach((it) => {
      const mid = it.menu || it.menuId || (it.menu && it.menu._id) || null;
      if (!mid) return;
      const key = String(mid);
      if (!menuMap[key]) {
        const mObj = it.menu && typeof it.menu === 'object' ? it.menu : null;
        menuMap[key] = {
          name: it.name || (mObj && mObj.name) || null,
          imageUrl: it.imageUrl || (mObj && mObj.imageUrl) || null,
          code: it.menu_code || (mObj && mObj.code) || null
        };
      }
    });

    // enrich appliedPromos rewards free_item
    for (const ap of appliedPromos) {
      if (!Array.isArray(ap.rewards)) continue;
      for (const r of ap.rewards) {
        if (
          r &&
          String(r.type || '').toLowerCase() === 'free_item' &&
          r.meta &&
          r.meta.menuId
        ) {
          const mid = String(r.meta.menuId);
          const mdoc = menuMap[mid];
          if (mdoc) {
            r.label =
              r.label && r.label !== `Free item ${mid}`
                ? r.label
                : mdoc.name || r.label || `Free item ${mid}`;
            if (!r.meta.imageUrl && mdoc.imageUrl)
              r.meta.imageUrl = mdoc.imageUrl;
            if (!r.meta.menuName && mdoc.name) r.meta.menuName = mdoc.name;
            if (!r.meta.menuCode && mdoc.code) r.meta.menuCode = mdoc.code;
          } else {
            // fallback: leave label as-is
            r.label = r.label || `Free item ${mid}`;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[getDetailOrder] local enrichment failed', e?.message || e);
  }

  // --- susun full response (TANPA discounts_internal) ---
  const full = Object.assign({}, order, {
    _id: order._id ? String(order._id) : null,
    id: order._id ? String(order._id) : null,
    member: order.member || null,
    applied_promos: appliedPromos,
    applied_vouchers: appliedVouchers,
    items: itemsDetailed,
    totals,
    payment: {
      method: order.payment_method || null,
      provider: order.payment_provider || null,
      status: order.payment_status || null,
      proof_url: order.payment_proof_url || null,
      paid_at: order.paid_at || null,
      raw: order.payment || null
    }
  });

  full.delivery = full.delivery || {};
  full.delivery.proof_url = order.delivery?.delivery_proof_url || null;

  return res.status(200).json({ success: true, order: full });
});

const buildOrderReceipt = (order) => {
  if (!order) return null;

  const displayName = order.member?.name || order.customer_name || '';
  const displayPhone = order.member?.phone || order.customer_phone || '';

  const snapshotUi = order.orderPriceSnapshot?.ui_totals || null;

  const items = Array.isArray(order.items) ? order.items : [];

  const computeLineSubtotal = (it) => {
    const unitBase = Number(it.base_price || 0);
    const addonsUnit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const qty = Number(it.quantity || it.qty || 0);
    return int((unitBase + addonsUnit) * qty);
  };

  // fallback subtotal dari items (termasuk addons)
  const items_subtotal_fallback = items.reduce(
    (s, it) => s + computeLineSubtotal(it),
    0
  );

  // ambil items_subtotal authoritative: prioritas snapshot.ui_totals, lalu order.items_subtotal, lalu computed fallback
  const items_subtotal_fromOrder = int(
    order.items_subtotal ?? items_subtotal_fallback
  );
  const items_subtotal = snapshotUi
    ? int(snapshotUi.items_subtotal ?? items_subtotal_fromOrder)
    : Math.max(items_subtotal_fromOrder, items_subtotal_fallback);

  // ambil discount & subtotal after discount dari snapshot bila ada
  const items_discount = snapshotUi
    ? int(snapshotUi.items_discount ?? order.items_discount ?? 0)
    : int(order.items_discount ?? 0);
  const items_subtotal_after_discount = snapshotUi
    ? int(
        snapshotUi.items_subtotal_after_discount ??
          Math.max(0, items_subtotal - items_discount)
      )
    : Math.max(0, items_subtotal - items_discount);

  // delivery fee (prefer snapshot), shipping discount etc.
  const delivery_fee = snapshotUi
    ? int(
        snapshotUi.delivery_fee ??
          order.delivery_fee ??
          order.delivery?.delivery_fee ??
          0
      )
    : int(order.delivery_fee ?? order.delivery?.delivery_fee ?? 0);

  const delivery_fee_raw = snapshotUi
    ? int(
        snapshotUi.delivery_fee ??
          order.delivery?.delivery_fee_raw ??
          order.delivery_fee ??
          0
      )
    : int(order.delivery?.delivery_fee_raw ?? order.delivery_fee ?? 0);

  const shipping_discount = snapshotUi
    ? int(snapshotUi.shipping_discount ?? order.shipping_discount ?? 0)
    : int(order.shipping_discount ?? 0);

  // service_fee & tax dari snapshot (jika ada) agar persis sama dengan UI
  const service_fee = snapshotUi
    ? int(
        snapshotUi.service_fee ??
          order.service_fee ??
          Math.round(items_subtotal_after_discount * SERVICE_FEE_RATE)
      )
    : int(
        order.service_fee ??
          Math.round(items_subtotal_after_discount * SERVICE_FEE_RATE)
      );

  const tax_amount = snapshotUi
    ? int(
        snapshotUi.tax_amount ??
          order.tax_amount ??
          Math.round(items_subtotal_after_discount * parsePpnRate())
      )
    : int(
        order.tax_amount ??
          Math.round(items_subtotal_after_discount * parsePpnRate())
      );

  const tax_rate_percent = snapshotUi
    ? Number(snapshotUi.tax_rate_percent ?? Math.round(parsePpnRate() * 100))
    : Number(order.tax_rate_percent ?? Math.round(parsePpnRate() * 100));

  // rounding & grand total (prefer snapshot)
  const rounding_delta = snapshotUi
    ? int(snapshotUi.rounding_delta ?? order.rounding_delta ?? 0)
    : int(order.rounding_delta ?? 0);

  const grand_total = snapshotUi
    ? int(
        snapshotUi.grand_total ??
          order.grand_total ??
          roundRupiahCustom(
            items_subtotal_after_discount +
              service_fee +
              (delivery_fee_raw || delivery_fee) -
              shipping_discount +
              tax_amount
          )
      )
    : int(
        order.grand_total ??
          roundRupiahCustom(
            items_subtotal_after_discount +
              service_fee +
              (delivery_fee_raw || delivery_fee) -
              shipping_discount +
              tax_amount
          )
      );

  const raw_total_before_rounding = int(
    items_subtotal_after_discount +
      service_fee +
      (delivery_fee_raw || delivery_fee) -
      shipping_discount +
      tax_amount
  );

  // ------- per-item detailed view (sertakan adjustments jika ada) -------
  const detailedItems = items.map((it) => {
    const qty = Number(it.quantity || it.qty || 0);
    const unit_base = Number(it.base_price || 0);
    const addons_unit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const unit_before_tax = int(unit_base + addons_unit);
    const line_before_tax = int(it.line_subtotal ?? computeLineSubtotal(it));

    // adjustments array on item (engine provides adjustments per menuId)
    const adjustmentsRaw = Array.isArray(it.adjustments)
      ? it.adjustments
      : it._adjustments || [];
    const adjustments = (adjustmentsRaw || []).map((a) => ({
      type: a.type || 'promo',
      amount: int(a.amount || 0),
      reason: a.reason || a.label || '',
      promoId: a.promoId || a.promo || null,
      voucherClaimId: a.voucherClaimId || a.claimId || null,
      qty: Number(a.qty || 0)
    }));

    const adjTotal = (adjustments || []).reduce(
      (s, a) => s + Number(a.amount || 0),
      0
    );

    return {
      name: it.name,
      menu_code: it.menu_code || it.menuCode || '',
      quantity: qty,
      addons: (it.addons || []).map((ad) => ({
        name: ad.name,
        price: int(ad.price || 0),
        qty: int(ad.qty || 1)
      })),
      unit_price: unit_before_tax,
      line_before_tax,
      adjustments,
      line_total_after_adjustments: Math.max(0, int(line_before_tax - adjTotal))
    };
  });

  // ------- applied promos & vouchers summary -------
  const appliedPromo = order.appliedPromo || order.applied_promo || null;
  const appliedPromos = [];
  if (appliedPromo) {
    const ap =
      appliedPromo.promoSnapshot || appliedPromo.promoSnapshot || appliedPromo;

    if (ap) {
      const normalizedRewards = [];

      if (ap.actions && Array.isArray(ap.actions)) {
        for (const a of ap.actions) {
          const t = String(a.type || '').toLowerCase();
          if (t === 'award_points') {
            normalizedRewards.push({
              type: 'points',
              amount: Number(a.points ?? a.amount ?? 0),
              label: a.label || 'Poin',
              meta: a.meta || {}
            });
          } else if (t === 'grant_membership') {
            normalizedRewards.push({
              type: 'membership',
              amount: null,
              label: a.label || 'Grant membership',
              meta: a.meta || {}
            });
          } else {
            normalizedRewards.push({
              type: a.type || 'action',
              amount: a.amount ?? null,
              label: a.label || a.type || 'Reward',
              meta: a.meta || {}
            });
          }
        }
      }

      if (ap.impact && Array.isArray(ap.impact.addedFreeItems)) {
        for (const f of ap.impact.addedFreeItems) {
          normalizedRewards.push({
            type: 'free_item',
            amount: 0,
            label: f.name || `Free item ${f.menuId || ''}`,
            meta: { menuId: f.menuId, qty: Number(f.qty || 1) }
          });
        }
      }

      const promoDiscountValue =
        (ap.impact && (ap.impact.itemsDiscount || ap.impact.cartDiscount)) || 0;
      if (promoDiscountValue && Number(promoDiscountValue) > 0) {
        normalizedRewards.push({
          type: 'discount',
          amount: int(promoDiscountValue),
          label: 'Diskon promo',
          meta: { promoId: ap.promoId || ap.id || null }
        });
      }

      appliedPromos.push({
        promoId:
          ap.promoId || ap.promo_id || (ap.id ? String(ap.id) : null) || null,
        name: ap.name || ap.promoName || null,
        description: ap.description || ap.notes || null,
        type: ap.type || ap.promoSnapshot?.type || ap.promoType || null,
        rewards: normalizedRewards,
        impact: ap.impact || {},
        actions: ap.actions || []
      });
    }
  }

  // vouchers summary
  const appliedVoucherEntries = [];
  if (Array.isArray(order.appliedVouchers) && order.appliedVouchers.length) {
    for (const av of order.appliedVouchers) {
      appliedVoucherEntries.push({
        voucherId: av.voucherId
          ? String(av.voucherId)
          : av.voucher
          ? String(av.voucher)
          : null,
        snapshot: av.voucherSnapshot || av.snapshot || {}
      });
    }
  } else if (
    Array.isArray(order.applied_voucher_ids) &&
    order.applied_voucher_ids.length
  ) {
    for (const vid of order.applied_voucher_ids) {
      appliedVoucherEntries.push({ voucherId: String(vid), snapshot: {} });
    }
  }

  // free items summary
  const free_items = (order.items || [])
    .filter(
      (it) => Number(it.price || it.unit_price || it.base_price || 0) === 0
    )
    .map((it) => ({
      menuId: it.menu || it.menuId || null,
      name: it.name || it.title || 'Free item',
      qty: Number(it.quantity || it.qty || 1),
      imageUrl: it.imageUrl || null
    }));

  // (local enrichment unchanged) build menuMap and enrich rewards...
  const menuMap = {};
  for (const it of items) {
    const mid = it.menu || it.menuId || (it.menu && it.menu._id) || null;
    if (!mid) continue;
    const key = String(mid);
    if (!menuMap[key]) {
      const mObj = it.menu && typeof it.menu === 'object' ? it.menu : null;
      menuMap[key] = {
        name: it.name || (mObj && mObj.name) || null,
        imageUrl: it.imageUrl || (mObj && mObj.imageUrl) || null,
        code: it.menu_code || (mObj && mObj.code) || null
      };
    }
  }

  for (const ap of appliedPromos) {
    if (!Array.isArray(ap.rewards)) continue;
    for (const r of ap.rewards) {
      if (
        r &&
        String(r.type || '').toLowerCase() === 'free_item' &&
        r.meta &&
        r.meta.menuId
      ) {
        const mid = String(r.meta.menuId);
        const mdoc = menuMap[mid];
        if (mdoc) {
          r.label =
            r.label && r.label !== `Free item ${mid}`
              ? r.label
              : mdoc.name || r.label || `Free item ${mid}`;
          if (!r.meta.imageUrl && mdoc.imageUrl)
            r.meta.imageUrl = mdoc.imageUrl;
          if (!r.meta.menuName && mdoc.name) r.meta.menuName = mdoc.name;
          if (!r.meta.menuCode && mdoc.code) r.meta.menuCode = mdoc.code;
        } else {
          const found = free_items.find((f) => String(f.menuId) === mid);
          if (found) {
            r.label =
              r.label && r.label !== `Free item ${mid}`
                ? r.label
                : found.name || r.label || `Free item ${mid}`;
            if (!r.meta.imageUrl && found.imageUrl)
              r.meta.imageUrl = found.imageUrl;
            if (!r.meta.menuName && found.name) r.meta.menuName = found.name;
          } else {
            r.label = r.label || `Free item ${mid}`;
          }
        }
      }
    }
  }

  for (const f of free_items) {
    if (f.menuId) {
      const mdoc = menuMap[String(f.menuId)];
      if (mdoc && (!f.name || f.name === 'Free item')) {
        f.name = mdoc.name || f.name;
        if (!f.imageUrl && mdoc.imageUrl) f.imageUrl = mdoc.imageUrl;
      }
    }
  }

  // ------- final receipt object (tambahkan points_used) -------
  const receipt = {
    id: String(order._id),
    transaction_code: order.transaction_code || '',
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    pricing: {
      items_subtotal: int(items_subtotal),
      items_subtotal_after_discount: int(items_subtotal_after_discount),
      items_discount: int(items_discount),
      service_fee: int(service_fee),
      delivery_fee: int(delivery_fee),
      delivery_fee_raw: int(delivery_fee_raw),
      shipping_discount: int(shipping_discount),
      tax_amount: int(tax_amount),
      tax_rate_percent: Number(tax_rate_percent || 0),
      // points_used: prefer snapshot.ui_totals.points_used -> fallback order.points_used -> 0
      points_used: int(
        snapshotUi?.points_used ??
          snapshotUi?.points_candidate_use ??
          order.points_used ??
          0
      ),
      rounding_delta: int(rounding_delta),
      grand_total: int(grand_total),
      raw_total_before_rounding: int(raw_total_before_rounding)
    },
    customer: {
      name: displayName,
      phone: displayPhone
    },
    fulfillment: {
      type: order.fulfillment_type || order.delivery?.mode || null,
      table_number:
        order.fulfillment_type === 'dine_in'
          ? order.table_number || null
          : null,
      delivery:
        (order.fulfillment_type === 'delivery' ||
          order.delivery?.mode === 'delivery') &&
        order.delivery
          ? {
              address_text: order.delivery.address_text || '',
              distance_km: order.delivery.distance_km || null,
              note_to_rider: order.delivery.note_to_rider || '',
              delivery_fee: int(delivery_fee),
              delivery_fee_raw: int(delivery_fee_raw),
              shipping_discount: int(shipping_discount)
            }
          : null
    },
    items: detailedItems,
    timestamps: {
      placed_at: order.placed_at,
      paid_at: order.paid_at || null
    },
    applied_promos: appliedPromos,
    applied_vouchers: appliedVoucherEntries,
    applied_voucher_ids: Array.isArray(order.applied_voucher_ids)
      ? order.applied_voucher_ids
      : appliedVoucherEntries.map((v) => v.voucherId),
    free_items,
    meta: {
      note: order.notes || order.note || ''
    }
  };

  return receipt;
};

exports.getOrderReceipt = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const order = await Order.findById(id)
    .populate('member', 'name phone') // kalau mau ambil dari member
    .lean({ virtuals: true });

  if (!order) {
    return res.status(404).json({
      success: false,
      message: 'Order tidak ditemukan'
    });
  }

  const data = buildOrderReceipt(order);

  return res.json({
    success: true,
    data
  });
});

exports.listKitchenOrders = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { limit = 100, cursor } = req.query || {};
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);

  const q = {
    status: 'accepted',
    payment_status: 'verified'
  };

  if (cursor) {
    const cDate = new Date(cursor);
    if (isNaN(cDate.getTime()))
      throwError('cursor tidak valid (harus ISO date)', 400);

    q.$or = [
      { verified_at: { $lt: cDate } },
      { verified_at: null, placed_at: { $lt: cDate } },
      { verified_at: null, placed_at: null, createdAt: { $lt: cDate } }
    ];
  }

  const raw = await Order.find(q)
    .select(
      'transaction_code grand_total fulfillment_type customer_name customer_phone placed_at table_number payment_status total_quantity delivery.pickup_window delivery.slot_label delivery.scheduled_at delivery.status status member createdAt items delivery.mode discounts verified_at'
    )
    .sort({ verified_at: -1, placed_at: -1, createdAt: -1 })
    .limit(lim)
    .populate({ path: 'member', select: 'name phone' })
    .populate('items.menu', 'name imageUrl')
    .lean();

  const items = (Array.isArray(raw) ? raw : []).map((o) => {
    const deliveryMode =
      (o.delivery && o.delivery.mode) ||
      (o.fulfillment_type === 'dine_in' ? 'none' : 'delivery');

    // item mapping
    const orderItems = (Array.isArray(o.items) ? o.items : []).map((it) => ({
      menu: it.menu ? String(it.menu._id || it.menu) : null,
      name: (it.menu && it.menu.name) || it.name || '',
      menu_code: it.menu_code || '',
      image:
        (it.menu && (it.menu.imageUrl || it.menu.image)) || it.imageUrl || null,
      quantity: Number(it.quantity || 0),
      base_price: Number(it.base_price || 0),
      addons: Array.isArray(it.addons)
        ? it.addons.map((a) => ({
            name: a.name || '',
            price: Number(a.price || 0),
            qty: Number(a.qty || 1)
          }))
        : [],
      notes: it.notes || '',
      line_subtotal: Number(it.line_subtotal || 0),
      adjustments: Array.isArray(it.adjustments) ? it.adjustments : [],
      is_free_item:
        Number(it.base_price || 0) === 0 &&
        Number(it.quantity || 0) > 0 &&
        Number(it.line_subtotal || 0) === 0
    }));

    // free item aggregation (same as your previous logic)
    const freeFromDiscounts = (Array.isArray(o.discounts) ? o.discounts : [])
      .filter(
        (d) =>
          String(d.source || '').toLowerCase() === 'promo' &&
          (d.type === 'free_item' ||
            (d.type === 'note' &&
              String(d.label || '')
                .toLowerCase()
                .includes('gratis')))
      )
      .flatMap((d) => {
        const itemsArr = Array.isArray(d.items) ? d.items : [];
        return itemsArr.map((it) => ({
          menuId: String(it.menuId || (d.meta && d.meta.menuId) || ''),
          qty: Number(it.qty || (d.meta && d.meta.qty) || 1),
          name:
            (d.meta && d.meta.name) ||
            (d.label ? String(d.label).replace(/^Gratis:\s*/i, '') : null) ||
            null,
          imageUrl: (d.meta && d.meta.imageUrl) || null,
          source: 'discount'
        }));
      });

    const freeFromItems = (Array.isArray(o.items) ? o.items : [])
      .filter(
        (it) => Number(it.base_price || 0) === 0 && Number(it.quantity || 0) > 0
      )
      .map((it) => ({
        menuId: String((it.menu && it.menu._id) || it.menu || ''),
        qty: Number(it.quantity || 1),
        name: it.name || (it.menu && it.menu.name) || null,
        imageUrl: it.imageUrl || (it.menu && it.menu.imageUrl) || null,
        source: 'item'
      }));

    const freeFromAdjustments = (Array.isArray(o.items) ? o.items : []).flatMap(
      (it) => {
        const adj = Array.isArray(it.adjustments) ? it.adjustments : [];
        return adj
          .filter(
            (a) => String(a.type || '').toLowerCase() === 'promo_free_item'
          )
          .map((a) => ({
            menuId: String(
              (it.menu && it.menu._id) || it.menu || a.menuId || ''
            ),
            qty: Number(a.qty || a.amount || 1),
            name:
              it.name || (it.menu && it.menu.name) || a.name || null || null,
            imageUrl:
              it.imageUrl ||
              (it.menu && it.menu.imageUrl) ||
              a.imageUrl ||
              null,
            source: 'adjustment'
          }));
      }
    );

    const freeMap = {};
    const pushFree = (f) => {
      if (!f || !f.menuId) return;
      const k = String(f.menuId);
      if (!freeMap[k]) {
        freeMap[k] = {
          menuId: k,
          qty: 0,
          name: f.name || null,
          imageUrl: f.imageUrl || null,
          sources: {}
        };
      }
      freeMap[k].qty += Number(f.qty || 0);
      if (!freeMap[k].name && f.name) freeMap[k].name = f.name;
      if (!freeMap[k].imageUrl && f.imageUrl) freeMap[k].imageUrl = f.imageUrl;
      freeMap[k].sources[f.source] =
        (freeMap[k].sources[f.source] || 0) + Number(f.qty || 0);
    };

    freeFromDiscounts.forEach(pushFree);
    freeFromItems.forEach(pushFree);
    freeFromAdjustments.forEach(pushFree);

    const free_items = Object.keys(freeMap).map((k) => ({
      menuId: freeMap[k].menuId,
      name: freeMap[k].name || '',
      imageUrl: freeMap[k].imageUrl || null,
      qty: freeMap[k].qty,
      sources: freeMap[k].sources
    }));

    return {
      id: String(o._id),
      transaction_code: o.transaction_code || '',
      delivery_mode: deliveryMode,
      grand_total: Number(o.grand_total || 0),
      customer_name: (o.member && o.member.name) || o.customer_name || '',
      customer_phone: (o.member && o.member.phone) || o.customer_phone || '',
      verified_at: o.verified_at || null,
      placed_at: o.placed_at || o.createdAt || null,
      table_number:
        o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
      payment_status: o.payment_status || null,
      status: o.status || null,
      total_quantity: Number(o.total_quantity || 0),
      pickup_window:
        o.delivery && o.delivery.pickup_window
          ? {
              from: o.delivery.pickup_window.from || null,
              to: o.delivery.pickup_window.to || null
            }
          : null,
      delivery_slot_label: o.delivery ? o.delivery.slot_label || null : null,
      delivery_scheduled_at: o.delivery
        ? o.delivery.scheduled_at || null
        : null,
      delivery_status: o.delivery ? o.delivery.status || null : null,
      member_id: o.member ? String(o.member._id) : null,
      items: orderItems,
      free_items
    };
  });

  return res.status(200).json({
    items,
    next_cursor:
      items.length > 0
        ? new Date(
            items[items.length - 1].verified_at ||
              items[items.length - 1].placed_at ||
              items[items.length - 1].created_at
          ).toISOString()
        : null
  });
});

exports.createPosDineIn = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    table_number,
    items,
    as_member = false,
    member_id,
    name,
    phone,
    payment_method,
    selectedPromoId
  } = req.body || {};

  const tableNo = asInt(table_number, 0);
  if (!tableNo) throwError('table_number wajib', 400);
  if (!Array.isArray(items) || !items.length) throwError('items wajib', 400);

  const PM_POS = {
    CASH: 'cash',
    QRIS: 'qris',
    CARD: 'card',
    TRANSFER: 'transfer'
  };
  const ALLOWED_PM_POS = [
    PM_POS.CASH,
    PM_POS.QRIS,
    PM_POS.CARD,
    PM_POS.TRANSFER
  ];
  const method = String(payment_method || '').toLowerCase();
  if (!ALLOWED_PM_POS.includes(method))
    throwError('payment_method POS tidak valid (cash|qris|card|transfer)', 400);

  const ownerVerified = !paymentRequiresOwnerVerify(method);

  let member = null;
  let customer_name = '',
    customer_phone = '';
  if (as_member) {
    if (!member_id)
      throwError(
        'Pilih member terlebih dahulu (via daftar atau pilih member)',
        400
      );
    const m = await Member.findById(member_id).lean();
    if (!m) throwError('Member tidak ditemukan', 404);
    member = m;
    customer_name = String(member.name || '').trim();
    customer_phone = String(member.phone || '').trim();
  } else {
    customer_name = String(name || '').trim();
    customer_phone = String(phone || '').trim();
    if (!customer_name && !customer_phone)
      throwError('Tanpa member: isi minimal nama atau no. telp', 400);
  }

  // build items
  const orderItems = [];
  let totalQty = 0;
  let itemsSubtotal = 0;

  for (const it of items) {
    const menu = await Menu.findById(it.menu_id).lean();
    if (!menu || !menu.isActive)
      throwError('Menu tidak ditemukan / tidak aktif', 404);

    const qty = clamp(asInt(it.quantity, 1), 1, 999);
    const normAddons = normalizeAddons(it.addons);
    const addonsTotal = normAddons.reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const unit = priceFinal(menu.price);
    const line_subtotal = (unit + addonsTotal) * qty;

    orderItems.push({
      menu: menu._id, // simpan sebagai ObjectId (atau string)
      menu_snapshot: {
        id: menu._id,
        menu_code: menu.menu_code || '',
        name: menu.name || '',
        imageUrl: menu.imageUrl || '',
        price: Number(menu.price || 0)
      },
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: unit,
      quantity: qty,
      addons: normAddons,
      notes: String(it.notes || '').trim(),
      line_subtotal,
      category: {
        big: menu.bigCategory || null,
        subId: menu.subcategory || null
      }
    });

    totalQty += qty;
    itemsSubtotal += line_subtotal;
  }

  // prepare cartForEngine per-unit prices
  const cartForEngine = {
    items: orderItems.map((it) => {
      const addonsPerUnit = Array.isArray(it.addons)
        ? it.addons.reduce(
            (s, a) =>
              s +
              Number(a.price || 0) *
                (Number(a.qty || 1) / Math.max(1, Number(it.quantity || 1))),
            0
          )
        : 0;
      const unitPrice = Math.round(Number(it.base_price || 0) + addonsPerUnit);
      return {
        menuId: it.menu,
        qty: Number(it.quantity || 0),
        price: unitPrice,
        category: it.category?.subId || it.category?.big || null
      };
    })
  };

  // promos (kasir mode: voucher NOT allowed)
  const memberForPromo = member ? member : null;
  const promos = await findApplicablePromos(
    cartForEngine,
    memberForPromo,
    new Date()
  );

  // pick promo (selected or auto)
  let appliedPromoSnapshot = null;
  let promoRewards = [];
  let promoImpact = null;
  const requestedPromoId = selectedPromoId || null;

  if (requestedPromoId) {
    const chosen = promos.find(
      (p) => String(p._id) === String(requestedPromoId)
    );
    if (chosen) {
      const { impact, actions } = await applyPromo(chosen, cartForEngine);
      appliedPromoSnapshot = {
        promoId: String(chosen._id),
        name: chosen.name || null,
        type: chosen.type || null,
        description: chosen.description || null,
        impact,
        actions: actions || []
      };
      promoImpact = impact;
    } else {
      console.warn(
        '[createPosDineIn] requested promo not eligible',
        requestedPromoId
      );
    }
  } else if (!requestedPromoId && promos.length > 0) {
    const autoPromo = chooseAutoPromo(promos);
    if (autoPromo) {
      const { impact, actions } = await applyPromo(autoPromo, cartForEngine);
      appliedPromoSnapshot = {
        promoId: String(autoPromo._id),
        name: autoPromo.name || null,
        type: autoPromo.type || null,
        description: autoPromo.description || null,
        impact,
        actions: actions || []
      };
      promoImpact = impact;
    }
  }

  // apply promoImpact: enrich free items then modify orderItems/itemsSubtotal
  if (promoImpact) {
    // enrich free items
    if (
      Array.isArray(promoImpact.addedFreeItems) &&
      promoImpact.addedFreeItems.length
    ) {
      const enriched = await enrichFreeItemsForImpact(
        promoImpact.addedFreeItems || []
      );
      for (const f of enriched) {
        const freeQty = Number(f.qty || 1);
        // if menuId exists, convert to ObjectId when pushing (Menu._id already object)
        orderItems.push({
          menu: f.menuId || null,
          menu_snapshot: {
            id: f.menuId || null,
            menu_code: null,
            name: f.name || 'Free item',
            imageUrl: f.imageUrl || null,
            price: 0
          },
          menu_code: null,
          name: f.name || 'Free item',
          imageUrl: f.imageUrl || null,
          base_price: 0,
          quantity: freeQty,
          addons: [],
          notes: 'Free item (promo)',
          line_subtotal: 0,
          category: { big: f.category || null, subId: null }
        });

        promoRewards.push({
          type: 'free_item',
          menuId: f.menuId || null,
          name: f.name || null,
          qty: freeQty
        });
        totalQty += freeQty;
      }
    }

    // discount
    const discountAmount = Number(
      promoImpact.itemsDiscount || promoImpact.cartDiscount || 0
    );
    if (discountAmount && discountAmount > 0) {
      itemsSubtotal = Math.max(0, itemsSubtotal - discountAmount);
    }

    // actions -> promoRewards
    if (
      Array.isArray(appliedPromoSnapshot?.actions) &&
      appliedPromoSnapshot.actions.length
    ) {
      for (const a of appliedPromoSnapshot.actions) {
        promoRewards.push({
          type: a.type || 'action',
          amount: a.amount || null,
          meta: a.meta || {}
        });
      }
    }

    appliedPromoSnapshot.impact = promoImpact;
  }

  // totals (service/tax/rounding)
  const sfRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = int(Math.round(itemsSubtotal * sfRate));
  const rate =
    Number.isFinite(Number(process.env.PPN_RATE ?? 0.11)) &&
    Number(process.env.PPN_RATE ?? 0.11) > 0
      ? Number(process.env.PPN_RATE) > 1
        ? Number(process.env.PPN_RATE) / 100
        : Number(process.env.PPN_RATE)
      : parsePpnRate();
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;
  const taxBase = itemsSubtotal;
  const taxAmount = int(Math.max(0, Math.round(taxBase * rate)));
  const rawBeforeRound = itemsSubtotal + serviceFee + taxAmount;
  const grandTotal = int(roundRupiahCustom(rawBeforeRound));
  const roundingDelta = int(grandTotal - rawBeforeRound);
  const now = new Date();

  // create order (retry loop)
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: member ? member._id : null,
          customer_name,
          customer_phone,
          table_number: tableNo,
          source: 'pos',
          fulfillment_type: 'dine_in',
          transaction_code: code,
          ownerVerified,
          ownerVerifiedBy: ownerVerified ? req.user?.id || null : null,
          ownerVerifiedAt: ownerVerified ? new Date() : null,
          appliedPromo: appliedPromoSnapshot
            ? {
                promoId: appliedPromoSnapshot.promoId,
                name: appliedPromoSnapshot.name || null,
                type: appliedPromoSnapshot.type || null,
                description: appliedPromoSnapshot.description || null,
                impact: appliedPromoSnapshot.impact || null,
                actions: appliedPromoSnapshot.actions || []
              }
            : null,
          promoRewards,
          orderPriceSnapshot: {
            ui_totals: {
              items_subtotal: itemsSubtotal,
              items_discount: appliedPromoSnapshot
                ? Number(
                    appliedPromoSnapshot.impact?.itemsDiscount ||
                      appliedPromoSnapshot.impact?.cartDiscount ||
                      0
                  )
                : 0,
              service_fee: serviceFee,
              tax_amount: taxAmount,
              grand_total: grandTotal
            },
            engineTotals: {},
            breakdown: []
          },
          items: orderItems,
          total_quantity: totalQty,
          items_subtotal: itemsSubtotal,
          items_discount: appliedPromoSnapshot
            ? Number(
                appliedPromoSnapshot.impact?.itemsDiscount ||
                  appliedPromoSnapshot.impact?.cartDiscount ||
                  0
              )
            : 0,
          delivery_fee: 0,
          shipping_discount: 0,
          discounts: [],
          service_fee: serviceFee,
          tax_rate_percent: taxRatePercent,
          tax_amount: taxAmount,
          rounding_delta: roundingDelta,
          grand_total: grandTotal,
          payment_method: method,
          payment_status: ownerVerified ? 'verified' : 'paid',
          paid_at: now,
          verified_by: ownerVerified ? req.user?.id || null : null,
          verified_at: ownerVerified ? now : null,
          status: ownerVerified ? 'accepted' : 'created',
          placed_at: now
        });
      } catch (e) {
        if (e && e.code === 11000 && /transaction_code/.test(String(e.message)))
          continue;
        throw e;
      }
    }
    throw new Error('Gagal generate transaction_code unik');
  })();

  // promo side-effects (unchanged)
  try {
    if (
      appliedPromoSnapshot &&
      appliedPromoSnapshot.actions &&
      appliedPromoSnapshot.actions.length
    ) {
      try {
        await executePromoActions(order, Member, { session: null });
        if (appliedPromoSnapshot && appliedPromoSnapshot.promoId) {
          try {
            await Promo.updateOne(
              {
                _id: appliedPromoSnapshot.promoId,
                globalStock: { $ne: null, $gt: 0 }
              },
              { $inc: { globalStock: -1 } }
            ).catch(() => {});
          } catch (e) {
            console.warn(
              '[createPosDineIn] decrement promo globalStock failed',
              e?.message || e
            );
          }
        }
        if (
          order.member &&
          appliedPromoSnapshot &&
          appliedPromoSnapshot.promoId
        ) {
          try {
            const entry = {
              promoId: appliedPromoSnapshot.promoId,
              usedAt: new Date(),
              orderId: order._id
            };
            await Member.updateOne(
              { _id: order.member },
              { $push: { promoUsageHistory: entry } }
            ).catch(() => {});
          } catch (e) {
            console.warn(
              '[createPosDineIn] push member.promoUsageHistory failed',
              e?.message || e
            );
          }
        }
      } catch (e) {
        console.error(
          '[createPosDineIn] executePromoActions failed',
          e?.message || e
        );
      }
    }
  } catch (e) {
    console.error(
      '[createPosDineIn] promo side-effects failed',
      e?.message || e
    );
  }

  // async notify owner...
  (async () => {
    try {
      const full = await Order.findById(order._id).lean();
      if (!full) return;
      if (!paymentRequiresOwnerVerify(full.payment_method)) return;
      const EXPIRE_HOURS = Number(process.env.OWNER_VERIFY_EXPIRE_HOURS || 6);
      const tokenRaw = genTokenRaw();
      const tokenHash = hashTokenVerification(tokenRaw);
      const expiresAt = new Date(Date.now() + EXPIRE_HOURS * 60 * 60 * 1000);
      await Order.updateOne(
        { _id: full._id },
        {
          $set: {
            'verification.tokenHash': tokenHash,
            'verification.expiresAt': expiresAt,
            'verification.usedAt': null,
            'verification.usedFromIp': '',
            'verification.usedUserAgent': ''
          }
        }
      ).catch((e) =>
        console.error(
          '[createPosDineIn][notify] failed update verification',
          e?.message || e
        )
      );
      const DASHBOARD_URL = process.env.DASHBOARD_URL;
      const verifyLink = `${DASHBOARD_URL}/public/owner-verify?orderId=${
        full._id
      }&token=${encodeURIComponent(tokenRaw)}`;
      const msg = buildOwnerVerifyMessage(full, verifyLink, EXPIRE_HOURS);
      const owners = getOwnerPhone();
      if (!owners.length) return;
      const sendPromises = owners.map((rawPhone) => {
        const phone =
          typeof toWa62 === 'function' ? toWa62(rawPhone) : rawPhone;
        return sendText(phone, msg).then(
          (r) => ({ ok: true, phone: rawPhone, res: r }),
          (e) => ({ ok: false, phone: rawPhone, err: e?.message || e })
        );
      });
      const results = await Promise.allSettled(sendPromises);
      results.forEach((r) => {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v.ok)
            console.log('[notify][owner][pos] WA sent', {
              phone: v.phone,
              orderId: String(full._id)
            });
          else
            console.error('[notify][owner][pos] WA failed', {
              phone: v.phone,
              err: v.err
            });
        } else {
          console.error('[notify][owner][pos] WA promise rejected', r.reason);
        }
      });
    } catch (e) {
      console.error('[notify][owner][pos] unexpected error', e?.message || e);
    }
  })();

  // emit to cashier and kitchen if ownerVerified
  try {
    const summary = {
      id: String(order._id),
      transaction_code: order.transaction_code || '',
      delivery_mode:
        order.delivery?.mode ||
        (order.fulfillment_type === 'dine_in' ? 'none' : 'delivery'),
      grand_total: Number(order.grand_total || 0),
      fulfillment_type: order.fulfillment_type || null,
      customer_name:
        (order.member && order.member.name) || order.customer_name || '',
      customer_phone:
        (order.member && order.member.phone) || order.customer_phone || '',
      placed_at: order.placed_at || order.createdAt || null,
      table_number:
        order.fulfillment_type === 'dine_in'
          ? order.table_number || null
          : null,
      payment_status: order.payment_status || null,
      status: order.status || null,
      total_quantity: Number(order.total_quantity || 0),
      member_id: order.member ? String(order.member) : null
    };

    emitToCashier('staff:notify', {
      message: 'Ada pesanan baru, cek halaman pesanan.'
    });
    if (ownerVerified) {
      emitOrdersStream({ target: 'kitchen', action: 'insert', item: summary });
      emitToKitchen('staff:notify', {
        message: 'Pesanan baru diterima, cek halaman kitchen.'
      });
    }
  } catch (e) {
    console.error('[emit][createPosDineIn]', e?.message || e);
  }

  const responseMessage = ownerVerified
    ? 'Order POS dine-in dibuat & langsung verified'
    : 'Order POS dine-in dibuat. Menunggu verifikasi owner sebelum diteruskan ke kitchen';

  res.status(201).json({
    order: { ...order.toObject(), transaction_code: order.transaction_code },
    message: responseMessage
  });
});

exports.previewPosOrder = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    items,
    as_member = false,
    member_id = null,
    memberId = null,
    selectedPromoId = null
  } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    throwError('items wajib', 400);

  const orderItems = [];
  let totalQty = 0;
  let itemsSubtotal = 0;

  for (const it of items) {
    const menu = await Menu.findById(it.menu_id).lean();
    if (!menu || !menu.isActive)
      throwError('Menu tidak ditemukan / tidak aktif', 404);

    const qty = clamp(asInt(it.quantity, 1), 1, 999);
    const normAddons = normalizeAddons(it.addons);
    const addonsTotal = normAddons.reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const unit = priceFinal(menu.price);
    const line_subtotal = (unit + addonsTotal) * qty;

    orderItems.push({
      menu: String(menu._id),
      menu_snapshot: {
        id: String(menu._id),
        menu_code: menu.menu_code || '',
        name: menu.name || '',
        imageUrl: menu.imageUrl || '',
        price: Number(menu.price || 0)
      },
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: unit,
      quantity: qty,
      addons: normAddons,
      notes: String(it.notes || '').trim(),
      line_subtotal: int(line_subtotal),
      category: {
        big: menu.bigCategory || null,
        subId: menu.subcategory || null
      }
    });

    totalQty += qty;
    itemsSubtotal += line_subtotal;
  }

  // --- prepare cart for promo engine (per-unit includes addons) ---
  const cartForEngine = {
    items: orderItems.map((it) => {
      const addonsPerUnit = Array.isArray(it.addons)
        ? it.addons.reduce(
            (s, a) =>
              s +
              Number(a.price || 0) *
                (Number(a.qty || 1) / Math.max(1, Number(it.quantity || 1))),
            0
          )
        : 0;
      const unitPrice = Math.round(Number(it.base_price || 0) + addonsPerUnit);
      return {
        menuId: it.menu,
        qty: Number(it.quantity || 0),
        price: unitPrice,
        category: it.category?.subId || it.category?.big || null
      };
    })
  };

  // --- resolve MemberDoc (prioritas req.member, lalu member_id/memberId jika as_member true) ---
  let MemberDoc = null;
  if (req.member && req.member.id) {
    MemberDoc = await Member.findById(req.member.id)
      .lean()
      .catch(() => null);
  } else if (as_member) {
    const mid = String(member_id || memberId || '').trim() || null;
    if (!mid)
      throwError(
        'Saat as_member = true, kirimkan member_id (kasir harus pilih member)',
        400
      );
    MemberDoc = await Member.findById(mid)
      .lean()
      .catch(() => null);
    if (!MemberDoc) throwError('Member tidak ditemukan', 404);
  }

  const now = new Date();

  // --- cari eligible promos (pastikan engine tahu MemberDoc bila ada) ---
  let eligible = [];
  try {
    eligible = await findApplicablePromos(cartForEngine, MemberDoc, now);
  } catch (e) {
    console.warn(
      '[previewPosOrder] findApplicablePromos failed',
      e?.message || e
    );
    eligible = [];
  }

  // --- pilih autoApply promo (await applyPromo untuk impact preview) ---
  let appliedPromoSnapshot = null;
  try {
    const autos = (eligible || []).filter((p) => !!p.autoApply);
    if (autos.length) {
      autos.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
      const chosen = autos[0];
      const { impact, actions } = await applyPromo(chosen, cartForEngine);
      appliedPromoSnapshot = {
        promoId: String(chosen._id),
        name: chosen.name || null,
        type: chosen.type || null,
        description: chosen.description || null,
        impact,
        actions: actions || []
      };
    }
  } catch (e) {
    console.warn(
      '[previewPosOrder] autoApply applyPromo failed',
      e?.message || e
    );
    appliedPromoSnapshot = null;
  }

  // --- helper: build preview totals (shared) ---
  function buildTotalsFromSubtotal(subtotalAfterDiscount) {
    const sfRate = Number(SERVICE_FEE_RATE || 0);
    const serviceFee = int(Math.round(subtotalAfterDiscount * sfRate));
    const rate = parsePpnRate();
    const taxAmount = int(Math.round(subtotalAfterDiscount * rate));
    const beforeRound = int(subtotalAfterDiscount + serviceFee + taxAmount);
    const grandTotal = int(roundRupiahCustom(beforeRound));
    const roundingDelta = int(grandTotal - beforeRound);
    return { serviceFee, rate, taxAmount, grandTotal, roundingDelta };
  }

  // --- jika FE meminta preview untuk promo tertentu ---
  if (selectedPromoId) {
    const chosen = eligible.find(
      (p) => String(p._id) === String(selectedPromoId)
    );
    if (!chosen)
      return res.status(400).json({
        success: false,
        message: 'Promo tidak berlaku untuk cart ini'
      });

    const { impact, actions } = await applyPromo(chosen, cartForEngine);
    const itemsDiscount = Number(
      impact.itemsDiscount || impact.cartDiscount || 0
    );
    const items_subtotal_after_discount = Math.max(
      0,
      itemsSubtotal - itemsDiscount
    );

    const totals = buildTotalsFromSubtotal(items_subtotal_after_discount);

    // enrich free items (await) -> memastikan name & imageUrl tersedia
    const enrichedAdded = await enrichFreeItemsForImpact(
      impact.addedFreeItems || []
    );

    const addedPreviewItems = enrichedAdded.map((f) => {
      return {
        menu: f.menuId ? String(f.menuId) : null,
        menu_snapshot: f.menuId
          ? {
              id: String(f.menuId),
              menu_code: f.menuCode || null,
              name: f.name || 'Free item',
              imageUrl: f.imageUrl || null,
              price: Number(f.price || 0)
            }
          : null,
        menu_code: f.menuCode || null,
        name: f.name || 'Free item',
        imageUrl: f.imageUrl || null,
        base_price: 0,
        quantity: Number(f.qty || 1),
        addons: [],
        notes: 'Free item (promo)',
        line_subtotal: 0,
        category: { big: f.category || null, subId: null }
      };
    });

    const promoCompact = await buildPromoCompactFromApplied({
      applied: {
        promoId: String(chosen._id),
        name: chosen.name,
        type: chosen.type,
        description: chosen.description,
        impact,
        actions
      }
    });

    return res.json({
      success: true,
      preview: {
        items: orderItems.concat(addedPreviewItems),
        total_quantity:
          totalQty +
          addedPreviewItems.reduce((s, it) => s + Number(it.quantity || 0), 0),
        items_subtotal: int(itemsSubtotal),
        items_discount: int(itemsDiscount),
        items_subtotal_after_discount: int(items_subtotal_after_discount),
        service_fee: totals.serviceFee,
        tax_rate_percent: Math.round(totals.rate * 100 * 100) / 100,
        tax_amount: totals.taxAmount,
        grand_total: totals.grandTotal,
        rounding_delta: totals.roundingDelta,
        addedFreeItems: enrichedAdded
      },
      eligiblePromos: (eligible || []).map((p) => ({
        id: String(p._id),
        name: p.name,
        type: p.type,
        blocksVoucher: !!p.blocksVoucher,
        autoApply: !!p.autoApply,
        priority: Number(p.priority || 0)
      })),
      promo: promoCompact,
      eligiblePromosCount: (eligible || []).length,
      can_use_points: false
    });
  }

  // --- jika ada auto-applied promo -> bangun preview berdasarkan impact ---
  if (appliedPromoSnapshot && appliedPromoSnapshot.impact) {
    const impact = appliedPromoSnapshot.impact;
    const itemsDiscount = Number(
      impact.itemsDiscount || impact.cartDiscount || 0
    );
    const items_subtotal_after_discount = Math.max(
      0,
      itemsSubtotal - itemsDiscount
    );

    // enrich free items (await)
    const enrichedAdded = await enrichFreeItemsForImpact(
      impact.addedFreeItems || []
    );
    const itemsPreviewWithFree = orderItems.slice();
    for (const f of enrichedAdded) {
      itemsPreviewWithFree.push({
        menu: f.menuId ? String(f.menuId) : null,
        menu_snapshot: f.menuId
          ? {
              id: String(f.menuId),
              menu_code: f.menuCode || null,
              name: f.name || 'Free item',
              imageUrl: f.imageUrl || null,
              price: Number(f.price || 0)
            }
          : null,
        menu_code: f.menuCode || null,
        name: f.name || 'Free item',
        imageUrl: f.imageUrl || null,
        base_price: 0,
        quantity: Number(f.qty || 1),
        addons: [],
        notes: 'Free item (promo)',
        line_subtotal: 0,
        category: { big: f.category || null, subId: null }
      });
    }

    const totals = buildTotalsFromSubtotal(items_subtotal_after_discount);

    const promoCompact = await buildPromoCompactFromApplied({
      applied: appliedPromoSnapshot
    });

    return res.json({
      success: true,
      preview: {
        items: itemsPreviewWithFree,
        total_quantity:
          totalQty + enrichedAdded.reduce((s, f) => s + Number(f.qty || 0), 0),
        items_subtotal: int(itemsSubtotal),
        items_discount: int(itemsDiscount),
        items_subtotal_after_discount: int(items_subtotal_after_discount),
        service_fee: totals.serviceFee,
        tax_rate_percent: Math.round(totals.rate * 100 * 100) / 100,
        tax_amount: totals.taxAmount,
        grand_total: totals.grandTotal,
        rounding_delta: totals.roundingDelta,
        addedFreeItems: enrichedAdded
      },
      eligiblePromos: (eligible || []).map((p) => ({
        id: String(p._id),
        name: p.name,
        type: p.type,
        blocksVoucher: !!p.blocksVoucher,
        autoApply: !!p.autoApply,
        priority: Number(p.priority || 0)
      })),
      promo: promoCompact,
      eligiblePromosCount: (eligible || []).length,
      can_use_points: false
    });
  }

  // --- no promo ---
  const sfRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = int(Math.round(itemsSubtotal * sfRate));
  const rate = parsePpnRate();
  const taxAmount = int(Math.round(itemsSubtotal * rate));
  const beforeRound = int(itemsSubtotal + serviceFee + taxAmount);
  const grandTotal = int(roundRupiahCustom(beforeRound));
  const roundingDelta = int(grandTotal - beforeRound);

  return res.json({
    success: true,
    preview: {
      items: orderItems,
      total_quantity: totalQty,
      items_subtotal: int(itemsSubtotal),
      items_discount: 0,
      items_subtotal_after_discount: int(itemsSubtotal),
      service_fee: serviceFee,
      tax_rate_percent: Math.round(rate * 100 * 100) / 100,
      tax_amount: taxAmount,
      grand_total: grandTotal,
      rounding_delta: roundingDelta
    },
    eligiblePromos: (eligible || []).map((p) => ({
      id: String(p._id),
      name: p.name,
      type: p.type,
      blocksVoucher: !!p.blocksVoucher,
      autoApply: !!p.autoApply,
      priority: Number(p.priority || 0)
    })),
    eligiblePromosCount: (eligible || []).length,
    promo: null,
    can_use_points: false
  });
});

exports.evaluatePos = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    items,
    as_member = false,
    member_id = null,
    name = '',
    phone = '',
    includeImpacts = false
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0)
    throwError('items wajib', 400);

  // build normalized order items like in preview/create
  const orderItems = [];
  let itemsSubtotal = 0;
  for (const it of items) {
    const menu = await Menu.findById(it.menu_id).lean();
    if (!menu || !menu.isActive)
      throwError('Menu tidak ditemukan / tidak aktif', 404);
    const qty = clamp(asInt(it.quantity, 1), 1, 999);
    const normAddons = normalizeAddons(it.addons);
    const addonsTotal = normAddons.reduce(
      (s, a) => s + (a.price || 0) * (a.qty || 1),
      0
    );
    const unit = priceFinal(menu.price);
    const line_subtotal = (unit + addonsTotal) * qty;
    orderItems.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      base_price: unit,
      quantity: qty,
      addons: normAddons,
      notes: String(it.notes || '').trim(),
      line_subtotal,
      category: {
        big: menu.bigCategory || null,
        subId: menu.subcategory || null
      }
    });
    itemsSubtotal += line_subtotal;
  }

  // prepare cartForEngine for promo evaluation
  const cartForEngine = {
    items: orderItems.map((it) => ({
      menuId: it.menu,
      qty: Number(it.quantity || 0),
      price: Number(it.base_price || 0),
      category: it.category?.subId || it.category?.big || null
    }))
  };

  // load member if requested
  let member = null;
  if (as_member && member_id) {
    member = await Member.findById(member_id).lean();
    if (!member) throwError('Member tidak ditemukan', 404);
  }

  // fetch eligible promos (pass usage fetchers if you have member context)
  const now = new Date();
  const promoUsageFetchers = {
    getMemberUsageCount: async (promoId, memberId, sinceDate) => {
      try {
        if (!memberId) return 0;
        if (member && Array.isArray(member.promoUsageHistory)) {
          return member.promoUsageHistory.filter(
            (h) =>
              String(h.promoId) === String(promoId) &&
              new Date(h.usedAt || h.date) >= sinceDate
          ).length;
        }
        const q = {
          'appliedPromo.promoId': promoId,
          member: memberId,
          createdAt: { $gte: sinceDate }
        };
        return await Order.countDocuments(q);
      } catch (e) {
        console.warn(
          '[evaluatePos] getMemberUsageCount failed',
          e?.message || e
        );
        return 0;
      }
    },
    getGlobalUsageCount: async (promoId, sinceDate) => {
      try {
        const q = {
          'appliedPromo.promoId': promoId,
          createdAt: { $gte: sinceDate }
        };
        return await Order.countDocuments(q);
      } catch (e) {
        console.warn(
          '[evaluatePos] getGlobalUsageCount failed',
          e?.message || e
        );
        return 0;
      }
    }
  };

  let eligible = [];
  try {
    eligible = await findApplicablePromos(cartForEngine, member, now, {
      fetchers: promoUsageFetchers
    });
  } catch (e) {
    console.warn('[evaluatePos] findApplicablePromos failed', e?.message || e);
    eligible = [];
  }

  // build eligible summary (for FE)
  const eligibleSummary = (eligible || []).map((p) => {
    const rewards =
      Array.isArray(p.rewards) && p.rewards.length
        ? p.rewards
        : p.reward
        ? [p.reward]
        : [];
    const rewardSummary = rewards.map((r) => ({
      freeMenuId: r.freeMenuId || null,
      freeQty: r.freeQty || 0,
      percent: r.percent ?? null,
      amount: r.amount ?? null,
      pointsFixed: r.pointsFixed ?? null,
      grantMembership: !!r.grantMembership
    }));
    return {
      id: String(p._id),
      name: p.name,
      type: p.type,
      blocksVoucher: !!p.blocksVoucher,
      autoApply: !!p.autoApply,
      priority: Number(p.priority || 0),
      rewardSummary
    };
  });

  // auto pick promo according to rules
  const chosen = chooseAutoPromo(eligible || []);
  let appliedPromo = null;
  const promoPreviews = {};

  if (chosen) {
    try {
      const { impact, actions } = await applyPromo(chosen, cartForEngine);
      appliedPromo = {
        promoId: String(chosen._id),
        name: chosen.name || null,
        impact,
        actions: actions || []
      };
    } catch (e) {
      console.warn('[evaluatePos] applyPromo failed', e?.message || e);
      appliedPromo = null;
    }
  }

  // optional: compute per-promo impacts if includeImpacts true
  if (includeImpacts && Array.isArray(eligible) && eligible.length) {
    for (const p of eligible) {
      try {
        const { impact, actions } = await applyPromo(p, cartForEngine);
        promoPreviews[String(p._id)] = { impact, actions: actions || [] };
      } catch (e) {
        promoPreviews[String(p._id)] = { error: e?.message || 'failed' };
      }
    }
  }

  // compute totals after promo (same as preview logic)
  let itemsDiscount = 0;
  const addedFreeItems = [];
  if (appliedPromo && appliedPromo.impact) {
    itemsDiscount = Number(
      appliedPromo.impact.itemsDiscount || appliedPromo.impact.cartDiscount || 0
    );
    if (Array.isArray(appliedPromo.impact.addedFreeItems)) {
      for (const f of appliedPromo.impact.addedFreeItems) {
        addedFreeItems.push({
          menuId: f.menuId,
          qty: Number(f.qty || 1),
          name: f.name || null
        });
      }
    }
  }

  const items_subtotal_after_discount = Math.max(
    0,
    itemsSubtotal - itemsDiscount
  );
  const sfRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = int(Math.round(items_subtotal_after_discount * sfRate));
  const rate = parsePpnRate();
  const taxAmount = int(Math.round(items_subtotal_after_discount * rate));
  const beforeRound = int(
    items_subtotal_after_discount + serviceFee + taxAmount
  );
  const grandTotal = int(roundRupiahCustom(beforeRound));
  const roundingDelta = int(grandTotal - beforeRound);

  return res.json({
    success: true,
    preview: {
      items: orderItems,
      items_subtotal: itemsSubtotal,
      items_discount: itemsDiscount,
      items_subtotal_after_discount,
      service_fee: serviceFee,
      tax_rate_percent: Math.round(rate * 100 * 100) / 100,
      tax_amount: taxAmount,
      grand_total: grandTotal,
      rounding_delta: roundingDelta,
      addedFreeItems
    },
    eligiblePromosCount: eligibleSummary.length,
    eligiblePromos: eligibleSummary,
    appliedPromo,
    promoPreviews
  });
});

exports.cashierRegisterMember = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { name, phone, gender } = req.body || {};
  if (!name || !phone || !gender)
    throwError('Nama, nomor telepon, dan gender wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  if (!/^0\d{9,13}$/.test(normalizedPhone)) {
    throwError('Format nomor tidak valid (gunakan 08xxxxxxxx)', 400);
  }

  const g = String(gender).toLowerCase();
  if (!['male', 'female'].includes(g)) {
    throwError('Gender harus salah satu dari: Laki-laki/Perempuan', 400);
  }

  let existing = await Member.findOne({ phone: normalizedPhone }).lean();
  if (existing) {
    return res.status(200).json({
      message: 'Nomor sudah terdaftar',
      member: {
        id: existing._id,
        name: existing.name,
        phone: existing.phone
      }
    });
  }

  await createMember({
    name: String(name).trim(),
    phone: normalizedPhone,
    gender: g,
    birthday: null,
    address: null,
    join_channel: 'pos'
  });

  const member = await Member.findOne({ phone: normalizedPhone }).lean();
  if (!member) throwError('Gagal membuat member', 500);

  return res.status(201).json({
    message: 'Member berhasil dibuat',
    member: {
      id: member._id,
      name: member.name,
      phone: member.phone
    }
  });
});

exports.completeOrder = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Data order tidak ditemukan', 404);

  // hanya pesanan yang sudah diterima yang bisa diselesaikan
  if (order.status !== 'accepted') {
    throwError(
      'Hanya pesanan dengan status diterima yang bisa diselesaikan',
      409
    );
  }

  // Khusus untuk delivery: pastikan delivery.status sudah 'delivered'
  if (
    order.fulfillment_type === 'delivery' &&
    order.delivery.mode === 'delivery'
  ) {
    if (!order.delivery) {
      throwError('Order ini tidak memiliki informasi delivery', 409);
    }
    const dStatus = order.delivery.status || 'pending';
    if (dStatus !== 'delivered') {
      throwError(
        'Untuk order delivery, status pengantaran harus "delivered" sebelum menandai pesanan selesai',
        409
      );
    }
  }

  // Jika lolos semua validasi, ubah status menjadi completed
  order.status = 'completed';
  await order.save();

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    status: order.status
  };

  try {
    emitOrdersStream({
      target: 'kitchen',
      action: 'remove',
      item: { id: payload.id }
    });

    emitToStaff('order:completed', payload);
    emitToCashier('order:completed', payload);

    if (order.member)
      emitToMember(String(order.member), 'order:completed', payload);
    if (order.guestToken)
      emitToGuest(order.guestToken, 'order:completed', payload);
  } catch (err) {
    console.error('[emit][completeOrder]', err?.message || err);
  }

  // return up-to-date order object
  return res
    .status(200)
    .json({ message: 'Pesanan selesai', order: order.toObject() });
});

exports.acceptAndVerify = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const id = req.params.id;
  if (!id) throwError('Order ID wajib', 400);

  // ambil lean snapshot awal (validasi)
  const orderLean = await Order.findById(id).lean();
  if (!orderLean) throwError('Order tidak ditemukan', 404);

  if (orderLean.status !== 'created') {
    throwError('Hanya pesanan berstatus created yang bisa diterima', 409);
  }

  // owner verify guard (jika perlu)
  const requiresOwner = paymentRequiresOwnerVerify(orderLean.payment_method);
  if (requiresOwner && !orderLean.ownerVerified) {
    throwError(
      'Pembayaran belum diverifikasi oleh Owner. Tidak bisa menerima pesanan.',
      409
    );
  }

  // payment status guard
  if (orderLean.payment_status !== 'paid') {
    throwError('Pembayaran belum paid. Tidak bisa verifikasi.', 409);
  }

  // ambil document non-lean untuk update
  const doc = await Order.findById(id);
  if (!doc) throwError('Order tidak ditemukan (second fetch)', 404);

  // set status & verification (tidak mengutak-atik harga)
  doc.status = 'accepted';
  doc.payment_status = 'verified';
  doc.verified_by = req.user._id;
  doc.verified_at = new Date();
  if (!doc.placed_at) doc.placed_at = new Date();

  await doc.save();

  // ambil final order lengkap untuk emit + WA (populate fields yang biasanya dipakai)
  const finalOrder = await Order.findById(doc._id)
    .populate('verified_by', 'name email')
    .populate({ path: 'member', select: 'name phone' })
    .populate({
      path: 'items.menu',
      select: 'name imageUrl code price',
      justOne: false
    })
    .lean();

  // ensure finalOrder fallback fields so builder tidak break
  if (finalOrder) {
    finalOrder.transaction_code =
      finalOrder.transaction_code || doc.transaction_code || String(doc._id);
    if (
      !finalOrder.customer_phone &&
      finalOrder.member &&
      finalOrder.member.phone
    ) {
      finalOrder.customer_phone = finalOrder.member.phone;
    }
  }

  const payload = {
    id: String(doc._id),
    transaction_code:
      doc.transaction_code ||
      (finalOrder && finalOrder.transaction_code) ||
      String(doc._id),
    status: doc.status,
    payment_status: doc.payment_status,
    verified_by: { id: String(req.user._id), name: req.user.name },
    at: doc.verified_at
  };

  // emits (non-blocking)
  try {
    emitToCashier('staff:notify', {
      message: 'Pesanan telah diterima & diverifikasi.'
    });
    emitToKitchen('staff:notify', {
      message: 'Pesanan baru telah diterima kasir, silakan cek kitchen.'
    });

    const summaryUpdate = {
      id: payload.id,
      status: payload.status,
      payment_status: payload.payment_status
    };

    const summary = {
      id: String(finalOrder?._id || doc._id),
      transaction_code:
        finalOrder?.transaction_code || doc.transaction_code || '',
      delivery_mode:
        finalOrder?.delivery?.mode ||
        (finalOrder?.fulfillment_type === 'dine_in' ? 'none' : 'delivery'),
      grand_total: Number(finalOrder?.grand_total || doc.grand_total || 0),
      fulfillment_type:
        finalOrder?.fulfillment_type || doc.fulfillment_type || null,
      customer_name:
        (finalOrder?.member && finalOrder.member.name) ||
        finalOrder?.customer_name ||
        doc.customer_name ||
        '',
      customer_phone:
        (finalOrder?.member && finalOrder.member.phone) ||
        finalOrder?.customer_phone ||
        doc.customer_phone ||
        '',
      placed_at:
        finalOrder?.placed_at ||
        finalOrder?.createdAt ||
        doc.placed_at ||
        doc.createdAt ||
        null,
      table_number:
        (finalOrder?.fulfillment_type || doc.fulfillment_type) === 'dine_in'
          ? finalOrder?.table_number ?? doc.table_number ?? null
          : null,
      payment_status: finalOrder?.payment_status || doc.payment_status || null,
      status: finalOrder?.status || doc.status || null,
      total_quantity: Number(
        finalOrder?.total_quantity ?? doc.total_quantity ?? 0
      ),
      pickup_window: finalOrder?.delivery?.pickup_window
        ? {
            from: finalOrder.delivery.pickup_window.from || null,
            to: finalOrder.delivery.pickup_window.to || null
          }
        : null,
      delivery_slot_label: finalOrder?.delivery?.slot_label || null,
      member_id: finalOrder?.member
        ? String(finalOrder.member._id)
        : doc.member
        ? String(doc.member)
        : null
    };

    emitOrdersStream({
      target: 'cashier',
      action: 'update',
      item: summaryUpdate
    });
    emitOrdersStream({
      target: 'kitchen',
      action: 'insert',
      item: summary
    });

    emitToStaff('order:accepted', payload);
    emitToCashier('order:accepted', payload);

    if (doc.member) emitToMember(String(doc.member), 'order:accepted', payload);
    if (doc.guestToken) emitToGuest(doc.guestToken, 'order:accepted', payload);
  } catch (err) {
    console.error('[emit][acceptAndVerify]', err?.message || err);
  }

  // kirim WA receipt non-blocking — sekarang panggil builder dengan { order, uiTotals }
  (async () => {
    try {
      // gunakan finalOrder (lebih stabil karena sudah populated)
      const full =
        finalOrder ||
        (await Order.findById(doc._id)
          .populate({ path: 'member', select: 'name phone' })
          .lean());
      if (!full) {
        console.warn(
          '[WA receipt] order not found when trying to send WA receipt',
          { orderId: String(doc._id) }
        );
        return;
      }

      // prepare uiTotals (ambil dari snapshot bila ada)
      const uiTotals =
        full.orderPriceSnapshot?.ui_totals || full.ui_totals || null;

      // fallbacks supaya builder aman
      full.transaction_code =
        full.transaction_code || doc.transaction_code || String(doc._id);
      if (!full.customer_phone && full.member && full.member.phone)
        full.customer_phone = full.member.phone;

      const phone = (full.customer_phone || '').trim();
      if (!phone) {
        console.warn('[WA receipt] no phone on order, skip WA', {
          orderId: String(full._id)
        });
        return;
      }

      if (typeof toWa62 !== 'function') {
        console.warn('[WA receipt] toWa62 helper not available, skip WA', {
          orderId: String(full._id)
        });
        return;
      }

      const wa = toWa62(phone);

      // panggil builder sesuai signature lama: buildOrderReceiptMessage({ order, uiTotals })
      let message = null;
      try {
        message = buildOrderReceiptMessage({ order: full, uiTotals });
      } catch (e) {
        console.error('[WA receipt] buildOrderReceiptMessage failed', {
          orderId: String(full._id),
          err: e?.message || e,
          stack: e?.stack,
          full_keys: full ? Object.keys(full) : null
        });

        // fallback simple text (so user still gets receipt)
        try {
          const tcode = full.transaction_code || String(full._id);
          const gt =
            typeof full.grand_total !== 'undefined'
              ? Number(full.grand_total)
              : null;
          const itemsSummary = (Array.isArray(full.items) ? full.items : [])
            .map((it) => {
              const name =
                it?.name || it?.menu?.name || it?.menu_code || 'item';
              const qty = it?.quantity ?? it?.qty ?? 1;
              return `${name} x${qty}`;
            })
            .slice(0, 5)
            .join('\n');
          message = `Terima kasih! Pesanan diterima.\nKode: ${tcode}\n${
            gt !== null ? `Total: ${gt}\n` : ''
          }${itemsSummary ? `Items:\n${itemsSummary}` : ''}\nArchers Cafe`;
        } catch (fallbackErr) {
          console.error(
            '[WA receipt] failed to build fallback message',
            fallbackErr?.message || fallbackErr
          );
          return;
        }
      }

      if (!message) {
        console.warn(
          '[WA receipt] message empty after builder + fallback, skip send',
          { orderId: String(full._id) }
        );
        return;
      }

      await sendText(wa, message);
      console.log('[WA receipt] sent', { orderId: String(full._id), phone });
    } catch (e) {
      console.error(
        '[WA receipt] unexpected failed:',
        e?.message || e,
        e?.stack
      );
    }
  })();

  // response ke caller
  return res.status(200).json({
    message: 'Pesanan diterima & diverifikasi',
    order: finalOrder || {
      id: String(doc._id),
      status: doc.status,
      payment_status: doc.payment_status
    }
  });
});

exports.assignDelivery = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { courier_id, courier_name, courier_phone, note } = req.body || {};
  const id = req.params.id;

  const order = await Order.findById(
    id,
    'fulfillment_type status payment_status member transaction_code delivery'
  );
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.fulfillment_type !== 'delivery') {
    throwError('Order ini bukan delivery', 400);
  }
  if (order.status === 'cancelled' || order.payment_status !== 'paid') {
    throwError('Order belum layak dikirim (harus paid & tidak cancelled)', 409);
  }

  // hanya assign kalau masih pending
  const from = order.delivery?.status || 'pending';
  if (from !== 'pending') {
    throwError(
      'Hanya order dengan status pending yang bisa di-assign manual',
      409
    );
  }

  const now = new Date();
  // build courier subdoc following new schema: courier.user, courier.name, courier.phone
  const courierObj = {
    user: courier_id || null,
    name: String(courier_name || '').trim(),
    phone: toWa62(courier_phone)
  };

  // set both timestamps.assigned_at and keep legacy assigned_at for compatibility
  const $set = {
    'delivery.status': 'assigned',
    'delivery.courier': courierObj,
    'delivery.timestamps.assigned_at': now,
    'delivery.assigned_at': now
  };
  if (note) $set['delivery.assign_note'] = String(note).trim();

  const updated = await Order.findByIdAndUpdate(
    id,
    { $set },
    { new: true, runValidators: false }
  );

  const payload = {
    id: String(updated._id),
    transaction_code: updated.transaction_code,
    delivery: {
      status: updated.delivery?.status,
      courier: updated.delivery?.courier,
      assigned_at:
        (updated.delivery?.timestamps &&
          updated.delivery.timestamps.assigned_at) ||
        updated.delivery?.assigned_at ||
        null
    }
  };

  try {
    // toast ke staff/kasir
    emitToStaff('staff:notify', {
      message: 'Pesanan delivery telah ditugaskan ke kurir.'
    });
    emitToCashier('staff:notify', {
      message: 'Pesanan delivery telah ditugaskan.'
    });

    // update realtime list (kasir & courier role)
    emitOrdersStream({ target: 'cashier', action: 'update', item: payload });
    emitOrdersStream({ target: 'courier', action: 'insert', item: payload });

    if (updated.member)
      emitToMember(String(updated.member), 'order:delivery_assigned', payload);
    if (updated.guestToken)
      emitToGuest(updated.guestToken, 'order:delivery_assigned', payload);

    // emit ke kurir personal kalau ada courier.user
    const courierUserId = updated.delivery?.courier?.user;
    if (courierUserId) {
      emitToCourier(String(courierUserId), 'order:assign:courier', payload);
      // tambahan: kurir juga dapat notifikasi toast
      emitToCourier(String(courierUserId), 'courier:notify', {
        message: 'Anda ditugaskan untuk pengantaran pesanan. Cek halaman kurir.'
      });
    }
  } catch (err) {
    console.error('[emit][assignDelivery]', err?.message || err);
  }

  res.status(200).json({
    message: 'Kurir berhasil di-assign (manual)',
    order: updated.toObject()
  });
});

exports.assignBatch = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  // terima array order ids: order_ids | orderIds | ids | ids_csv (flexible)
  const {
    order_ids,
    orderIds,
    ids,
    ids_csv,
    courier_id,
    courier_name,
    courier_phone,
    note
  } = req.body || {};

  // normalize incoming ids into array of strings
  let idList = Array.isArray(order_ids)
    ? order_ids
    : Array.isArray(orderIds)
    ? orderIds
    : Array.isArray(ids)
    ? ids
    : null;

  if (!idList && typeof ids_csv === 'string') {
    idList = ids_csv
      .split(',')
      .map((s) => String(s || '').trim())
      .filter(Boolean);
  }

  if (!idList || !idList.length) {
    throwError('order_ids (array) wajib untuk batch assign', 400);
  }

  if (!courier_name && !courier_id) {
    throwError('courier_name atau courier_id wajib', 400);
  }

  const now = new Date();
  const courierObj = {
    user: courier_id || null,
    name: String(courier_name || '').trim(),
    phone: toWa62(courier_phone)
  };

  const results = { assigned: [], failed: [] };

  // loop per id, log & collect hasil
  for (const rawId of idList) {
    const id = String(rawId || '').trim();
    if (!id) {
      results.failed.push({ id: rawId, reason: 'ID kosong' });
      continue;
    }

    try {
      // ambil ringkas untuk validasi (sama seperti assignDelivery)
      const order = await Order.findById(
        id,
        'fulfillment_type status payment_status member transaction_code delivery'
      );

      if (!order) {
        results.failed.push({ id, reason: 'Order tidak ditemukan' });
        continue;
      }

      if (order.fulfillment_type !== 'delivery') {
        results.failed.push({ id, reason: 'Order ini bukan delivery' });
        continue;
      }
      if (order.status === 'cancelled' || order.payment_status !== 'verified') {
        results.failed.push({
          id,
          reason: 'Order belum layak dikirim (harus paid & tidak cancelled)'
        });
        continue;
      }

      const from = order.delivery?.status || 'pending';
      if (from !== 'pending') {
        results.failed.push({
          id,
          reason: `Hanya order dengan status pending yang bisa di-assign manual (current=${from})`
        });
        continue;
      }

      // build $set sama seperti assignDelivery
      const $set = {
        'delivery.status': 'assigned',
        'delivery.courier': courierObj,
        'delivery.timestamps.assigned_at': now,
        'delivery.assigned_at': now
      };
      if (note) $set['delivery.assign_note'] = String(note).trim();

      // update & ambil versi terbaru
      const updated = await Order.findByIdAndUpdate(
        id,
        { $set },
        { new: true, runValidators: false }
      );

      if (!updated) {
        results.failed.push({
          id,
          reason: 'Gagal update order (tidak ditemukan setelah update)'
        });
        continue;
      }

      // payload ringkasan sama seperti assignDelivery
      const payload = {
        id: String(updated._id),
        transaction_code: updated.transaction_code,
        delivery: {
          status: updated.delivery?.status,
          courier: updated.delivery?.courier,
          assigned_at:
            (updated.delivery?.timestamps &&
              updated.delivery.timestamps.assigned_at) ||
            updated.delivery?.assigned_at ||
            null
        }
      };

      // emits / notifs (non-fatal)
      try {
        emitToStaff('staff:notify', {
          message: 'Pesanan delivery telah ditugaskan ke kurir.'
        });
        emitToCashier('staff:notify', {
          message: 'Pesanan delivery telah ditugaskan.'
        });

        emitOrdersStream({
          target: 'cashier',
          action: 'update',
          item: payload
        });
        emitOrdersStream({
          target: 'courier',
          action: 'insert',
          item: payload
        });

        if (updated.member)
          emitToMember(
            String(updated.member),
            'order:delivery_assigned',
            payload
          );
        if (updated.guestToken)
          emitToGuest(updated.guestToken, 'order:delivery_assigned', payload);

        const courierUserId = updated.delivery?.courier?.user;
        if (courierUserId) {
          emitToCourier(String(courierUserId), 'order:assign:courier', payload);
          emitToCourier(String(courierUserId), 'courier:notify', {
            message:
              'Anda ditugaskan untuk pengantaran pesanan. Cek halaman kurir.'
          });
        }
      } catch (emitErr) {
        console.error(
          '[emit][assignBatch][per-order]',
          emitErr?.message || emitErr
        );
      }

      results.assigned.push({
        id: String(updated._id),
        transaction_code: updated.transaction_code
      });
    } catch (e) {
      console.error('[assignBatch] per-order error:', e?.message || e);
      results.failed.push({ id, reason: e?.message || 'unknown error' });
    }
  }

  // satu batch summary emit (non-fatal)
  try {
    emitToStaff('orders:batch_assigned', {
      courier: courierObj,
      count: results.assigned.length
    });
  } catch (e) {
    console.error('[emit][assignBatch][batch]', e?.message || e);
  }

  return res.status(200).json({
    success: true,
    message: `Batch assign selesai. ${results.assigned.length} order diassign ke kurir.`,
    summary: {
      assigned: results.assigned.length,
      failed: results.failed.length
    },
    details: results
  });
});

exports.updateDeliveryStatus = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status, note } = req.body || {};
  if (!DELIVERY_ALLOWED.includes(status))
    throwError('Status delivery tidak valid', 400);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);
  if (order.fulfillment_type !== 'delivery')
    throwError('Order ini bukan delivery', 400);
  if (!order.delivery) throwError('Blok delivery belum ada', 409);

  const from = order.delivery.status || 'pending';
  if (from === status) {
    return res
      .status(200)
      .json({ message: 'Status delivery tidak berubah', order });
  }
  if (!canTransitDelivery(from, status)) {
    throwError(
      `Transisi delivery dari "${from}" ke "${status}" tidak diizinkan`,
      400
    );
  }

  order.delivery.status = status;
  const now = new Date();
  if (status === 'assigned')
    order.delivery.assigned_at = order.delivery.assigned_at || now;
  if (status === 'delivered') order.delivery.delivered_at = now;
  if (status === 'failed') order.delivery.failed_at = now;
  if (note) order.delivery.status_note = String(note).trim();

  if (
    status === 'delivered' &&
    order.payment_status === 'paid' &&
    order.status !== 'completed'
  ) {
    order.status = 'completed';
    order.paid_at = order.paid_at || order.paid_at; // tidak mengubah paid_at
  }

  await order.save();

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    delivery: {
      from,
      to: status,
      at: now,
      courier: order.delivery.courier || null,
      note: order.delivery.status_note || ''
    },
    order_status: order.status
  };
  try {
    emitToStaff('order:delivery_status', payload);
    emitToCashier('order:delivery_status', payload);
    if (order.delivery?.courier?.id) {
      emitToCourier(
        String(order.delivery.courier.id),
        'delivery:status',
        payload
      );
    }
    if (order.member)
      emitToMember(String(order.member), 'order:delivery_status', payload);
    if (order.guestToken)
      emitToGuest(order.guestToken, 'order:delivery_status', payload);
  } catch (err) {
    console.error('[emit][updateDeliveryStatus]', err?.message || err);
  }

  res.status(200).json({
    message: 'Status delivery diperbarui',
    order: order.toObject()
  });
});

exports.markAssignedToDelivered = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const id = req.params.id;
  if (!id || !mongoose.Types.ObjectId.isValid(id))
    throwError('ID tidak valid', 400);

  const order = await Order.findById(id);
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.fulfillment_type !== 'delivery')
    throwError('Order ini bukan delivery', 400);

  if (order.status !== 'accepted')
    throwError('Order harus berstatus accepted', 409);

  if (order.payment_status !== 'verified')
    throwError('Payment harus verified', 409);

  if (!order.delivery) throwError('Order tidak memiliki info delivery', 409);

  if ((order.delivery.status || 'pending') !== 'assigned')
    throwError('Delivery status harus assigned', 409);

  // validasi kurir
  if (req.user.role !== 'owner') {
    const assigned = order.delivery?.courier?.user;
    if (assigned && String(assigned) !== String(req.user._id))
      throwError('Tidak berhak: order bukan milik Anda', 403);
  }

  // === WAJIB ADA FILE ===
  if (!req.file) throwError('Bukti pengiriman wajib diunggah', 400);

  // === Penamaan file: <transactionCode>_<YYYYMMDD>.<ext> ===
  const trx = order.transaction_code || `ORDER_${order._id}`;
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const ext =
    (req.file.originalname || '').split('.').pop() ||
    req.file.mimetype?.split('/').pop() ||
    'jpg';

  const desiredName = `${trx}_${yyyy}${mm}${dd}.${ext}`;

  // === Upload ke Google Drive ===
  let fileId;
  try {
    const folderId = getDriveFolder('delivery');

    const uploaded = await uploadBuffer(
      req.file.buffer,
      desiredName,
      req.file.mimetype || 'image/jpeg',
      folderId
    );

    fileId = uploaded?.id || uploaded?.fileId || uploaded?._id;
    if (!fileId) throwError('Gagal upload bukti', 500);
  } catch (err) {
    console.error('[upload delivery proof]', err);
    throwError('Gagal mengunggah bukti pengiriman', 500);
  }

  const proofUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

  // === Set bukti + status ===
  order.delivery.delivery_proof_url = proofUrl;
  order.delivery.status = 'delivered';
  order.delivery.timestamps = order.delivery.timestamps || {};
  order.delivery.timestamps.delivered_at = now;
  order.delivery.delivered_at = now; // legacy kompatibel

  const saved = await order.save();

  // emit ke cashier, member, dll (tetap sama)
  try {
    const payload = {
      id: String(saved._id),
      transaction_code: saved.transaction_code,
      delivery: {
        status: saved.delivery.status,
        delivered_at: saved.delivery.timestamps.delivered_at,
        delivery_proof_url: proofUrl
      }
    };

    emitToCashier?.('staff:notify', {
      message: 'Kurir mengunggah bukti pengiriman. Silakan cek dan konfirmasi.'
    });

    emitOrdersStream?.({
      target: 'cashier',
      action: 'update',
      item: payload
    });

    if (saved.member)
      emitToMember?.(String(saved.member), 'order:delivered', payload);

    if (saved.guestToken)
      emitToGuest?.(saved.guestToken, 'order:delivered', payload);

    if (saved.delivery?.courier?.user)
      emitToCourier?.(String(saved.delivery.courier.user), 'courier:notify', {
        message: 'Pesanan ditandai delivered. Terima kasih!'
      });
  } catch (err) {
    console.error('[emit error markAssignedToDelivered]', err);
  }

  return res.status(200).json({
    message: 'Pesanan ditandai delivered & bukti tersimpan',
    order: saved.toObject()
  });
});

exports.deliveryBoard = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status, paid_only = 'false', limit = 50, cursor } = req.query || {};

  const q = {
    'delivery.mode': 'delivery'
  };

  q.payment_status = 'verified';

  if (status && DELIVERY_ALLOWED.includes(status)) {
    q['delivery.status'] = status;
  } else {
    q['delivery.status'] = { $nin: ['delivered', 'failed'] };
  }

  // jika paid_only param diset true, pakai 'paid' sebagai filter payment_status
  if (String(paid_only) === 'true') q.payment_status = 'paid';

  // cursor paging berdasarkan createdAt
  if (cursor) q.createdAt = { $lt: new Date(cursor) };

  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const items = await Order.find(q)
    .populate({
      path: 'member',
      select: 'name phone'
    })
    .sort({ createdAt: -1 })
    .limit(lim)
    .lean();

  res.status(200).json({
    items: items.map((o) => {
      let name = '';
      let phone = '';

      if (o.member && typeof o.member === 'object') {
        name = (o.member.name && String(o.member.name).trim()) || '';
        phone = (o.member.phone && String(o.member.phone).trim()) || '';
      }

      if (!name) {
        name = (o.customer_name && String(o.customer_name).trim()) || '';
      }
      if (!phone) {
        phone = (o.customer_phone && String(o.customer_phone).trim()) || '';
      }

      if (!name && !phone) {
        name = '-';
        phone = '-';
      }

      return {
        _id: o._id,
        transaction_code: o.transaction_code,
        member: o.member || null,
        grand_total: o.grand_total,
        payment_status: o.payment_status,
        order_status: o.status,
        delivery: o.delivery || null,
        createdAt: o.createdAt,
        name,
        phone
      };
    }),
    next_cursor: items.length ? items[items.length - 1].createdAt : null
  });
});

exports.listEmployeesDropdown = asyncHandler(async (req, res) => {
  const employees = await User.find({ role: 'courier' })
    .select('_id name email')
    .sort({ name: 1 })
    .lean();

  const items = employees.map((e) => ({
    id: e._id || '',
    name: e.name || '',
    email: e.email || ''
  }));

  res.json({
    items
  });
});

exports.getSessionStatus = async (req, res, next) => {
  try {
    const { id } = req.params || {};
    const s = await PaymentSession.findById(id).lean();
    if (!s) return res.status(404).json({ message: 'Session tidak ditemukan' });

    // Kalau sudah dibuat order-nya oleh webhook
    if (s.order) {
      return res.json({
        sessionId: String(s._id),
        status: 'paid',
        orderId: String(s.order),
        provider: s.provider || 'xendit',
        channel: s.channel || 'qris'
      });
    }

    // Kalau belum dibayar
    return res.json({
      sessionId: String(s._id),
      status: s.status || 'pending',
      provider: s.provider || 'xendit',
      channel: s.channel || 'qris',
      amount: s.requested_amount || 0,
      expires_at: s.expires_at || null
    });
  } catch (err) {
    next(err);
  }
};

// GET /orders/delivery-slots?day=YYYY-MM-DD&days=1
exports.deliverySlots = asyncHandler(async (req, res) => {
  const dayQuery = req.query.day
    ? dayjs(req.query.day).tz(LOCAL_TZ)
    : dayjs().tz(LOCAL_TZ);
  const days = Math.max(1, parseInt(req.query.days || '1', 10)); // hari ke depan
  const result = [];
  for (let i = 0; i < days; i++) {
    const d = dayQuery.add(i, 'day').startOf('day');
    const slots = getSlotsForDate(d).map((s) => ({
      label: s.label,
      datetime: s.datetime ? s.datetime.toISOString() : null,
      available: s.available
    }));
    result.push({
      date: d.format('YYYY-MM-DD'),
      slots
    });
  }
  res.json({ success: true, items: result });
});

exports.listMembers = asyncHandler(async (req, res) => {
  function escapeRegex(str) {
    if (!str) return '';
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const rawKeyword = String(req.query.q || '').trim();
  const keyword = rawKeyword.replace(/\s+/g, ' ').trim(); // normalize whitespace
  const limit = Math.min(Number(req.query.limit) || 20, 100); // batas aman max 100

  const filter = { is_active: true };

  if (keyword) {
    const onlyDigits = /^\d+$/.test(keyword.replace(/\D+/g, ''));

    if (onlyDigits) {
      const clean = keyword.replace(/\D+/g, '');
      filter.$or = [
        { phone: { $regex: clean, $options: 'i' } },
        { name: { $regex: escapeRegex(keyword), $options: 'i' } }
      ];
    } else {
      // general case: escape keyword before using as regex to avoid special-char issues
      const safe = escapeRegex(keyword);

      // opsi: split tokens dan cari semua token (AND) — lebih relevan untuk multi-word searches
      const tokens = safe.split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        // cari semua token ada di name (urutannya tidak harus berurutan)
        filter.$and = tokens.map((t) => ({
          name: { $regex: t, $options: 'i' }
        }));
      } else {
        // single token: cari di name atau phone
        filter.$or = [
          { name: { $regex: safe, $options: 'i' } },
          { phone: { $regex: keyword.replace(/\D+/g, ''), $options: 'i' } }
        ];
      }
    }
  }

  // kamu bisa tambahkan collation bila butuh accent-insensitive search (Mongo 3.4+)
  // const collation = { locale: 'en', strength: 1 }; // strength 1 = base characters only (ignore accents & case)

  const members = await Member.find(filter)
    .select('_id name phone')
    .sort({ name: 1 })
    .limit(limit)
    .lean();

  res.status(200).json({
    ok: true,
    count: members.length,
    data: members.map((m) => ({
      id: String(m._id),
      name: m.name,
      phone: m.phone
    }))
  });
});

exports.getAssignedDeliveries = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Harus login untuk mengakses halaman ini', 401);

  const userIdRaw =
    req.user?.id ||
    req.user?._id ||
    req.user?._doc?._id ||
    req.user?.userId ||
    null;
  if (!userIdRaw) throwError('Harus login untuk mengakses halaman ini', 401);

  const isOwner = String(req.user?.role || '').toLowerCase() === 'owner';

  // query params
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50)
  );
  const slotLabel = req.query.slot_label
    ? String(req.query.slot_label).trim()
    : null;
  const scheduledFromRaw = req.query.scheduled_from || null;
  const scheduledToRaw = req.query.scheduled_to || null;
  const scheduledDate = req.query.scheduled_date || null; // YYYY-MM-DD
  const cursorRaw = req.query.cursor || null; // ISO datetime for paging

  // dasar query: hanya delivery, mode delivery, tidak cancelled
  // tambahan: hanya payment_status verified dan delivery.status assigned
  const q = {
    fulfillment_type: 'delivery',
    'delivery.mode': 'delivery',
    status: { $ne: 'cancelled' },
    payment_status: 'verified',
    'delivery.status': 'assigned'
  };

  // slot label filter (opsional)
  if (slotLabel) q['delivery.slot_label'] = slotLabel;

  // scheduled range filter
  if (scheduledFromRaw || scheduledToRaw) {
    const range = {};
    if (scheduledFromRaw) {
      const d = new Date(scheduledFromRaw);
      if (!isNaN(d.getTime())) range.$gte = d;
    }
    if (scheduledToRaw) {
      const d = new Date(scheduledToRaw);
      if (!isNaN(d.getTime())) range.$lte = d;
    }
    if (Object.keys(range).length) q['delivery.scheduled_at'] = range;
  }

  // scheduledDate override
  if (scheduledDate) {
    const dayStart = new Date(`${scheduledDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${scheduledDate}T23:59:59.999Z`);
    if (!isNaN(dayStart.getTime()) && !isNaN(dayEnd.getTime())) {
      q['delivery.scheduled_at'] = { $gte: dayStart, $lte: dayEnd };
    }
  }

  // cursor: ambil records dengan scheduled_at > cursor (ascending)
  if (cursorRaw) {
    const c = new Date(cursorRaw);
    if (!isNaN(c.getTime())) {
      q.$and = q.$and || [];
      q.$and.push({
        $or: [
          { 'delivery.scheduled_at': { $gt: c } },
          {
            $and: [
              { 'delivery.scheduled_at': { $exists: false } },
              { placed_at: { $gt: c } }
            ]
          }
        ]
      });
    }
  }

  // fetch: sort oleh scheduled_at asc lalu createdAt asc
  const orders = await Order.find(q)
    .sort({ 'delivery.scheduled_at': 1, createdAt: 1 })
    .limit(limit)
    .populate('member', 'name phone')
    .populate('items.menu', 'name')
    .populate({ path: 'delivery.courier.user', select: 'name phone role' })
    .lean();

  // map response ringkas
  const mapped = (orders || []).map((o) => {
    const courierRaw = o.delivery?.courier || o.delivery?.assignee || {};
    const courier = {
      ...courierRaw,
      user:
        courierRaw.user && typeof courierRaw.user === 'object'
          ? courierRaw.user
          : courierRaw.user
    };

    return {
      id: String(o._id),
      transaction_code: o.transaction_code || '',
      placed_at: o.placed_at || o.createdAt || null,
      fulfillment_type: o.fulfillment_type || null,
      payment_method: o.payment_method || null,
      payment_status: o.payment_status || null,
      order_status: o.status || null,
      grand_total: Number(o.grand_total || 0),
      delivery: {
        status: o.delivery?.status || null,
        slot_label: o.delivery?.slot_label || null,
        scheduled_at: o.delivery?.scheduled_at || null,
        address_text: o.delivery?.address_text || null,
        location: o.delivery?.location || null,
        distance_km: o.delivery?.distance_km ?? null,
        delivery_fee: o.delivery?.delivery_fee ?? null,
        courier
      },
      customer: {
        member: o.member || null,
        name: o.customer_name || null,
        phone: o.customer_phone || null
      },
      items: (o.items || []).map((it) => ({
        name: it.name,
        qty: it.quantity,
        base_price: it.base_price,
        line_subtotal: it.line_subtotal,
        menu: it.menu
          ? typeof it.menu === 'object'
            ? it.menu
            : it.menu
          : null,
        addons: it.addons || []
      }))
    };
  });

  // next_cursor (scheduled_at or placed_at)
  let next_cursor = null;
  if (mapped.length) {
    const last = mapped[mapped.length - 1];
    next_cursor =
      last.delivery && last.delivery.scheduled_at
        ? new Date(last.delivery.scheduled_at).toISOString()
        : last.placed_at
        ? new Date(last.placed_at).toISOString()
        : null;
  }

  return res.json({
    ok: true,
    meta: {
      count: mapped.length,
      limit,
      next_cursor
    },
    data: mapped
  });
});

exports.getPickupOrders = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const allowed = ['accepted', 'completed'];
  const statusQ = req.query.status
    ? String(req.query.status).toLowerCase()
    : 'accepted';
  if (!allowed.includes(statusQ)) {
    throwError(
      `Invalid status filter. Hanya diperbolehkan: ${allowed.join(', ')}`,
      400
    );
  }

  const cursorRaw = req.query.cursor || null;
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50)
  );

  const q = {
    fulfillment_type: 'delivery',
    'delivery.mode': 'pickup',
    status: statusQ
  };

  if (cursorRaw) {
    const cursorDate = new Date(cursorRaw);
    if (!isNaN(cursorDate.getTime())) {
      q.$and = q.$and || [];
      q.$and.push({
        $or: [
          { 'delivery.pickup_window.from': { $gt: cursorDate } },
          {
            $and: [
              { 'delivery.pickup_window.from': { $exists: false } },
              { placed_at: { $gt: cursorDate } }
            ]
          }
        ]
      });
    }
  }

  // Ambil dokumen — include full items kalau frontend butuh; ubah .select jika mau ringkas
  const orders = await Order.find(q)
    .select(
      'transaction_code grand_total fulfillment_type customer_name customer_phone placed_at table_number payment_status total_quantity delivery.pickup_window delivery.slot_label status member createdAt items'
    )
    .sort({ 'delivery.pickup_window.from': 1, createdAt: 1 })
    .limit(limit)
    .populate({ path: 'member', select: 'name' })
    .lean();

  const mapped = (orders || []).map((o) => ({
    id: String(o._id),
    transaction_code: o.transaction_code || '',
    grand_total: Number(o.grand_total || 0),
    fulfillment_type: o.fulfillment_type || null,
    // delivery_mode not strictly needed (we know it's pickup) but include for completeness
    delivery_mode:
      o.delivery_mode !== undefined && o.delivery_mode !== null
        ? o.delivery_mode
        : o.delivery
        ? o.delivery.mode || 'pickup'
        : 'pickup',
    customer_name: (o.member && o.member.name) || o.customer_name || '',
    customer_phone: o.customer_phone || '',
    placed_at: o.placed_at || o.createdAt || null,
    table_number:
      o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
    payment_status: o.payment_status || null,
    status: o.status || null, // accepted | completed
    total_quantity: Number(o.total_quantity || 0),
    pickup_window:
      o.delivery && o.delivery.pickup_window
        ? {
            from: o.delivery.pickup_window.from || null,
            to: o.delivery.pickup_window.to || null
          }
        : null,
    delivery_slot_label: o.delivery ? o.delivery.slot_label || null : null,
    // minimal delivery details useful for pickup page
    delivery: {
      slot_label: o.delivery?.slot_label || null,
      pickup_window: o.delivery?.pickup_window || null,
      note_to_rider: o.delivery?.note_to_rider || ''
    },
    // include items (full) as requested earlier for kitchen; frontend can ignore if not needed
    items: (o.items || []).map((it) => ({
      menu: it.menu ? (typeof it.menu === 'object' ? it.menu : it.menu) : null,
      name: it.name || '',
      menu_code: it.menu_code || '',
      quantity: Number(it.quantity || 0),
      base_price: Number(it.base_price || 0),
      addons: Array.isArray(it.addons)
        ? it.addons.map((a) => ({
            name: a.name || '',
            price: Number(a.price || 0),
            qty: Number(a.qty || 1)
          }))
        : [],
      notes: it.notes || '',
      line_subtotal: Number(it.line_subtotal || 0)
    })),
    member_id: o.member ? String(o.member._id) : null
  }));

  // next_cursor: pickup_window.from (or placed_at) dari item terakhir
  let next_cursor = null;
  if (mapped.length) {
    const last = mapped[mapped.length - 1];
    next_cursor =
      last.pickup_window && last.pickup_window.from
        ? new Date(last.pickup_window.from).toISOString()
        : last.placed_at
        ? new Date(last.placed_at).toISOString()
        : null;
  }

  return res.status(200).json({
    ok: true,
    meta: {
      count: mapped.length,
      limit,
      next_cursor
    },
    data: mapped
  });
});

exports.closingShiftSummary = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  // date: YYYY-MM-DD (optional) — default hari ini di LOCAL_TZ
  const dateQuery = String(req.query?.date || '').trim();
  const baseDay = dateQuery
    ? dayjs(dateQuery).tz(LOCAL_TZ)
    : dayjs().tz(LOCAL_TZ);
  if (!baseDay.isValid())
    throwError('date tidak valid (gunakan YYYY-MM-DD)', 400);

  // default shifts kalau tidak dikirim
  const defaultShift1 = '00:00-14:59';
  const defaultShift2 = '15:00-23:59';

  const shift1RangeStr = String(req.query?.shift1 || defaultShift1).trim();
  const shift2RangeStr = String(req.query?.shift2 || defaultShift2).trim();

  const toRangeDayjs = (rangeStr) => {
    const parsed = parseTimeRangeToDayjs(
      rangeStr,
      baseDay.format('YYYY-MM-DD')
    );
    if (!parsed) return null;
    return { from: parsed.from, to: parsed.to };
  };

  const shift1 = toRangeDayjs(shift1RangeStr);
  const shift2 = toRangeDayjs(shift2RangeStr);

  if (!shift1 || !shift2)
    throwError('Format shift tidak valid. Gunakan "HH:mm-HH:mm".', 400);

  // Full day range (startOfDay..endOfDay)
  const startOfDay = baseDay.startOf('day');
  const endOfDay = baseDay.endOf('day');

  const buildSummaryForRange = async (fromD, toD) => {
    const match = {
      payment_status: { $in: ['paid', 'verified'] },
      paid_at: { $gte: fromD.toDate(), $lte: toD.toDate() }
    };

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$payment_method', 'unknown'] },
          total_amount: { $sum: { $ifNull: ['$grand_total', 0] } },
          count: { $sum: 1 }
        }
      }
    ];

    const rows = await Order.aggregate(pipeline).allowDiskUse(true);

    // normalize result into map + compute totals
    const methods = { transfer: 0, qris: 0, cash: 0, card: 0, unknown: 0 };
    let total_amount = 0;
    let total_orders = 0;
    for (const r of rows || []) {
      const m = String(r._id || 'unknown');
      const amt = Number(r.total_amount || 0);
      const cnt = Number(r.count || 0);
      if (Object.prototype.hasOwnProperty.call(methods, m)) {
        methods[m] = amt;
      } else {
        // anything else go to unknown
        methods.unknown += amt;
      }
      total_amount += amt;
      total_orders += cnt;
    }

    return {
      range_from: fromD.toISOString(),
      range_to: toD.toISOString(),
      total_orders,
      total_amount,
      by_payment_method: methods
    };
  };

  // compute three ranges
  const fullDaySummary = await buildSummaryForRange(startOfDay, endOfDay);
  const shift1Summary = await buildSummaryForRange(shift1.from, shift1.to);
  const shift2Summary = await buildSummaryForRange(shift2.from, shift2.to);

  return res.json({
    success: true,
    date: baseDay.format('YYYY-MM-DD'),
    shift_definitions: {
      shift1: shift1RangeStr,
      shift2: shift2RangeStr,
      // sertakan ISO ranges juga supaya jelas
      shift1_iso: {
        from: shift1.from.toISOString(),
        to: shift1.to.toISOString()
      },
      shift2_iso: {
        from: shift2.from.toISOString(),
        to: shift2.to.toISOString()
      },
      full_day_iso: {
        from: startOfDay.toISOString(),
        to: endOfDay.toISOString()
      }
    },
    summary: {
      full_day: fullDaySummary,
      shift1: shift1Summary,
      shift2: shift2Summary
    }
  });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(orderId))
    throwError('ID order tidak valid', 400);

  const session = await mongoose.startSession();
  try {
    let deleted = null;

    await session.withTransaction(async () => {
      // ambil order (snapshot)
      const order = await Order.findById(orderId).session(session).lean();
      if (!order) throwError('Order tidak ditemukan', 404);

      // optional: boleh masukkan kebijakan reject jika order sudah completed/paid and cannot be cancelled
      // contoh: if (order.status === 'completed') throwError('Order sudah selesai', 400);

      // Hitung jumlah yang harus direstore/revoke berdasarkan snapshot di order
      const pointsUsed = Number(order.points_used || 0);
      const pointsAwarded = Number(order.points_awarded || 0);
      const totalSpendDelta = Number(order.total_spend_delta || 0);

      // Jika member ada, update member
      if (order.member) {
        const member = await Member.findById(order.member).session(session);
        if (!member) throwError('Member terkait order tidak ditemukan', 404);

        // refund points used
        const refundPoints = pointsUsed;

        // revoke awarded points (jika ada)
        const revokePoints = pointsAwarded;

        // compute new points (refund then revoke), clamp >= 0
        let newPoints =
          Number(member.points || 0) + refundPoints - revokePoints;
        if (newPoints < 0) newPoints = 0;

        // compute new total_spend (revert delta)
        const newTotalSpend = Math.max(
          0,
          Number(member.total_spend || 0) - totalSpendDelta
        );

        // update member atomically
        await Member.updateOne(
          { _id: member._id },
          {
            $set: {
              points: Math.trunc(newPoints),
              total_spend: Math.trunc(newTotalSpend),
              last_visit_at: member.last_visit_at || null
            }
          },
          { session }
        );

        // recalc level dan update bila berubah
        const newLevel = evaluateMemberLevel(newTotalSpend);
        if (String(member.level || '') !== String(newLevel)) {
          await Member.updateOne(
            { _id: member._id },
            { $set: { level: newLevel } },
            { session }
          );
        }
      }

      try {
        if (
          order.appliedPromo &&
          (order.appliedPromo.promoId ||
            (order.appliedPromo.promoSnapshot &&
              order.appliedPromo.promoSnapshot.promoId))
        ) {
          const promoId = String(
            order.appliedPromo.promoId ||
              order.appliedPromo.promoSnapshot?.promoId ||
              ''
          );
          if (promoId) {
            await releasePromoForOrder({
              promoId,
              memberId: order.member || null,
              orderId: order._id,
              session // penting: ikut dalam transaction
            });
            console.log('[cancelOrder] promo released for order', {
              promoId,
              orderId: String(order._id)
            });
          }
        }
      } catch (e) {
        console.error(
          '[cancelOrder] releasePromoForOrder failed',
          e?.message || e
        );

        throwError(
          e?.message || 'Gagal me-release promo saat cancel order',
          e?.status || 500
        );
      }

      const delRes = await Order.deleteOne({ _id: order._id }).session(session);
      if (delRes.deletedCount === 0) throwError('Gagal menghapus order', 500);
      deleted = { id: String(order._id), message: 'Order dihapus' };
    }); // end transaction

    session.endSession();
    return res.json({
      success: true,
      message: 'Order dibatalkan dan dihapus.',
      deleted
    });
  } catch (err) {
    session.endSession();
    throw err;
  }
});

exports.verifyOwnerDashboard = asyncHandler(async (req, res) => {
  if (!req.user && req.user.role != 'owner')
    throwError('Hanya owner yang bisa akses ini', 401);

  const id = req.params.id;
  const order = await Order.findById(id);
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.ownerVerified) {
    return res.status(200).json({
      ok: true,
      message: 'Order sudah diverifikasi owner',
      orderId: String(order._id)
    });
  }

  order.ownerVerified = true;
  order.ownerVerifiedBy = req.user._id;
  order.ownerVerifiedAt = new Date();
  await order.save();

  // Emit ke kasir
  try {
    emitToCashier('staff:notify', {
      message: `Order ${order.transaction_code} telah diverifikasi owner.`
    });
    emitOrdersStream({
      target: 'cashier',
      action: 'update',
      item: { id: String(order._id), ownerVerified: true }
    });
  } catch (e) {
    console.error('[emit][verifyOwnerPATCH]', e?.message || e);
  }

  res.status(200).json({
    ok: true,
    message: 'Order diverifikasi oleh owner',
    orderId: String(order._id)
  });
});

exports.verifyOwnerByToken = asyncHandler(async (req, res) => {
  const { orderId, token } = req.query || {};

  if (!orderId || !token) {
    return res.status(400).json({
      ok: false,
      code: 'missing',
      message: 'orderId & token diperlukan'
    });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return res
      .status(404)
      .json({ ok: false, code: 'not_found', message: 'Order tidak ditemukan' });
  }

  const verification = order.verification || {};
  if (!verification.tokenHash || !verification.expiresAt) {
    const EXPIRED_URL = process.env.OWNER_VERIFY_EXPIRED_URL;
    return res.redirect(EXPIRED_URL);
  }

  if (verification.usedAt) {
    const USED_URL = process.env.OWNER_VERIFY_USED_URL;
    return res.redirect(USED_URL);
  }

  if (new Date() > new Date(verification.expiresAt)) {
    const EXPIRED_URL = process.env.OWNER_VERIFY_EXPIRED_URL;
    return res.redirect(EXPIRED_URL);
  }

  const candidateHash = hashTokenVerification(token);
  if (candidateHash !== verification.tokenHash) {
    return res
      .status(400)
      .json({ ok: false, code: 'invalid', message: 'Token tidak valid' });
  }

  order.ownerVerified = true;
  order.ownerVerifiedAt = new Date();

  order.verification.usedAt = new Date();
  order.verification.usedFromIp = req.ip || '';
  order.verification.usedUserAgent = req.get('user-agent') || '';

  // clear tokenHash to avoid reuse
  order.verification.tokenHash = null;

  await order.save();

  // Emit only to cashier so UI kasir bisa enable tombol
  try {
    emitToCashier('staff:notify', {
      message: `Order ${order.transaction_code} diverifikasi owner.`
    });
    emitOrdersStream({
      target: 'cashier',
      action: 'update',
      item: { id: String(order._id), ownerVerified: true }
    });
  } catch (e) {
    console.error('[emit][verifyOwnerByToken]', e?.message || e);
  }

  const SUCCESS_URL = process.env.OWNER_VERIFY_SUCCESS_URL;

  return res.redirect(SUCCESS_URL);
});

exports.ownerVerifyPendingList = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const limitRaw = parseInt(req.query.limit || '50', 10);
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1),
    200
  );

  const q = {
    ownerVerified: false
  };

  // cursor = createdAt < cursorIso
  if (req.query.cursor) {
    const cDate = new Date(req.query.cursor);
    if (isNaN(cDate.getTime()))
      throwError('cursor tidak valid (harus ISO date)', 400);
    q.createdAt = { $lt: cDate };
  }

  // optionally: hanya pesanan aktif (tidak cancelled) — uncomment kalau mau
  // q.status = { $ne: 'cancelled' };

  const raw = await Order.find(q)
    .select(
      'transaction_code grand_total fulfillment_type customer_name customer_phone placed_at table_number payment_status total_quantity delivery payment_method ownerVerified createdAt items'
    )
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate({ path: 'member', select: 'name' })
    .lean();

  const items = (Array.isArray(raw) ? raw : []).map((o) => {
    const deliveryMode = o.delivery ? o.delivery.mode || null : null;
    const delivery_mode =
      deliveryMode || (o.fulfillment_type === 'dine_in' ? 'none' : 'delivery');

    const orderItems = (Array.isArray(o.items) ? o.items : []).map((it) => ({
      name: it.name || '',
      quantity: Number(it.quantity || 0),
      line_subtotal: Number(it.line_subtotal || 0)
    }));

    return {
      id: String(o._id),
      transaction_code: o.transaction_code || '',
      grand_total: Number(o.grand_total || 0),
      fulfillment_type: o.fulfillment_type || null,
      delivery_mode,
      customer_name: (o.member && o.member.name) || o.customer_name || '',
      customer_phone: o.customer_phone || '',
      placed_at: o.placed_at || o.createdAt || null,
      table_number:
        o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
      payment_status: o.payment_status || null,
      payment_method: o.payment_method || null,
      total_quantity: Number(o.total_quantity || 0),
      items: orderItems,
      ownerVerified: !!o.ownerVerified,
      createdAt: o.createdAt || null
    };
  });

  const next_cursor = items.length
    ? new Date(items[items.length - 1].createdAt).toISOString()
    : null;

  res.status(200).json({ items, next_cursor });
});
