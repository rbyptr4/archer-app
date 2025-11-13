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

const {
  recordOrderHistory,
  snapshotOrder
} = require('../controllers/owner/orderHistoryController');

const {
  afterCreateOrderEmit,
  makeOrderSummary
} = require('./socket/emitHelpers'); // sesuaikan path
// tambahkan di atas file
const {
  emitToStaff,
  emitToCashier,
  emitToKitchen,
  emitToCourier,
  emitToMember,
  emitToGuest
} = require('./socket/socketBus'); // sesuaikan path

// jika belum ada, untuk generate guest token
const { v4: uuidv4 } = require('uuid');

const throwError = require('../utils/throwError');
const { DELIVERY_SLOTS } = require('../config/onlineConfig'); // import
const { sendText, buildOrderReceiptMessage } = require('../utils/wablas');
const { buildUiTotalsFromCart } = require('../utils/cartUiCache');
const {
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom,
  int
} = require('../utils/money');
const { baseCookie } = require('../utils/authCookies');
const { uploadBuffer } = require('../utils/googleDrive');
const { getDriveFolder } = require('../utils/driveFolders');

const { haversineKm } = require('../utils/distance');
const { nextDailyTxCode } = require('../utils/txCode');
const {
  validateAndPrice,
  filterItemsByScope
} = require('../utils/voucherEngine');
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
const ALLOWED_STATUSES = ['created', 'accepted', 'completed', 'cancelled'];
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

function getSlotsForDate(dateDay = null) {
  const day = dateDay
    ? dateDay.tz(LOCAL_TZ).startOf('day')
    : dayjs().tz(LOCAL_TZ).startOf('day');
  const now = dayjs().tz(LOCAL_TZ);
  return (DELIVERY_SLOTS || []).map((label) => {
    const dt = parseSlotLabelToDate(label, day);
    const available = dt && dt.isValid() && now.isBefore(dt); // only future slots allowed (strict: now < slot)
    return {
      label,
      datetime: dt ? dt.toDate() : null,
      available
    };
  });
}

// function getSlotsForDate(dateDay = null) {
//   const day = dateDay
//     ? dateDay.tz(LOCAL_TZ).startOf('day')
//     : dayjs().tz(LOCAL_TZ).startOf('day');
//   // const now = dayjs().tz(LOCAL_TZ); // tidak diperlukan lagi untuk testing "always available"
//   return (DELIVERY_SLOTS || []).map((label) => {
//     const dt = parseSlotLabelToDate(label, day);
//     // Untuk testing: anggap semua slot yang parse-able sebagai available
//     const available = !!(dt && dt.isValid());
//     return {
//       label,
//       datetime: dt ? dt.toDate() : null,
//       available
//     };
//   });
// }

function isSlotAvailable(label, dateDay = null) {
  const slot = getSlotsForDate(dateDay).find((s) => s.label === label);
  return !!(slot && slot.available);
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
async function handleTransferProofIfAny(req, method) {
  if (!needProof(method)) return '';

  const file = req.file;
  if (!file) {
    // pesan disesuaikan berdasarkan method supaya FE jelas
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

  const folderId = getDriveFolder('invoice');
  const prefix =
    method === PM.TRANSFER ? 'TRF_' : method === PM.QRIS ? 'QRIS_' : 'PAY_';
  const filename =
    prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  const uploaded = await uploadBuffer(
    file.buffer,
    filename,
    file.mimetype || 'image/jpeg',
    folderId
  );

  const id = uploaded?.id;
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

/* ===================== CHECKOUT ===================== */
exports.checkout = asyncHandler(async (req, res) => {
  const iden0 = getIdentity(req);
  const {
    name,
    phone,
    fulfillment_type,
    payment_method,
    address_text,
    lat,
    lng,
    note_to_rider,
    idempotency_key,
    voucherClaimIds = [],
    register_decision = 'register'
  } = req.body || {};

  const ft =
    iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
  if (!['dine_in', 'delivery'].includes(ft)) {
    throwError('fulfillment_type tidak valid', 400);
  }

  const method = String(payment_method || '').toLowerCase();
  if (!isPaymentMethodAllowed(iden0.source || 'online', ft, method)) {
    throwError('Metode pembayaran tidak diizinkan untuk mode ini', 400);
  }

  // Jika QRIS dipakai sebagai static (fallback), treat as NON-gateway
  const methodIsGateway = method === PM.QRIS && !QRIS_USE_STATIC;
  const requiresProof = needProof(method);

  const originallyLoggedIn = !!iden0.memberId;
  const wantRegister = String(register_decision || 'register') === 'register';

  let MemberDoc = null;
  let customer_name = '';
  let customer_phone = '';

  if (originallyLoggedIn || wantRegister) {
    const joinChannel = iden0.mode === 'self_order' ? 'self_order' : 'online';
    MemberDoc = await ensureMemberForCheckout(req, res, joinChannel);
  } else {
    customer_name = String(name || '').trim();
    const rawPhone = String(phone || '').trim();

    if (!customer_name && !rawPhone) {
      throwError('Tanpa member: isi minimal nama atau no. telp', 400);
    }
    if (rawPhone) {
      const digits = rawPhone.replace(/\D+/g, '');
      if (!digits) throwError('Nomor telepon harus berupa angka', 400);
      customer_phone = normalizePhone(rawPhone);
    } else {
      customer_phone = '';
    }
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

  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreateOnline: false
  });

  if (!cartObj) throwError('Cart tidak ditemukan / kosong', 404);

  const cart = await Cart.findById(cartObj._id);
  if (!cart) throwError('Cart tidak ditemukan / kosong', 404);
  if (!cart.items?.length) throwError('Cart kosong', 400);

  if (
    ft === 'dine_in' &&
    (iden.source || 'online') === 'qr' &&
    !cart.table_number
  ) {
    throwError('Silakan assign nomor meja terlebih dahulu', 400);
  }

  const delivery_mode =
    ft === 'dine_in'
      ? 'none'
      : String(req.body?.delivery_mode || 'delivery').toLowerCase();

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
        throwError(
          'Untuk delivery: delivery_slot atau scheduled_at wajib',
          400
        );
      }
    } else if (delivery_mode === 'pickup') {
      if (!pickup_from_iso || !pickup_to_iso) {
        throwError('Untuk pickup: pickup_from dan pickup_to (ISO) wajib', 400);
      }
    } else {
      throwError('delivery_mode tidak valid', 400);
    }
  }

  // proses slot
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
      throwError('delivery_slot tidak valid', 400);
    } else {
      slotDt = maybeDt;
      slotLabel = providedSlot;
    }
  }

  if (
    slotLabel &&
    ft !== 'dine_in' &&
    delivery_mode === 'delivery' &&
    !isSlotAvailable(slotLabel, null, delivery_mode)
  ) {
    throwError('Slot sudah tidak tersedia / sudah lewat', 409);
  }

  let deliveryObj = {
    mode: ft === 'dine_in' ? 'none' : delivery_mode,
    slot_label: slotLabel || null,
    scheduled_at: slotDt ? slotDt.toDate() : null,
    status: 'pending'
  };

  let pickupWindowFrom = null;
  let pickupWindowTo = null;

  if (delivery_mode === 'pickup' && ft !== 'dine_in') {
    const f = dayjs(pickup_from_iso).tz(LOCAL_TZ);
    const t = dayjs(pickup_to_iso).tz(LOCAL_TZ);
    if (!f.isValid() || !t.isValid()) {
      throwError('pickup_from/pickup_to tidak valid ISO', 400);
    }
    pickupWindowFrom = f;
    pickupWindowTo = t;

    if (!pickupWindowFrom.isBefore(pickupWindowTo))
      throwError('pickup_window: from harus < to', 400);

    deliveryObj.pickup_window = {
      from: pickupWindowFrom.toDate(),
      to: pickupWindowTo.toDate()
    };

    if (!deliveryObj.scheduled_at) {
      deliveryObj.scheduled_at = pickupWindowFrom.toDate();
      deliveryObj.slot_label = pickupWindowFrom.format('HH:mm');
    }
  }

  // Delivery-specific: alamat & radius
  let delivery_fee = 0;
  if (ft !== 'dine_in' && delivery_mode === 'delivery') {
    const latN = Number(req.body?.lat);
    const lngN = Number(req.body?.lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
      throwError('Lokasi (lat,lng) wajib untuk delivery', 400);
    }
    const distance_km = haversineKm(CAFE_COORD, { lat: latN, lng: lngN });
    if (distance_km > Number(DELIVERY_MAX_RADIUS_KM || 0)) {
      throwError(`Di luar radius ${DELIVERY_MAX_RADIUS_KM} km`, 400);
    }
    deliveryObj.address_text = String(req.body?.address_text || '').trim();
    deliveryObj.location = { lat: latN, lng: lngN };
    deliveryObj.distance_km = Number(distance_km.toFixed(2));
    delivery_fee = calcDeliveryFee();
    deliveryObj.delivery_fee = delivery_fee;
  } else {
    deliveryObj.note_to_rider = String(req.body?.note_to_rider || '');
  }

  // normalize items
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
    // gunakan throwError agar error konsisten
    throwError(
      err?.message
        ? `Gagal menyimpan cart: ${String(err.message)}`
        : 'Gagal menyimpan cart',
      err?.status || 500
    );
  }

  // Voucher filter
  let eligibleClaimIds = [];
  if (MemberDoc) {
    if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
      const rawClaims = await VoucherClaim.find({
        _id: { $in: voucherClaimIds },
        member: MemberDoc._id,
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

  let priced;
  try {
    priced = await validateAndPrice({
      memberId: MemberDoc ? MemberDoc._id : null,
      cart: {
        items: cart.items.map((it) => ({
          menuId: it.menu,
          qty: it.quantity,
          price: it.base_price,
          category: it.category || null
        }))
      },
      fulfillmentType: ft,
      deliveryFee: delivery_fee,
      voucherClaimIds: eligibleClaimIds
    });
  } catch (err) {
    throwError(
      err?.message
        ? `Gagal menghitung harga: ${String(err.message)}`
        : 'Gagal menghitung harga',
      err?.status || 500
    );
  }

  const baseItemsSubtotal = int(priced.totals.baseSubtotal);
  const items_discount = int(priced.totals.itemsDiscount || 0);
  const shipping_discount = int(priced.totals.shippingDiscount || 0);
  const baseDelivery = int(priced.totals.deliveryFee || 0);

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
      baseDelivery -
      shipping_discount +
      taxAmount
  );

  const requested_bvt = int(roundRupiahCustom(beforeRound));
  const rounding_delta = int(requested_bvt - beforeRound);

  if (requested_bvt <= 0) {
    throwError('Total pembayaran tidak valid.', 400);
  }

  const payment_proof_url = await handleTransferProofIfAny(req, method);

  let payment_status = 'unpaid';
  let payment_provider = null;

  if (methodIsGateway) {
    payment_provider = 'xendit';
    payment_status = 'unpaid';
  } else if (requiresProof) {
    payment_status = 'unpaid';
  } else {
    payment_status = 'unpaid';
  }

  /* ===== Buat Order ===== */
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: MemberDoc ? MemberDoc._id : null,
          customer_name: MemberDoc ? MemberDoc.name || '' : customer_name,
          customer_phone: MemberDoc ? MemberDoc.phone || '' : customer_phone,
          table_number: ft === 'dine_in' ? cart.table_number ?? null : null,
          source: iden.source || 'online',
          fulfillment_type: ft,
          transaction_code: code,
          items: cart.items.map((it) => ({
            menu: it.menu,
            menu_code: it.menu_code,
            name: it.name,
            imageUrl: it.imageUrl,
            base_price: it.base_price,
            quantity: it.quantity,
            addons: it.addons,
            notes: String(it.notes || '').trim(),
            category: it.category || null
          })),
          // Totals
          items_subtotal: int(priced.totals.baseSubtotal),
          items_discount: int(priced.totals.itemsDiscount),
          delivery_fee: int(priced.totals.deliveryFee),
          shipping_discount: int(priced.totals.shippingDiscount),
          discounts: priced.breakdown || [],

          // Pajak & service & pembulatan
          service_fee: service_fee,
          tax_rate_percent: taxRatePercent,
          tax_amount: taxAmount,
          rounding_delta: rounding_delta,
          grand_total: requested_bvt,

          payment_method: method,
          payment_provider,
          payment_status,
          payment_proof_url: payment_proof_url || null,
          status: 'created',
          placed_at: new Date(),
          delivery: deliveryObj
        });
      } catch (e) {
        if (e?.code === 11000 && /transaction_code/.test(String(e.message)))
          continue;
        // gunakan throwError untuk konsistensi pesan
        throwError(
          e?.message
            ? `Gagal membuat order: ${String(e.message)}`
            : 'Gagal membuat order',
          e?.status || 500
        );
      }
    }
    // gagal setelah retry
    throwError('Gagal generate transaction_code unik', 500);
  })();

  /* ===== Konsumsi voucher ===== */
  if (MemberDoc) {
    for (const claimId of priced.chosenClaimIds || []) {
      try {
        const c = await VoucherClaim.findById(claimId);
        if (
          c &&
          c.status === 'claimed' &&
          String(c.member) === String(MemberDoc._id)
        ) {
          c.remainingUse -= 1;
          if (c.remainingUse <= 0) c.status = 'used';
          c.history.push({
            action: 'USE',
            ref: String(order._id),
            note: 'dipakai pada order'
          });
          await c.save();
        }
      } catch (_) {
        // jangan crash order kalau voucher gagal diupdate; log saja
        console.error('[voucher][consume] gagal update', _?.message || _);
      }
    }
  }

  /* ===== Tandai cart selesai ===== */
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
  } catch (err) {
    throwError(
      err?.message
        ? `Gagal update cart saat checkout: ${String(err.message)}`
        : 'Gagal update cart saat checkout',
      err?.status || 500
    );
  }

  /* ===== Statistik member ===== */
  if (MemberDoc) {
    try {
      await Member.findByIdAndUpdate(MemberDoc._id, {
        $inc: { total_spend: order.grand_total || 0 },
        $set: { last_visit_at: new Date() }
      });
    } catch (err) {
      // jangan gagalkan checkout kalau statistik gagal; log saja
      console.error('[member][stats] gagal update', err?.message || err);
    }
  }

  /* ===== Emit realtime & guest token handling ===== */
  try {
    // jika guest (bukan member), buat guestToken dan simpan di order
    if (!MemberDoc) {
      // jika order belum punya guestToken, buat
      const guestToken = uuidv4();
      order.guestToken = guestToken;
      await Order.findByIdAndUpdate(
        order._id,
        { $set: { guestToken } },
        { new: true }
      ).catch(() => {});
    }

    // payload ringkas (sudah ada di variabel payload sebelumnya — tapi lebih konsisten gunakan makeOrderSummary)
    const summary = makeOrderSummary(order);

    // emit ke staff/kasir/kitchen
    emitToStaff('order:new', summary);
    emitToCashier('order:new', summary); // opsional: khusus kasir jika ingin

    // emit ke member atau guest
    if (MemberDoc) {
      emitToMember(String(MemberDoc._id), 'order:created', summary);
    } else if (order.guestToken) {
      emitToGuest(order.guestToken, 'order:created', summary);
    }
  } catch (err) {
    console.error('[emit][checkout] error', err?.message || err);
  }

  try {
    const uiTotals = {
      items_subtotal: order.items_subtotal || 0,
      delivery_fee: order.delivery_fee || (order.delivery?.delivery_fee ?? 0),
      service_fee: order.service_fee || 0,
      items_discount: order.items_discount || 0,
      shipping_discount: order.shipping_discount || 0,
      discounts: order.discounts || [],
      tax_rate_percent: order.tax_rate_percent || 0,
      tax_amount: order.tax_amount || 0,
      grand_total: order.grand_total || 0,
      rounding_delta: order.rounding_delta || 0
    };

    await snapshotOrder(order._id, { uiTotals }).catch(() => {});
  } catch (e) {
    console.error('[OrderHistory][checkout]', e?.message || e);
  }

  res.status(201).json({
    order: order.toObject(),
    totals: {
      items_subtotal: order.items_subtotal,
      service_fee: order.service_fee,
      items_discount: order.items_discount,
      delivery_fee: order.delivery_fee,
      shipping_discount: order.shipping_discount,
      tax_rate_percent: order.tax_rate_percent,
      tax_amount: order.tax_amount,
      rounding_delta: order.rounding_delta,
      grand_total: order.grand_total
    },
    message:
      payment_status === 'unpaid'
        ? 'Checkout berhasil. Silakan lanjutkan pembayaran.'
        : 'Checkout berhasil.'
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
  const table_number = Number(req.body?.table_number) || 0;
  if (!table_number) throwError('table_number wajib', 400);

  let sessionId = iden.session_id || req.cookies?.[DEVICE_COOKIE];
  if (!sessionId && !iden.memberId) {
    sessionId = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, sessionId, {
      ...baseCookie,
      httpOnly: false,
      maxAge: REFRESH_TTL_MS
    });
  }

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

  res.json({ message: 'Nomor meja diset', cart: cart.toObject() });
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
  if (source) q.source = source; // 'qr' | 'pos' | 'online'
  if (fulfillment_type) q.fulfillment_type = fulfillment_type; // 'dine_in' | 'delivery'
  if (cursor) q.createdAt = { $lt: new Date(cursor) };

  const items = await Order.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 20, 100))
    .lean();

  res.status(200).json({
    items,
    next_cursor: items.length ? items[items.length - 1].createdAt : null
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
              payment_status: { $in: ['paid', 'verified'] },
              // payment_status: 'verified' },
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
  const order = await Order.findById(req.params.id).lean();
  if (!order) throwError('Order tidak ditemukan', 404);
  if (String(order.member) !== String(req.member.id))
    throwError('Tidak berhak mengakses order ini', 403);
  res.status(200).json(order);
});

exports.previewPrice = asyncHandler(async (req, res) => {
  if (!req.member?.id) throwError('Harus login sebagai member', 401);

  const {
    cart,
    fulfillmentType = 'dine_in',
    voucherClaimIds = [],
    delivery_mode: deliveryModeFromBody = null
  } = req.body || {};

  if (!cart?.items?.length) throwError('Cart kosong', 400);

  // ===== filter voucher milik member & masih valid =====
  let eligible = [];
  if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
    const raw = await VoucherClaim.find({
      _id: { $in: voucherClaimIds },
      member: req.member.id,
      status: 'claimed'
    }).lean();
    const now = new Date();
    eligible = raw
      .filter((c) => !c.validUntil || c.validUntil > now)
      .map((c) => String(c._id));
  }

  // ===== tentukan delivery_mode efektif (FE wajib kirim delivery_mode supaya jelas) =====
  const deliveryMode =
    (typeof deliveryModeFromBody === 'string' &&
      deliveryModeFromBody.trim().toLowerCase()) ||
    (fulfillmentType === 'delivery' ? 'delivery' : 'none');

  // ===== delivery fee policy: kalau mode === 'delivery' pakai ENV DELIVERY_FLAT_FEE, else 0 =====
  const envDeliveryFee = Number(process.env.DELIVERY_FLAT_FEE || 0) || 0;
  const effectiveDeliveryFee =
    fulfillmentType === 'delivery' && deliveryMode === 'delivery'
      ? envDeliveryFee
      : 0;

  // ===== NORMALISASI CART ITEMS untuk validateAndPrice =====
  const normalizedCart = {
    items: (Array.isArray(cart.items) ? cart.items : []).map((it) => {
      const addons = Array.isArray(it.addons) ? it.addons : [];
      const addonsPerUnit = addons.reduce((s, a) => {
        const ap = Number(a?.price || 0);
        const aq = Number(a?.qty || 1);
        return s + ap * aq;
      }, 0);
      const unitBase = Number(it.base_price ?? it.price ?? it.unit_price ?? 0);
      const unitPrice = int(unitBase + addonsPerUnit);
      return {
        menuId: it.menu || it.menuId || it.id || null,
        qty: Number(it.quantity ?? it.qty ?? 0),
        price: unitPrice,
        category: it.category ?? it.cat ?? null
      };
    })
  };

  // ===== panggil price engine =====
  const result = await validateAndPrice({
    memberId: req.member.id,
    cart: normalizedCart,
    fulfillmentType,
    deliveryFee:
      fulfillmentType === 'delivery' ? Number(effectiveDeliveryFee || 0) : 0,
    voucherClaimIds: eligible
  });

  // ===== bangun ui_totals (fallback ke effectiveDeliveryFee kalau engine tidak mengembalikan deliveryFee) =====
  const t = result.totals || {};
  const ui_totals = {
    items_subtotal: Number(t.baseSubtotal || 0),
    items_subtotal_after_discount: Number(
      t.items_subtotal_after_discount || t.baseSubtotalAfterDiscount || 0
    ),
    items_discount: Number(t.itemsDiscount || 0),
    service_fee: Number(t.service_fee || 0),
    tax_amount: Number(t.tax_amount || 0),
    delivery_fee: Number(t.deliveryFee ?? effectiveDeliveryFee ?? 0),
    shipping_discount: Number(t.shippingDiscount || 0),
    rounding_delta: Number(t.rounding_delta || 0),
    grand_total: Number(t.grandTotal || t.grand_total || 0),
    grand_total_with_delivery: Number(t.grandTotal || t.grand_total || 0)
  };

  return res.status(200).json({
    ok: result.ok,
    reasons: result.reasons || [],
    breakdown: result.breakdown || [],
    ui_totals
  });
});

/* ===================== STAFF / OWNER ENDPOINTS ===================== */
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

  const items = await Order.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 50, 200))
    .lean();

  res.status(200).json({
    items,
    next_cursor: items.length ? items[items.length - 1].createdAt : null
  });
});

exports.getDetailOrder = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!req.user) throwError('Unauthorized', 401);
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  // populate member (ambil hanya name & phone)
  const order = await Order.findById(id)
    .populate({ path: 'member', select: 'name phone' })
    .lean();
  if (!order) throwError('Order tidak ditemukan', 404);

  const safeNumber = (v) => (Number.isFinite(+v) ? +v : 0);

  // Susun response yang bersih / minimal (aggregate approach)
  const slim = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    customer: {
      // prioritas: member (populate) -> explicit customer_name/phone di order
      name: order.member?.name || order.customer_name || null,
      phone: order.member?.phone || order.customer_phone || null
    },
    fulfillment_type: order.fulfillment_type || null,
    table_number: order.table_number ?? null,
    // items: show base price, addons and line_subtotal (no per-item tax/service)
    items: (order.items || []).map((it) => {
      const qty = safeNumber(it.quantity || 0);
      const basePrice = safeNumber(it.base_price || 0);

      const addons_unit = (it.addons || []).reduce(
        (s, a) => s + (Number.isFinite(+a.price) ? +a.price : 0) * (a.qty || 1),
        0
      );

      const unit_before_tax = basePrice + addons_unit;
      const line_subtotal = Number(it.line_subtotal ?? unit_before_tax * qty);

      return {
        name: it.name,
        menu: String(it.menu || ''),
        menu_code: it.menu_code || '',
        qty,
        base_price: basePrice,
        addons: (it.addons || []).map((a) => ({
          name: a.name,
          price: safeNumber(a.price),
          qty: a.qty || 1
        })),
        notes: it.notes || '',
        line_subtotal
      };
    }),
    totals: {
      items_subtotal: safeNumber(order.items_subtotal || 0), // BEFORE tax
      service_fee: safeNumber(order.service_fee || 0),
      delivery_fee: safeNumber(order.delivery_fee || 0),
      items_discount: safeNumber(order.items_discount || 0),
      shipping_discount: safeNumber(order.shipping_discount || 0),
      tax_rate_percent: safeNumber(
        order.tax_rate_percent || Math.round((parsePpnRate() || 0.11) * 100)
      ),
      tax_amount: safeNumber(order.tax_amount || 0),
      rounding_delta: safeNumber(order.rounding_delta || 0),
      grand_total: safeNumber(order.grand_total || 0)
    },
    payment: {
      method: order.payment_method || null,
      provider: order.payment_provider || null,
      status: order.payment_status || null,
      proof_url: order.payment_proof_url || null,
      paid_at: order.paid_at || null
    },
    status: order.status || null,
    placed_at: order.placed_at || null,
    created_at: order.createdAt || null,
    updated_at: order.updatedAt || null,
    delivery: order.delivery
      ? {
          mode: order.delivery.mode || null,
          address_text: order.delivery.address_text || null,
          location:
            order.delivery.location &&
            typeof order.delivery.location.lat === 'number'
              ? {
                  lat: order.delivery.location.lat,
                  lng: order.delivery.location.lng
                }
              : null,
          distance_km: order.delivery.distance_km ?? null,
          delivery_fee: order.delivery.delivery_fee ?? null,
          slot_label: order.delivery.slot_label || null,
          scheduled_at: order.delivery.scheduled_at || null,
          status: order.delivery.status || null
        }
      : null
  };

  return res.status(200).json({ success: true, order: slim });
});

const buildOrderReceipt = (order) => {
  if (!order) return null;

  const displayName = order.member?.name || order.customer_name || '';
  const displayPhone = order.member?.phone || order.customer_phone || '';

  const items = Array.isArray(order.items) ? order.items : [];

  // compute items_subtotal from items (menu base + addons * qty) — authoritative
  const computeLineSubtotal = (it) => {
    const unitBase = Number(it.base_price || 0);
    const addonsUnit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const qty = Number(it.quantity || it.qty || 0);
    return int((unitBase + addonsUnit) * qty);
  };

  const items_subtotal = items.reduce(
    (s, it) => s + computeLineSubtotal(it),
    0
  );

  // items_discount: prefer explicit field order.items_discount, fallback to sum of breakdown itemsDiscount
  let items_discount = Number(order.items_discount || 0);
  if (!items_discount || items_discount === 0) {
    const discounts = Array.isArray(order.discounts) ? order.discounts : [];
    const sumFromBreakdown = discounts.reduce(
      (sum, d) => sum + Number(d.itemsDiscount || d.items_discount || 0),
      0
    );
    // choose max of explicit or breakdown-sum (defensive)
    items_discount = Math.max(items_discount, sumFromBreakdown);
  }

  // shipping discount: prefer explicit, fallback to sum of shippingDiscount from breakdown
  let shipping_discount = Number(order.shipping_discount || 0);
  if (!shipping_discount || shipping_discount === 0) {
    const discounts = Array.isArray(order.discounts) ? order.discounts : [];
    const sumShip = discounts.reduce(
      (sum, d) => sum + Number(d.shippingDiscount || d.shipping_discount || 0),
      0
    );
    shipping_discount = Math.max(shipping_discount, sumShip);
  }

  const delivery_fee = Number(
    order.delivery?.delivery_fee ?? order.delivery_fee ?? 0
  );

  // items subtotal after discount (taxable base)
  const items_subtotal_after_discount = Math.max(
    0,
    items_subtotal - items_discount
  );

  // service fee & tax (use project helpers for exact same logic as checkout)
  const service_fee = int(
    Math.round(items_subtotal_after_discount * Number(SERVICE_FEE_RATE))
  );

  const ppnRate = parsePpnRate();
  const tax_amount = int(Math.round(items_subtotal_after_discount * ppnRate));

  // raw total before rounding (same formula as checkout)
  const raw_total_before_rounding =
    items_subtotal_after_discount +
    service_fee +
    Number(delivery_fee || 0) -
    shipping_discount +
    tax_amount;

  // rounding delta and grand total: prefer stored order.grand_total if present (checkout source of truth)
  const grand_total_from_order =
    typeof order.grand_total !== 'undefined' ? int(order.grand_total) : null;
  const rounded =
    grand_total_from_order !== null
      ? grand_total_from_order
      : int(roundRupiahCustom(raw_total_before_rounding));
  const rounding_delta = int(rounded - int(raw_total_before_rounding));

  // Build detailed items list (unit price incl. addons, line subtotal)
  const detailedItems = items.map((it) => {
    const qty = Number(it.quantity || it.qty || 0);
    const unit_base = Number(it.base_price || 0);
    const addons_unit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const unit_before_tax = int(unit_base + addons_unit);
    const line_before_tax = int(it.line_subtotal ?? computeLineSubtotal(it));

    return {
      name: it.name,
      menu_code: it.menu_code || '',
      quantity: qty,
      addons: (it.addons || []).map((ad) => ({
        name: ad.name,
        price: int(ad.price || 0),
        qty: int(ad.qty || 1)
      })),
      unit_price: unit_before_tax,
      line_before_tax
    };
  });

  return {
    id: String(order._id),
    transaction_code: order.transaction_code || '',
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,

    pricing: {
      // before-tax and with-tax values
      items_subtotal: int(items_subtotal),
      items_subtotal_after_discount: int(items_subtotal_after_discount),
      items_discount: int(items_discount),
      service_fee: int(service_fee),
      delivery_fee: int(delivery_fee),
      shipping_discount: int(shipping_discount),
      tax_amount: int(tax_amount),
      tax_rate_percent: Number(
        order.tax_rate_percent || Math.round(ppnRate * 100)
      ),
      rounding_delta: int(rounding_delta),
      grand_total: int(rounded),
      raw_total_before_rounding: int(raw_total_before_rounding)
    },

    customer: {
      name: displayName,
      phone: displayPhone
    },

    fulfillment: {
      type: order.fulfillment_type,
      table_number:
        order.fulfillment_type === 'dine_in'
          ? order.table_number || null
          : null,
      delivery:
        order.fulfillment_type === 'delivery' && order.delivery
          ? {
              address_text: order.delivery.address_text || '',
              distance_km: order.delivery.distance_km || null,
              note_to_rider: order.delivery.note_to_rider || ''
            }
          : null
    },

    items: detailedItems,

    timestamps: {
      placed_at: order.placed_at,
      paid_at: order.paid_at || null
    }
  };
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

exports.listKitchenOrders = asyncHandler(async (_req, res) => {
  const items = await Order.find({
    status: 'accepted',
    payment_status: 'verified'
  })
    .sort({ placed_at: 1 })
    .lean();
  res.status(200).json({ items });
});

/* ===================== POS DINE-IN (staff) ===================== */
exports.createPosDineIn = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    table_number,
    items,
    as_member = false,
    member_id,
    name,
    phone,
    payment_method
  } = req.body || {};

  // ===== Validasi meja & item =====
  const tableNo = asInt(table_number, 0);
  if (!tableNo) throwError('table_number wajib', 400);
  if (!Array.isArray(items) || !items.length) throwError('items wajib', 400);

  // ===== Metode bayar POS =====
  const PM_POS = { CASH: 'cash', QRIS: 'qris', CARD: 'card' };
  const ALLOWED_PM_POS = [PM_POS.CASH, PM_POS.QRIS, PM_POS.CARD];
  const method = String(payment_method || '').toLowerCase();
  if (!ALLOWED_PM_POS.includes(method)) {
    throwError('payment_method POS tidak valid (cash|qris|card)', 400);
  }

  // ===== Member / Guest =====
  let member = null;
  let customer_name = '';
  let customer_phone = '';

  if (as_member) {
    if (!member_id && !(name && phone)) {
      throwError('Sertakan member_id atau name+phone', 400);
    }
    if (member_id) {
      member = await Member.findById(member_id).lean();
      if (!member) throwError('Member tidak ditemukan', 404);
    } else {
      const normalizedPhone = normalizePhone(phone);
      let existing = await Member.findOne({ phone: normalizedPhone }).lean();
      if (!existing) {
        const created = await Member.create({
          name: String(name).trim(),
          phone: normalizedPhone,
          join_channel: 'pos',
          visit_count: 1,
          last_visit_at: new Date(),
          is_active: true
        });
        existing = created.toObject();
      }
      member = existing;
    }
  } else {
    customer_name = String(name || '').trim();
    customer_phone = String(phone || '').trim();
    if (!customer_name && !customer_phone) {
      throwError('Tanpa member: isi minimal nama atau no. telp', 400);
    }
  }

  // ===== Build items & subtotal =====
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
      (s, a) => s + (a.price || 0) * (a.qty || 1),
      0
    );
    const unit = priceFinal(menu.price);
    const line_subtotal = (unit + addonsTotal) * qty;

    orderItems.push({
      menu: menu._id,
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

  // ===== Aggregate service & tax & rounding =====
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
  const taxBase = itemsSubtotal; // POS: no voucher, no delivery
  const taxAmount = int(Math.max(0, Math.round(taxBase * rate)));

  const rawBeforeRound = itemsSubtotal + serviceFee + taxAmount;
  const grandTotal = int(roundRupiahCustom(rawBeforeRound));
  const roundingDelta = int(grandTotal - rawBeforeRound);

  const now = new Date();

  // ===== Create order (langsung verified) =====
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

          items: orderItems,
          total_quantity: totalQty,

          // totals
          items_subtotal: itemsSubtotal,
          items_discount: 0,
          delivery_fee: 0,
          shipping_discount: 0,
          discounts: [],
          service_fee: serviceFee,
          tax_rate_percent: taxRatePercent,
          tax_amount: taxAmount,
          rounding_delta: roundingDelta,
          grand_total: grandTotal,

          // pembayaran: langsung verified
          payment_method: method,
          payment_status: 'verified',
          paid_at: now,
          verified_by: req.user?.id || null,
          verified_at: now,

          status: 'created',
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

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: member
      ? { id: String(member._id), name: member.name, phone: member.phone }
      : null,
    customer: !member ? { name: customer_name, phone: customer_phone } : null,
    table_number: order.table_number,
    items_total: order.items_subtotal,
    grand_total: order.grand_total,
    total_quantity: order.total_quantity,
    line_count: order.items?.length || 0,
    source: order.source,
    fulfillment_type: order.fulfillment_type,
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    paid_at: order.paid_at || null,
    payment_proof_url: order.payment_proof_url || '',
    placed_at: order.placed_at,
    cashier: req.user ? { id: String(req.user.id), name: req.user.name } : null
  };

  try {
    const uiTotals = {
      items_subtotal: order.items_subtotal,
      delivery_fee: order.delivery_fee || 0,
      service_fee: order.service_fee || 0,
      items_discount: order.items_discount || 0,
      shipping_discount: order.shipping_discount || 0,
      discounts: order.discounts || [],
      tax_rate_percent: order.tax_rate_percent,
      tax_amount: order.tax_amount,
      grand_total: order.grand_total,
      rounding_delta: order.rounding_delta
    };

    await snapshotOrder(order._id, {
      uiTotals,
      verified_by_name: req.user?.name
    }).catch(() => {});
  } catch (e) {
    console.error('[OrderHistory][createPosDineIn]', e?.message || e);
  }

  try {
    const summary = makeOrderSummary(order);

    emitToStaff('order:new', summary);
    emitToCashier('order:new', summary); // kasir khusus
    emitToKitchen('order:new', summary);

    if (member) {
      emitToMember(String(member._id), 'order:created', summary);
    } else {
      // POS guest: buat guestToken agar device pelanggan bisa rejoin/terima notifikasi
      const guestToken = uuidv4();
      await Order.findByIdAndUpdate(order._id, { $set: { guestToken } }).catch(
        () => {}
      );
      emitToGuest(guestToken, 'order:created', summary);
    }
  } catch (err) {
    console.error('[emit][createPosDineIn]', err?.message || err);
  }

  res.status(201).json({
    order: { ...order.toObject(), transaction_code: order.transaction_code },
    message: 'Order POS dine-in dibuat & langsung verified'
  });
});

exports.previewPosOrder = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { items } = req.body || {};
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
      (s, a) => s + (a.price || 0) * (a.qty || 1),
      0
    );
    const unit = priceFinal(menu.price);
    const line_subtotal = (unit + addonsTotal) * qty;

    orderItems.push({
      menu: menu._id,
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

  // Aggregate service & tax
  const sfRate = Number(SERVICE_FEE_RATE || 0);
  const serviceFee = int(Math.round(itemsSubtotal * sfRate));

  const rawRate = Number(process.env.PPN_RATE ?? 0.11);
  const rate = Number.isFinite(rawRate)
    ? rawRate > 1
      ? rawRate / 100
      : rawRate
    : parsePpnRate();
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;
  const taxBase = itemsSubtotal;
  const taxAmount = int(Math.max(0, Math.round(taxBase * rate)));

  const rawBeforeRound = itemsSubtotal + serviceFee + taxAmount;
  const grandTotal = int(roundRupiahCustom(rawBeforeRound));
  const roundingDelta = int(grandTotal - rawBeforeRound);

  res.json({
    success: true,
    preview: {
      items: orderItems,
      total_quantity: totalQty,
      items_subtotal: itemsSubtotal,
      items_discount: 0,
      delivery_fee: 0,
      shipping_discount: 0,
      service_fee: serviceFee,
      tax_rate_percent: taxRatePercent,
      tax_amount: taxAmount,
      grand_total: grandTotal,
      rounding_delta: roundingDelta
    }
  });
});

exports.completeOrder = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Data order tidak ditemukan', 404);

  if (order.status !== 'accepted') {
    throwError(
      'Hanya pesanan dengan status diterima yang bisa diselesaikan',
      409
    );
  }

  order.status = 'completed';
  await order.save();
  // history: order completed
  try {
    await recordOrderHistory(order._id, 'order_status', req.user, {
      from: 'accepted',
      to: 'completed',
      note: 'Pesanan selesai',
      at: new Date()
    });
    // snapshot final
    await snapshotOrder(order._id, { verified_by_name: req.user?.name }).catch(
      () => {}
    );
  } catch (e) {
    console.error('[OrderHistory][completeOrder]', e?.message || e);
  }

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    status: order.status
  };
  try {
    emitToStaff('order:completed', payload);
    emitToCashier('order:completed', payload);
    emitToKitchen('order:completed', payload);

    if (order.member)
      emitToMember(String(order.member), 'order:completed', payload);
    if (order.guestToken)
      emitToGuest(order.guestToken, 'order:completed', payload);
  } catch (err) {
    console.error('[emit][completeOrder]', err?.message || err);
  }

  res.status(200).json({ message: 'Pesanan selesai', order });
});

exports.acceptAndVerify = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const order = await Order.findById(req.params.id).lean(); // pakai lean dulu untuk cek
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.status !== 'created') {
    throwError('Hanya pesanan berstatus created yang bisa diterima', 409);
  }
  if (order.payment_status !== 'paid') {
    throwError('Pembayaran belum paid. Tidak bisa verifikasi.', 409);
  }

  const doc = await Order.findById(req.params.id);
  doc.status = 'accepted';
  doc.payment_status = 'verified';
  doc.verified_by = req.user._id;
  doc.verified_at = new Date();
  if (!doc.placed_at) doc.placed_at = new Date();
  await doc.save();

  if (!doc.loyalty_awarded_at) {
    await awardPointsIfEligible(doc, Member);
  }

  // history: payment verified & order accepted
  try {
    await recordOrderHistory(doc._id, 'payment_status', req.user, {
      from: 'unpaid',
      to: doc.payment_status,
      note: 'Pembayaran diverifikasi & order diterima',
      at: doc.verified_at
    });

    // optional: snapshot saat verified (recommended for accurate price snapshot)
    await snapshotOrder(doc._id, {
      uiTotals: {
        items_subtotal: doc.items_subtotal,
        delivery_fee: doc.delivery_fee,
        service_fee: doc.service_fee,
        items_discount: doc.items_discount,
        shipping_discount: doc.shipping_discount,
        discounts: doc.discounts,
        tax_rate_percent: doc.tax_rate_percent,
        tax_amount: doc.tax_amount,
        grand_total: doc.grand_total,
        rounding_delta: doc.rounding_delta
      },
      verified_by_name: req.user?.name
    }).catch(() => {});
  } catch (e) {
    console.error('[OrderHistory][acceptAndVerify]', e?.message || e);
  }

  const payload = {
    id: String(doc._id),
    transaction_code: doc.transaction_code,
    status: doc.status,
    payment_status: doc.payment_status,
    verified_by: { id: String(req.user._id), name: req.user.name },
    at: doc.verified_at
  };
  try {
    emitToStaff('order:accepted_verified', payload);
    emitToKitchen('order:accepted_verified', payload);
    emitToCashier('order:accepted_verified', payload);

    if (doc.member)
      emitToMember(String(doc.member), 'order:accepted_verified', payload);
    if (doc.guestToken)
      emitToGuest(doc.guestToken, 'order:accepted_verified', payload);
  } catch (err) {
    console.error('[emit][acceptAndVerify]', err?.message || err);
  }

  (async () => {
    try {
      const full = await Order.findById(doc._id).lean();
      const phone = (full.customer_phone || '').trim();
      if (!phone) return;

      const wa = toWa62(phone);
      const message = buildOrderReceiptMessage(full);
      await sendText(wa, message);
    } catch (e) {
      console.error('[WA receipt] failed:', e?.message || e);
    }
  })();

  res
    .status(200)
    .json({ message: 'Pesanan diterima & diverifikasi', order: doc });
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
  const $set = {
    'delivery.status': 'assigned',
    'delivery.courier': {
      id: courier_id || null,
      name: String(courier_name || '').trim(),
      phone: toWa62(courier_phone)
    },
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
      assigned_at: updated.delivery?.assigned_at
    }
  };

  try {
    emitToStaff('order:delivery_assigned', payload);
    emitToCashier('order:delivery_assigned', payload);

    if (updated.member)
      emitToMember(String(updated.member), 'order:delivery_assigned', payload);
    if (updated.guestToken)
      emitToGuest(updated.guestToken, 'order:delivery_assigned', payload);

    // emit ke kurir personal kalau ada id
    if (updated.delivery?.courier?.id) {
      emitToCourier(
        String(updated.delivery.courier.id),
        'order:assign:courier',
        payload
      );
    }
  } catch (err) {
    console.error('[emit][assignDelivery]', err?.message || err);
  }

  res.status(200).json({
    message: 'Kurir berhasil di-assign (manual)',
    order: updated.toObject()
  });
});

// POST /orders/assign-batch
// body: { slot_label: "12:00", scheduled_at?: "2025-11-09T12:00:00+07:00", courier_id, courier_name, courier_phone, limit?: number }
exports.assignBatch = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    slot_label,
    scheduled_at, // optional ISO string
    courier_id,
    courier_name,
    courier_phone,
    note,
    limit = 0 // optional safety cap (0 = no cap)
  } = req.body || {};

  if (!slot_label && !scheduled_at) {
    throwError('slot_label atau scheduled_at wajib untuk batch assign', 400);
  }
  if (!courier_name && !courier_id) {
    throwError('courier_name atau courier_id wajib', 400);
  }

  // Tentukan datetime slot (kalau ada scheduled_at, pakai; kalau tidak, hitung dari slot_label hari ini)
  let slotDt = null;
  if (scheduled_at) {
    slotDt = dayjs(scheduled_at).tz(LOCAL_TZ);
    if (!slotDt.isValid()) throwError('scheduled_at tidak valid', 400);
  } else {
    slotDt = parseSlotLabelToDate(slot_label); // helper yang sudah ada
    if (!slotDt || !slotDt.isValid()) throwError('slot_label tidak valid', 400);
  }

  // Match criteria: slot_label dan scheduled_at exact (menghindari ambiguitas hari lain)
  const match = {
    fulfillment_type: 'delivery',
    'delivery.slot_label': slot_label,
    'delivery.scheduled_at': slotDt.toDate(),
    payment_status: 'paid',
    status: { $ne: 'cancelled' },
    'delivery.status': 'pending' // hanya yang masih pending
  };

  // Safety check: optional limit
  if (limit > 0) {
    const count = await Order.countDocuments(match);
    if (count === 0) {
      return res
        .status(200)
        .json({ message: 'Tidak ada order pending di slot ini' });
    }
    if (count > limit) {
      throwError(
        `Jumlah order (${count}) melebihi limit batch (${limit}). Batalkan atau turunkan limit.`,
        409
      );
    }
  }

  const now = new Date();
  const setObj = {
    'delivery.status': 'assigned',
    'delivery.courier': {
      id: courier_id || null,
      name: String(courier_name || '').trim(),
      phone: toWa62(courier_phone)
    },
    'delivery.assigned_at': now
  };
  if (note) setObj['delivery.assign_note'] = String(note).trim();

  const updateRes = await Order.updateMany(match, { $set: setObj });

  // ambil semua yang berhasil diassign untuk payload (optional: ambil ringkasan saja)
  const updatedOrders = await Order.find({
    ...match
  }).lean();

  // Emit satu event batch plus event per member/order jika perlu
  emitToStaff('orders:batch_assigned', {
    slot_label,
    scheduled_at: slotDt.toISOString(),
    courier: setObj['delivery.courier'],
    count: updateRes.nModified || updateRes.modifiedCount || updateRes.n || 0
  });

  for (const u of updatedOrders) {
    const p = {
      id: String(u._id),
      transaction_code: u.transaction_code,
      delivery: {
        status: u.delivery?.status,
        courier: u.delivery?.courier,
        assigned_at: u.delivery?.assigned_at
      }
    };
    if (u.member) emitToMember(String(u.member), 'order:delivery_assigned', p);
    if (u.guestToken) emitToGuest(u.guestToken, 'order:delivery_assigned', p);
    if (u.delivery?.courier?.id)
      emitToCourier(String(u.delivery.courier.id), 'order:assign:courier', p);
  }

  res.json({
    success: true,
    message: `Batch assign selesai. ${
      updateRes.nModified || updateRes.modifiedCount || 0
    } order diassign ke kurir.`,
    affected: updateRes
  });
});

exports.updateDeliveryStatus = asyncHandler(async (req, res) => {
  // boleh diakses oleh staff/kasir/kurir tergantung policy; cek user dulu
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

exports.deliveryBoard = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status, paid_only = 'false', limit = 50, cursor } = req.query || {};
  const q = {
    fulfillment_type: 'delivery'
  };

  if (status && DELIVERY_ALLOWED.includes(status)) {
    q['delivery.status'] = status;
  } else {
    q['delivery.status'] = { $nin: ['delivered', 'failed'] };
  }

  if (String(paid_only) === 'true') q.payment_status = 'paid';
  if (cursor) q.createdAt = { $lt: new Date(cursor) };

  const items = await Order.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 50, 200))
    .lean();

  res.status(200).json({
    items: items.map((o) => ({
      _id: o._id,
      transaction_code: o.transaction_code,
      member: o.member || null,
      grand_total: o.grand_total,
      payment_status: o.payment_status,
      order_status: o.status,
      delivery: o.delivery || null,
      createdAt: o.createdAt
    })),
    next_cursor: items.length ? items[items.length - 1].createdAt : null
  });
});

exports.listEmployeesDropdown = asyncHandler(async (req, res) => {
  const employees = await User.find({ role: 'employee' })
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

exports.listTodayOrders = asyncHandler(async (req, res) => {
  // Hitung range hari ini di timezone lokal
  const startOfDay = dayjs().tz(LOCAL_TZ).startOf('day').toDate();
  const endOfDay = dayjs().tz(LOCAL_TZ).endOf('day').toDate();

  const filter = {
    placed_at: { $gte: startOfDay, $lte: endOfDay },
    status: { $ne: 'cancelled' } // kalau mau termasuk cancelled, hapus baris ini
  };

  const orders = await Order.find(filter)
    .sort({ placed_at: -1, createdAt: -1 })
    .select({
      transaction_code: 1,
      fulfillment_type: 1,
      table_number: 1,
      source: 1,

      customer_name: 1,
      customer_phone: 1,

      items_subtotal: 1,
      service_fee: 1,
      delivery_fee: 1,
      items_discount: 1,
      shipping_discount: 1,
      tax_amount: 1,
      rounding_delta: 1,
      grand_total: 1,

      payment_method: 1,
      payment_status: 1,

      status: 1,
      placed_at: 1,
      paid_at: 1
    })
    .lean({ virtuals: true });

  // Kalau mau sekalian kasih ringkasan item tanpa detail panjang, bisa embed dikit:
  const mapped = orders.map((o) => ({
    id: String(o._id),
    transaction_code: o.transaction_code,
    status: o.status,
    payment_status: o.payment_status,
    payment_method: o.payment_method,

    fulfillment_type: o.fulfillment_type,
    table_number:
      o.fulfillment_type === 'dine_in' ? o.table_number || null : null,

    customer: {
      name: o.customer_name || '',
      phone: o.customer_phone || ''
    },

    totals: {
      items_subtotal: o.items_subtotal,
      service_fee: o.service_fee,
      delivery_fee: o.delivery_fee,
      items_discount: o.items_discount,
      shipping_discount: o.shipping_discount,
      tax_amount: o.tax_amount,
      rounding_delta: o.rounding_delta,
      grand_total: o.grand_total
    },

    placed_at: o.placed_at,
    paid_at: o.paid_at || null
  }));

  return res.json({
    success: true,
    data: mapped
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
  const keyword = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 20, 100); // batas aman max 100

  // base filter
  const filter = { is_active: true };

  if (keyword) {
    // cari nama atau phone yang mengandung keyword (case-insensitive)
    filter.$or = [
      { name: { $regex: keyword, $options: 'i' } },
      { phone: { $regex: keyword.replace(/\D+/g, ''), $options: 'i' } } // hilangkan non-digit
    ];
  }

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
  const userId =
    req.user?.id ||
    req.user?._id ||
    req.user?._doc?._id || // defensif kalau mongoose doc
    req.user?.userId ||
    null;

  if (!userId) {
    throwError('Harus login sebagai kurir untuk mengakses endpoint ini', 401);
  }

  // pagination
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20)
  );
  const skip = (page - 1) * limit;

  // optional: filter by delivery.status jika dikirim query ?status=assigned
  const deliveryStatus = req.query.status
    ? String(req.query.status).toLowerCase()
    : null;

  // query dasar: hanya delivery orders yang assigned ke kurir ini
  const q = {
    fulfillment_type: 'delivery',
    'delivery.mode': 'delivery',
    // support dua pola: assignee.user bisa string id atau object with id
    $or: [
      { 'delivery.assignee.user': userId },
      { 'delivery.assignee.user.id': userId },
      { 'delivery.courier.id': userId } // fallback jika disimpan di courier
    ],
    // exclude cancelled orders by default
    status: { $ne: 'cancelled' }
  };

  if (deliveryStatus) {
    q['delivery.status'] = deliveryStatus;
  }

  // count & fetch
  const [total, orders] = await Promise.all([
    Order.countDocuments(q),
    Order.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('member', 'name phone')
      .populate('items.menu', 'name')
      .lean()
  ]);

  const mapped = (orders || []).map((o) => ({
    _id: o._id,
    transaction_code: o.transaction_code,
    placed_at: o.placed_at,
    fulfillment_type: o.fulfillment_type,
    payment_method: o.payment_method,
    payment_status: o.payment_status,
    status: o.status,
    grand_total: o.grand_total,
    delivery: {
      mode: o.delivery?.mode,
      status: o.delivery?.status,
      slot_label: o.delivery?.slot_label,
      scheduled_at: o.delivery?.scheduled_at,
      address_text: o.delivery?.address_text,
      location: o.delivery?.location,
      distance_km: o.delivery?.distance_km,
      delivery_fee: o.delivery?.delivery_fee,
      assignee: o.delivery?.assignee || o.delivery?.courier || {}
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
      menu: it.menu ? (typeof it.menu === 'object' ? it.menu : it.menu) : null,
      addons: it.addons || []
    }))
  }));

  res.json({
    ok: true,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    },
    data: mapped
  });
});
