// controllers/orderController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const axios = require('axios');

const PaymentSession = require('../models/paymentSessionModel');
const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const User = require('../models/userModel');
const Member = require('../models/memberModel');
const Order = require('../models/orderModel');
const MemberSession = require('../models/memberSessionModel');
const VoucherClaim = require('../models/voucherClaimModel');

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
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('./socket/socketBus');

const { haversineKm } = require('../utils/distance');
const { nextDailyTxCode } = require('../utils/txCode');
const { validateAndPrice } = require('../utils/voucherEngine');
const { awardPointsIfEligible } = require('../utils/loyalty');

dayjs.extend(utc);
dayjs.extend(tz);

const LOCAL_TZ = 'Asia/Jakarta';

// logger history
const { logPaidHistory, logRefundHistory } = require('../utils/historyLoggers');

const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  REFRESH_TTL_MS,
  signAccessToken,
  generateOpaqueToken,
  hashToken
} = require('../utils/memberToken');

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

// helper delivery slots (letakkan di top file controller)
// helper: parse "HH:mm-HH:mm" with optional dateHint (YYYY-MM-DD) -> { fromDayjs, toDayjs } or null
function parseTimeRangeToDayjs(rangeStr, dateHint = null) {
  if (!rangeStr || typeof rangeStr !== 'string') return null;
  const parts = rangeStr.split('-').map((s) => (s || '').trim());
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  // reuse parseIsoOrHhmmToDayjs from previous helper style - implement small helper:
  const parseHhmmWithDate = (hhmm, date) => {
    if (!hhmm) return null;
    // if contains 'T' or date then parse ISO
    if (hhmm.includes('T') || /\d{4}-\d{2}-\d{2}/.test(hhmm)) {
      const d = dayjs(hhmm).tz(LOCAL_TZ);
      return d.isValid() ? d : null;
    }
    // else HH:mm
    const base = date
      ? dayjs(date).tz(LOCAL_TZ).startOf('day')
      : dayjs().tz(LOCAL_TZ).startOf('day');
    const p = hhmm.split(':');
    if (p.length < 2) return null;
    const hh = parseInt(p[0], 10),
      mm = parseInt(p[1], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return base.hour(hh).minute(mm).second(0).millisecond(0);
  };

  const date = dateHint ? String(dateHint).trim() : null;
  const fromD = parseHhmmWithDate(a, date);
  const toD = parseHhmmWithDate(b, date);
  if (!fromD || !fromD.isValid() || !toD || !toD.isValid()) return null;
  return { from: fromD, to: toD };
}

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

function isSlotAvailable(label, dateDay = null) {
  const slot = getSlotsForDate(dateDay).find((s) => s.label === label);
  return !!(slot && slot.available);
}

const safeJson = (v, fallback = null) => {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return fallback;
  }
};

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

// Bukti hanya untuk transfer
function needProof(method) {
  return method === PM.TRANSFER;
}

/* =============== Upload bukti transfer =============== */
async function handleTransferProofIfAny(req, method) {
  if (!needProof(method)) return '';

  const file = req.file;
  if (!file) {
    throwError('Bukti transfer wajib diunggah untuk metode transfer', 400);
  }

  const folderId = getDriveFolder('invoice');
  const filename =
    'TRF_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  const uploaded = await uploadBuffer(
    file.buffer,
    filename,
    file.mimetype || 'image/jpeg',
    folderId
  );

  const id = uploaded?.id;
  if (!id) {
    throwError('Gagal menyimpan bukti transfer', 500);
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
  const memberId = req.member?.id || null;
  const session_id =
    req.session_id ||
    req.cookies?.[DEVICE_COOKIE] ||
    req.header('x-device-id') ||
    null;

  return {
    mode: req.orderMode,
    source: req.orderSource,
    memberId,
    session_id,
    table_number: req.table_number || null
  };
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
  if (!iden?.memberId && !iden?.session_id) return;

  const filter = iden.memberId
    ? { status: 'active', member: iden.memberId }
    : { status: 'active', session_id: iden.session_id };

  const carts = await Cart.find(filter).sort({ updatedAt: -1 }); // newest first
  if (carts.length <= 1) return;

  const primary = carts[0];
  for (let i = 1; i < carts.length; i++) {
    mergeTwoCarts(primary, carts[i]);
    await carts[i].deleteOne().catch(() => {});
  }
  await primary.save();
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

  /* ========== 0) Baca FT dari query (opsional) ========== */
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

  /* ========== 1) Ambil / auto-create cart aktif ========== */
  const cartObj = await getActiveCartForIdentity(iden, {
    allowCreate: true, // auto-create jika belum ada
    defaultFt: hasFtQuery ? qFt : null, // hanya pakai default FT saat create & kalau query ada
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
      grand_total_with_delivery: 0,
      grand_total_before_rounding: 0
    };
    return res.status(200).json({ cart: null, ui_totals: empty });
  }

  /* ========== 2) Jika ADA query, update FT cart sesuai query ==========
     Kalau TIDAK ada query: JANGAN ubah FT yang sudah ada. */
  if (hasFtQuery && qFt && cartObj.fulfillment_type !== qFt) {
    await Cart.findByIdAndUpdate(cartObj._id, {
      $set: { fulfillment_type: qFt }
    });
  }

  /* ========== 3) Ambil cart terbaru untuk hitung UI ========== */
  const cart = await Cart.findById(cartObj._id)
    .select(
      'items total_items total_quantity total_price delivery updatedAt fulfillment_type table_number status member session_id source'
    )
    .lean();

  /* ========== 4) Build ringkasan awal ========== */
  const ui = buildUiTotalsFromCart(cart);

  const items_subtotal = Number(ui.items_subtotal || 0);
  const items_discount = Number(ui.items_discount || 0);
  const shipping_discount = Number(ui.shipping_discount || 0);

  // Service fee: hanya dari items
  const service_fee_on_items = int(items_subtotal * SERVICE_FEE_RATE);

  // Pajak: dari (items - item_discount) saja
  const rate = parsePpnRate();
  const taxAmountOnItems = int(
    Math.max(0, items_subtotal - items_discount) * rate
  );

  // === BEFORE ROUNDING: items + tax (NO discount, NO SF, NO delivery)
  const baseBeforeRound = items_subtotal + taxAmountOnItems;

  // Grand total (tanpa ongkir): (items + tax + SF) dibulatkan
  const pureBeforeWithService =
    int(baseBeforeRound) + int(service_fee_on_items);

  ui.service_fee = service_fee_on_items;
  ui.tax_amount = taxAmountOnItems;
  ui.grand_total_before_rounding = int(baseBeforeRound);

  const pureRounded = int(roundRupiahCustom(int(pureBeforeWithService)));
  ui.grand_total = pureRounded;
  ui.rounding_delta = pureRounded - int(pureBeforeWithService);

  /* ========== 5) Delivery fee: hanya jika FT cart memang delivery ========== */
  const ft = cart.fulfillment_type || 'dine_in';
  const CART_DELIV = Number(cart?.delivery?.delivery_fee || 0);
  const ENV_DELIV = Number(process.env.DELIVERY_FLAT_FEE || 0) || 0;
  const finalDeliveryFee =
    ft === 'delivery' ? (CART_DELIV > 0 ? CART_DELIV : ENV_DELIV) : 0;

  if (ft === 'delivery') {
    ui.delivery_fee = finalDeliveryFee;
    const beforeRoundWithDeliv =
      int(pureBeforeWithService) + int(finalDeliveryFee);
    ui.grand_total_with_delivery = int(roundRupiahCustom(beforeRoundWithDeliv));
  } else {
    ui.delivery_fee = 0;
    ui.grand_total_with_delivery = ui.grand_total;
  }

  /* ========== 6) Enrich item: alokasi pajak proporsional ke items (tanpa ongkir/SF) ========== */
  const items = Array.isArray(cart.items) ? cart.items : [];
  const taxDenominator = Math.max(0, items_subtotal - items_discount);

  const mappedItems = items.map((it) => {
    const qty = Number(it.quantity || 0);
    const unit_base = Number(it.base_price || 0);
    const addons_unit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const unit_before_tax = unit_base + addons_unit;
    const line_before_tax = Number(
      it.line_subtotal != null ? it.line_subtotal : unit_before_tax * qty
    );
    const line_tax =
      taxDenominator > 0
        ? Math.round((taxAmountOnItems * line_before_tax) / taxDenominator)
        : 0;
    const unit_tax = qty > 0 ? Math.round(line_tax / qty) : 0;

    return {
      ...it,
      unit_price: unit_before_tax,
      unit_tax,
      unit_price_incl_tax: unit_before_tax + unit_tax
    };
  });

  return res.status(200).json({
    ...cart,
    fulfillment_type: ft, // kembalikan FT yang AKTUAL di cart
    items: mappedItems,
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
      cart.delivery_draft = {
        address_text: String(req.body.delivery_draft.address_text || ''),
        location: req.body.delivery_draft.location || null,
        note_to_rider: String(req.body.delivery_draft.note_to_rider || '')
      };
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
  // ==== STEP: payload masuk ====
  const rawBodyKeys = Object.keys(req.body || {});
  const rawFiles = req.file
    ? { single: req.file?.fieldname }
    : Array.isArray(req.files)
    ? { multiple: req.files.map((f) => f.fieldname) }
    : null;

  const iden0 = getIdentity(req);
  const {
    name,
    phone,
    fulfillment_type, // 'dine_in' | 'delivery'
    payment_method, // 'qris' | 'transfer' | 'card' | 'cash'
    address_text,
    lat,
    lng,
    note_to_rider,
    idempotency_key,
    voucherClaimIds = [],
    register_decision = 'register' // 'register' | 'skip'
  } = req.body || {};

  /* ===== Resolve fulfillment type (ft) & method ===== */
  const ft =
    iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
  if (!['dine_in', 'delivery'].includes(ft)) {
    throwError('fulfillment_type tidak valid', 400);
  }

  const method = String(payment_method || '').toLowerCase();
  if (!isPaymentMethodAllowed(iden0.source || 'online', ft, method)) {
    throwError('Metode pembayaran tidak diizinkan untuk mode ini', 400);
  }
  const methodIsGateway = method === PM.QRIS;
  const requiresProof = needProof(method);

  /* ===== Guest vs Member resolve ===== */
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

  /* ===== Ambil cart aktif ===== */
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

  /* ===== Delivery/pickup slot & pickup window handling ===== */
  const delivery_mode = String(
    req.body?.delivery_mode || 'delivery'
  ).toLowerCase(); // 'delivery'|'pickup'
  const providedSlot = (req.body?.delivery_slot || '').trim();
  const providedScheduledAtRaw = req.body?.scheduled_at || null;
  const providedScheduledAt = providedScheduledAtRaw
    ? dayjs(providedScheduledAtRaw).tz(LOCAL_TZ)
    : null;

  const pickup_window_raw = String(req.body?.pickup_window_raw || '').trim();
  const pickup_date = req.body?.pickup_date || null;
  const pickup_from_iso = req.body?.pickup_from || null;
  const pickup_to_iso = req.body?.pickup_to || null;

  if (
    !providedSlot &&
    (!providedScheduledAt || !providedScheduledAt.isValid()) &&
    !pickup_window_raw &&
    !(pickup_from_iso && pickup_to_iso)
  ) {
    throwError('delivery_slot / scheduled_at atau pickup window wajib', 400);
  }

  let slotLabel = null;
  let slotDt = null;
  if (providedScheduledAt && providedScheduledAt.isValid()) {
    slotDt = providedScheduledAt.startOf('minute');
    slotLabel = slotDt.format('HH:mm');
  } else if (providedSlot) {
    const maybeDt = parseSlotLabelToDate(providedSlot);
    if (!maybeDt || !maybeDt.isValid())
      throwError('delivery_slot tidak valid', 400);
    slotDt = maybeDt;
    slotLabel = providedSlot;
  }

  // check slot availability only if slotLabel provided (type-aware)
  if (slotLabel && !isSlotAvailable(slotLabel, null, delivery_mode)) {
    throwError('Slot sudah tidak tersedia / sudah lewat', 409);
  }

  let deliveryObj = {
    mode: delivery_mode,
    slot_label: slotLabel || null,
    scheduled_at: slotDt ? slotDt.toDate() : null,
    status: 'pending'
  };

  // parse pickup window if provided
  let pickupWindowFrom = null;
  let pickupWindowTo = null;
  if (pickup_window_raw) {
    const parsed = parseTimeRangeToDayjs(pickup_window_raw, pickup_date);
    if (!parsed) throwError('pickup_window_raw tidak valid (HH:mm-HH:mm)', 400);
    pickupWindowFrom = parsed.from;
    pickupWindowTo = parsed.to;
  } else if (pickup_from_iso && pickup_to_iso) {
    const f = dayjs(pickup_from_iso).tz(LOCAL_TZ);
    const t = dayjs(pickup_to_iso).tz(LOCAL_TZ);
    if (!f.isValid() || !t.isValid())
      throwError('pickup_from/pickup_to tidak valid ISO', 400);
    pickupWindowFrom = f;
    pickupWindowTo = t;
  }

  if (delivery_mode === 'pickup' && (pickupWindowFrom || pickupWindowTo)) {
    if (!pickupWindowFrom || !pickupWindowTo)
      throwError('pickup window tidak lengkap', 400);
    if (!pickupWindowFrom.isBefore(pickupWindowTo))
      throwError('pickup_window: from harus < to', 400);
    const now = dayjs().tz(LOCAL_TZ);
    if (pickupWindowFrom.isBefore(now.add(MIN_LEAD_MINUTES, 'minute'))) {
      throwError(
        `Waktu pickup mulai harus setidaknya ${MIN_LEAD_MINUTES} menit dari sekarang`,
        409
      );
    }
    const diffHours = pickupWindowTo.diff(pickupWindowFrom, 'hour', true);
    if (diffHours > MAX_WINDOW_HOURS)
      throwError(
        `Durasi pickup window terlalu panjang (max ${MAX_WINDOW_HOURS} jam)`,
        400
      );

    deliveryObj.pickup_window = {
      from: pickupWindowFrom.toDate(),
      to: pickupWindowTo.toDate()
    };
    // normalize slot_label/scheduled_at from pickup_window.from if not provided
    if (!deliveryObj.scheduled_at) {
      deliveryObj.scheduled_at = pickupWindowFrom.toDate();
      deliveryObj.slot_label = pickupWindowFrom.format('HH:mm');
    }
  }

  // Delivery-specific: alamat & radius
  let delivery_fee = 0;
  if (delivery_mode === 'delivery') {
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

  // ==== Normalisasi items & addons ====
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

  // ==== STEP: snapshot cart setelah sanitasi ====
  const cartPreview = short(cart.items).map((it, idx) => ({
    i: idx,
    menu: String(it.menu || ''),
    qty: it.quantity,
    addonsCount: Array.isArray(it.addons) ? it.addons.length : 0,
    addonPreview: short(it.addons).map((a) => ({
      name: a?.name,
      price: a?.price,
      qty: a?.qty,
      hasIsActive: Object.prototype.hasOwnProperty.call(a || {}, 'isActive')
    }))
  }));

  // ==== recomputeTotals (guarded) ====
  try {
    recomputeTotals(cart);
    await cart.save();
  } catch (err) {
    throw err;
  }

  /* ===== Voucher claim filtering ===== */
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

  // ==== validateAndPrice (guarded) ====
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
    throw err;
  }

  /* ===== PPN + pembulatan (opsional jika belum di-handle di pre('validate')) ===== */
  const rate = parsePpnRate(); // ex: 0.11
  const taxBase =
    priced.totals.baseSubtotal -
    priced.totals.itemsDiscount +
    priced.totals.deliveryFee -
    priced.totals.shippingDiscount;
  const taxAmount = int(Math.max(0, Math.floor(taxBase * rate)));
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;
  const beforeRound = int(taxBase + taxAmount);
  const rounded = int(roundRupiahCustom(beforeRound));
  const roundingDelta = int(rounded - beforeRound);

  priced.totals.taxAmount = taxAmount;
  priced.totals.taxRatePercent = taxRatePercent;
  priced.totals.grandTotal = rounded;
  priced.totals.roundingDelta = roundingDelta;

  /* ===== Bukti transfer (kalau perlu) ===== */
  const payment_proof_url = await handleTransferProofIfAny(req, method);

  /* ===== Payment status awal ===== */
  let payment_status = 'unpaid';
  let payment_provider = null;

  if (methodIsGateway) {
    payment_provider = 'xendit';
    payment_status = 'unpaid'; // gateway biasanya menunggu callback/webhook
  } else if (requiresProof) {
    // metode seperti transfer bank yang butuh bukti -> tunggu verifikasi staff
    payment_status = 'pending';
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
            category: it.category || null // line_subtotal akan dihitung ulang di pre('validate')
          })),
          // Totals dari pricing (baseline; kalau pakai pre('validate') finalisasi, ini bisa berubah)
          items_subtotal: int(priced.totals.baseSubtotal),
          items_discount: int(priced.totals.itemsDiscount),
          delivery_fee: int(priced.totals.deliveryFee),
          shipping_discount: int(priced.totals.shippingDiscount),
          discounts: priced.breakdown || [],
          // Pajak & pembulatan
          tax_rate_percent: taxRatePercent,
          tax_amount: taxAmount,
          rounding_delta: roundingDelta,
          grand_total: rounded,
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
        throw e;
      }
    }
    throw new Error('Gagal generate transaction_code unik');
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
        // gagal update voucher -> ignore tapi log bila perlu
      }
    }
  }

  /* ===== Tandai cart selesai ===== */
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

  /* ===== Statistik member ===== */
  if (MemberDoc) {
    await Member.findByIdAndUpdate(MemberDoc._id, {
      $inc: { total_spend: order.grand_total || 0 },
      $set: { last_visit_at: new Date() }
    });
  }

  /* ===== Emit realtime ===== */
  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: MemberDoc
      ? {
          id: String(MemberDoc._1d),
          name: MemberDoc.name,
          phone: MemberDoc.phone
        }
      : null,
    items_total: order.items_subtotal,
    grand_total: order.grand_total,
    total_quantity: order.total_quantity,
    source: order.source,
    fulfillment_type: order.fulfillment_type,
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    placed_at: order.placed_at,
    delivery: order.delivery || null,
    table_number: order.table_number || null
  };

  emitToStaff('order:new', payload);
  if (MemberDoc) emitToMember(MemberDoc._id, 'order:new', payload);
  if ((iden.source || 'online') === 'qr' && order.table_number) {
    emitToTable(order.table_number, 'order:new', payload);
  }

  /* ===== Response ===== */
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

  emitToStaff('cart:table_assigned', {
    cart_id: String(cart._id),
    table_number
  });
  emitToTable(table_number, 'cart:table_assigned', {
    cart_id: String(cart._id)
  });

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

  if (oldNo)
    emitToTable(oldNo, 'cart:unassigned', { cart_id: String(cart._id) });
  emitToTable(newNo, 'cart:reassigned', { cart_id: String(cart._id) });
  emitToStaff('cart:table_changed', {
    oldNo,
    newNo,
    cart_id: String(cart._id)
  });

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

exports.getMyOrder = asyncHandler(async (req, res) => {
  if (!req.member?.id) throwError('Harus login sebagai member', 401);
  const order = await Order.findById(req.params.id).lean();
  if (!order) throwError('Order tidak ditemukan', 404);
  if (String(order.member) !== String(req.member.id))
    throwError('Tidak berhak mengakses order ini', 403);
  res.status(200).json(order);
});

/**
 * PREVIEW PRICE — sekarang bisa untuk dine_in maupun delivery.
 * Kirimkan:
 *  {
 *    cart: { items: [{menuId, qty, price, category}] },
 *    fulfillmentType: 'dine_in' | 'delivery',
 *    deliveryFee?: number,
 *    voucherClaimIds?: [string]
 *  }
 */
exports.previewPrice = asyncHandler(async (req, res) => {
  if (!req.member?.id) throwError('Harus login sebagai member', 401);

  const {
    cart,
    fulfillmentType = 'dine_in',
    deliveryFee = fulfillmentType === 'delivery' ? 0 : 0,
    voucherClaimIds = []
  } = req.body || {};

  if (!cart?.items?.length) throwError('Cart kosong', 400);

  // filter klaim milik member & masih valid
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

  const result = await validateAndPrice({
    memberId: req.member.id,
    cart,
    fulfillmentType,
    deliveryFee: fulfillmentType === 'delivery' ? Number(deliveryFee || 0) : 0,
    voucherClaimIds: eligible
  });
  res.status(200).json(result);
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
  if (!req.user) throwError('Unauthorized', 401);
  const order = await Order.findById(req.params.id).lean();
  if (!order) throwError('Order tidak ditemukan', 404);
  res.status(200).json(order);
});

const buildOrderReceipt = (order) => {
  if (!order) return null;

  const displayName = order.member?.name || order.customer_name || '';
  const displayPhone = order.member?.phone || order.customer_phone || '';

  const items = Array.isArray(order.items) ? order.items : [];

  const items_subtotal = Number(order.items_subtotal || 0);
  const items_discount = Number(order.items_discount || 0);
  const delivery_fee = Number(order.delivery_fee || 0);
  const shipping_discount = Number(order.shipping_discount || 0);
  const service_fee = Number(order.service_fee || 0);
  const tax_amount_total = Number(order.tax_amount || 0);
  const tax_rate_percent = Number(order.tax_rate_percent || 0);

  // Tax base di level order (ikuti rumus yang dipakai saat checkout)
  const taxDenominator =
    items_subtotal -
    items_discount +
    delivery_fee -
    shipping_discount +
    service_fee;

  // helper subtotal per item (internal saja)
  const lineSubtotalOf = (it) => {
    const unitBase = Number(it.base_price || 0);
    const addonsUnit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );
    const qty = Number(it.quantity || 0);
    return (unitBase + addonsUnit) * qty;
  };

  const detailedItems = items.map((it) => {
    const qty = Number(it.quantity || 0);

    const unit_base = Number(it.base_price || 0);
    const addons_unit = (it.addons || []).reduce(
      (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
      0
    );

    const unit_before_tax = unit_base + addons_unit;

    // alokasi pajak proporsional → ubah ke per-unit
    const line_before_tax = Number(it.line_subtotal ?? lineSubtotalOf(it));
    const line_tax =
      taxDenominator > 0
        ? Math.round((tax_amount_total * line_before_tax) / taxDenominator)
        : 0;

    const unit_tax = qty > 0 ? Math.round(line_tax / qty) : 0;

    return {
      name: it.name,
      menu_code: it.menu_code || '',
      imageUrl: it.imageUrl || '',
      quantity: qty,
      addons: (it.addons || []).map((ad) => ({
        name: ad.name,
        price: Number(ad.price || 0),
        qty: Number(ad.qty || 1)
      })),

      // Hanya unit-level agar FE simpel
      unit_price: unit_before_tax, // sebelum pajak
      unit_tax, // pajak per unit
      unit_price_incl_tax: unit_before_tax + unit_tax, // setelah pajak
      tax_rate_percent: tax_rate_percent // referensi saja
    };
  });

  return {
    id: String(order._id),
    transaction_code: order.transaction_code || '',
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,

    pricing: {
      items_subtotal,
      service_fee,
      delivery_fee,
      items_discount,
      shipping_discount,
      tax_amount: tax_amount_total,
      tax_rate_percent: tax_rate_percent,
      rounding_delta: Number(order.rounding_delta || 0),
      grand_total: Number(order.grand_total || 0)
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
      throwError('as_member=true: sertakan member_id atau name+phone', 400);
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

  // ===== Pajak & Pembulatan =====
  const rawRate = Number(process.env.PPN_RATE ?? 0.11);
  const rate = Number.isFinite(rawRate)
    ? rawRate > 1
      ? rawRate / 100
      : rawRate
    : 0.11;
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;
  const taxBase = itemsSubtotal; // POS: no voucher, no delivery
  const taxAmount = int(Math.max(0, taxBase * rate));

  const beforeRound = int(taxBase + taxAmount);
  const grandTotal = int(roundRupiahCustom(beforeRound));
  const roundingDelta = int(grandTotal - beforeRound);

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

  emitToStaff('order:new', payload);
  if (order.table_number) emitToTable(order.table_number, 'order:new', payload);
  if (member) emitToMember(member._id, 'order:new', payload);

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

  // Pajak (PPN) — sama rumusnya dengan createPosDineIn
  const raw = Number(process.env.PPN_RATE ?? 0.11);
  const rate = Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : 0.11;
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;
  const taxBase = itemsSubtotal;
  const taxAmount = int(Math.max(0, taxBase * rate));

  const beforeRound = int(taxBase + taxAmount);
  const grandTotal = int(roundRupiahCustom(beforeRound));
  const roundingDelta = int(grandTotal - beforeRound);

  res.json({
    success: true,
    preview: {
      items: orderItems,
      total_quantity: totalQty,
      items_subtotal: itemsSubtotal,
      items_discount: 0,
      delivery_fee: 0,
      shipping_discount: 0,
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
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.status !== 'accepted') {
    throwError('Hanya pesanan accepted yang bisa diselesaikan', 409);
  }

  order.status = 'completed';
  await order.save();

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    status: order.status
  };
  emitToStaff('order:completed', payload);
  if (order.member) emitToMember(order.member, 'order:completed', payload);
  if (order.table_number)
    emitToTable(order.table_number, 'order:completed', payload);

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
  await logPaidHistory(doc, req.user).catch(() => {});

  const payload = {
    id: String(doc._id),
    transaction_code: doc.transaction_code,
    status: doc.status,
    payment_status: doc.payment_status,
    verified_by: { id: String(req.user._id), name: req.user.name },
    at: doc.verified_at
  };
  emitToStaff('order:accepted_verified', payload);
  if (doc.member) emitToMember(doc.member, 'order:accepted_verified', payload);
  if (doc.table_number)
    emitToTable(doc.table_number, 'order:accepted_verified', payload);

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

  emitToStaff('order:delivery_assigned', payload);
  if (updated.member)
    emitToMember(updated.member, 'order:delivery_assigned', payload);

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
    const payload = {
      id: String(u._id),
      transaction_code: u.transaction_code,
      delivery: {
        status: u.delivery?.status,
        courier: u.delivery?.courier,
        assigned_at: u.delivery?.assigned_at
      }
    };
    if (u.member) emitToMember(u.member, 'order:delivery_assigned', payload);
  }

  res.json({
    success: true,
    message: `Batch assign selesai. ${
      updateRes.nModified || updateRes.modifiedCount || 0
    } order diassign ke kurir.`,
    affected: updateRes
  });
});

/**
 * PATCH /orders/:id/delivery/status
 * Body: { status: 'assigned'|'picked_up'|'on_the_way'|'delivered'|'failed', note?: string }
 */
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
  emitToStaff('order:delivery_status', payload);
  if (order.member)
    emitToMember(order.member, 'order:delivery_status', payload);

  res.status(200).json({
    message: 'Status delivery diperbarui',
    order: order.toObject()
  });
});

/**
 * GET /orders/delivery-board
 */
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

exports.createQrisFromCart = async (req, res, next) => {
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

    /* ===== Resolve fulfillment type ===== */
    const ft =
      iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
    if (!['dine_in', 'delivery'].includes(ft)) {
      return res.status(400).json({ message: 'fulfillment_type tidak valid' });
    }

    /* ===== Member / Guest (mirip checkout) ===== */
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
        return res
          .status(400)
          .json({ message: 'Tanpa member: isi minimal nama atau no. telp' });
      }
    }

    const finalMemberId = member ? member._id : null;

    /* ===== Ambil cart aktif ===== */
    const iden = {
      ...iden0,
      memberId: finalMemberId || iden0.memberId || null,
      session_id:
        iden0.session_id ||
        req.cookies?.[DEVICE_COOKIE] ||
        req.header('x-device-id') ||
        null
    };

    const cartObj = await getActiveCartForIdentity(iden, {
      allowCreateOnline: false
    });
    if (!cartObj) {
      return res.status(404).json({ message: 'Cart tidak ditemukan / kosong' });
    }

    const cart = await Cart.findById(cartObj._id);
    if (!cart || !cart.items?.length) {
      return res.status(404).json({ message: 'Cart kosong' });
    }

    if (
      ft === 'dine_in' &&
      (iden.source || 'online') === 'qr' &&
      !cart.table_number
    ) {
      return res
        .status(400)
        .json({ message: 'Silakan assign nomor meja terlebih dahulu' });
    }

    if (finalMemberId && !cart.member) {
      cart.member = finalMemberId;
      cart.session_id = null;
    }

    /* ===== Delivery/pickup slot handling ===== */
    const delivery_mode = String(
      req.body?.delivery_mode || 'delivery'
    ).toLowerCase(); // 'delivery'|'pickup'
    const providedSlot = (req.body?.delivery_slot || '').trim();
    const providedScheduledAtRaw = req.body?.scheduled_at || null;
    const providedScheduledAt = providedScheduledAtRaw
      ? dayjs(providedScheduledAtRaw).tz(LOCAL_TZ)
      : null;

    // pickup window alternatives
    const pickup_window_raw = String(req.body?.pickup_window_raw || '').trim(); // "16:00-17:00"
    const pickup_date = req.body?.pickup_date || null; // optional
    const pickup_from_iso = req.body?.pickup_from || null;
    const pickup_to_iso = req.body?.pickup_to || null;

    // Validate presence of either slot or pickup window
    if (
      !providedSlot &&
      (!providedScheduledAt || !providedScheduledAt.isValid()) &&
      !pickup_window_raw &&
      !(pickup_from_iso && pickup_to_iso)
    ) {
      return res.status(400).json({
        message: 'delivery_slot / scheduled_at atau pickup window wajib'
      });
    }

    // Resolve standard slot (for delivery or basic pickup slot)
    let slotLabel = null;
    let slotDt = null;
    if (providedScheduledAt && providedScheduledAt.isValid()) {
      slotDt = providedScheduledAt.startOf('minute');
      slotLabel = slotDt.format('HH:mm');
    } else if (providedSlot) {
      const maybeDt = parseSlotLabelToDate(providedSlot);
      if (!maybeDt || !maybeDt.isValid())
        return res.status(400).json({ message: 'delivery_slot tidak valid' });
      slotDt = maybeDt;
      slotLabel = providedSlot;
    }

    // Build deliveryObj baseline
    let deliveryObj = {
      mode: delivery_mode,
      slot_label: slotLabel || null,
      scheduled_at: slotDt ? slotDt.toDate() : null,
      status: 'pending'
    };

    // If pickup window provided, parse and validate
    let pickupWindowFrom = null;
    let pickupWindowTo = null;
    if (pickup_window_raw) {
      const parsed = parseTimeRangeToDayjs(pickup_window_raw, pickup_date);
      if (!parsed)
        return res
          .status(400)
          .json({ message: 'pickup_window_raw tidak valid (HH:mm-HH:mm)' });
      pickupWindowFrom = parsed.from;
      pickupWindowTo = parsed.to;
    } else if (pickup_from_iso && pickup_to_iso) {
      const f = dayjs(pickup_from_iso).tz(LOCAL_TZ);
      const t = dayjs(pickup_to_iso).tz(LOCAL_TZ);
      if (!f.isValid() || !t.isValid())
        return res
          .status(400)
          .json({ message: 'pickup_from/pickup_to tidak valid ISO' });
      pickupWindowFrom = f;
      pickupWindowTo = t;
    }

    // If delivery_mode is pickup and we have pickup window, validate it
    if (delivery_mode === 'pickup' && (pickupWindowFrom || pickupWindowTo)) {
      if (!pickupWindowFrom || !pickupWindowTo) {
        return res.status(400).json({ message: 'pickup window tidak lengkap' });
      }
      if (!pickupWindowFrom.isBefore(pickupWindowTo)) {
        return res
          .status(400)
          .json({ message: 'pickup_window: from harus < to' });
      }
      const now = dayjs().tz(LOCAL_TZ);
      if (pickupWindowFrom.isBefore(now.add(MIN_LEAD_MINUTES, 'minute'))) {
        return res.status(409).json({
          message: `Waktu pickup mulai harus setidaknya ${MIN_LEAD_MINUTES} menit dari sekarang`
        });
      }
      const diffHours = pickupWindowTo.diff(pickupWindowFrom, 'hour', true);
      if (diffHours > MAX_WINDOW_HOURS) {
        return res.status(400).json({
          message: `Durasi pickup window terlalu panjang (max ${MAX_WINDOW_HOURS} jam)`
        });
      }
      // attach to deliveryObj and also set separate fields for PaymentSession
      deliveryObj.pickup_window = {
        from: pickupWindowFrom.toDate(),
        to: pickupWindowTo.toDate()
      };
    }

    // Delivery-specific validation (location/radius)
    let delivery_fee = 0;
    if (delivery_mode === 'delivery') {
      const latN = Number(req.body?.lat);
      const lngN = Number(req.body?.lng);
      if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
        return res
          .status(400)
          .json({ message: 'Lokasi (lat,lng) wajib untuk delivery' });
      }
      const distance_km = haversineKm(CAFE_COORD, { lat: latN, lng: lngN });
      if (distance_km > Number(DELIVERY_MAX_RADIUS_KM || 0)) {
        return res
          .status(400)
          .json({ message: `Di luar radius ${DELIVERY_MAX_RADIUS_KM} km` });
      }
      deliveryObj.address_text = String(req.body?.address_text || '').trim();
      deliveryObj.location = { lat: latN, lng: lngN };
      deliveryObj.distance_km = Number(distance_km.toFixed(2));
      delivery_fee = calcDeliveryFee();
      deliveryObj.delivery_fee = delivery_fee;
    } else {
      deliveryObj.note_to_rider = String(req.body?.note_to_rider || '');
    }

    /* ===== Hitung ulang cart ===== */
    recomputeTotals(cart);
    await cart.save();

    /* ===== Voucher ===== */
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
      return res
        .status(400)
        .json({ message: 'Voucher hanya untuk member. Silakan daftar/login.' });
    }

    const priced = await validateAndPrice({
      memberId: finalMemberId,
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

    const items_subtotal = int(priced.totals.baseSubtotal);
    const items_discount = int(priced.totals.itemsDiscount);
    const shipping_discount = int(priced.totals.shippingDiscount);
    const baseDelivery = int(priced.totals.deliveryFee);

    // Service fee 2% dari ITEMS SAJA
    const sfBase = items_subtotal;
    const service_fee = int(sfBase * SERVICE_FEE_RATE);

    // Tax base: HANYA dari menu (setelah item discount)
    const taxBase = items_subtotal - items_discount;
    const safeTaxBase = Math.max(0, taxBase);
    const rate = parsePpnRate();
    const taxAmount = int(safeTaxBase * rate);

    // ===== Total sebelum pembulatan (ongkir & service fee berdiri sendiri, tax dari menu)
    const beforeRound = int(
      items_subtotal +
        service_fee +
        baseDelivery -
        items_discount -
        shipping_discount +
        taxAmount
    );
    const requested_bvt = int(roundRupiahCustom(beforeRound));
    const rounding_delta = int(requested_bvt - beforeRound);

    if (requested_bvt <= 0) {
      return res.status(400).json({ message: 'Total pembayaran tidak valid.' });
    }

    /* ===== Buat PaymentSession ===== */
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
      items_subtotal,
      delivery_fee: baseDelivery,
      service_fee,
      items_discount,
      shipping_discount,
      discounts: priced.breakdown,
      requested_amount: requested_bvt,
      rounding_delta,
      delivery_snapshot: deliveryObj,
      provider: 'xendit',
      channel: 'qris',
      external_id: reference_id
    };

    // attach pickup_window at top-level session if present
    if (deliveryObj.pickup_window) {
      sessionPayload.pickup_window = {
        from: deliveryObj.pickup_window.from,
        to: deliveryObj.pickup_window.to
      };
    }

    const session = await PaymentSession.create(sessionPayload);

    /* ===== Call Xendit QR ===== */
    const payload = {
      reference_id,
      type: 'DYNAMIC',
      currency: 'IDR',
      amount: requested_bvt,
      metadata: { payment_session_id: String(session._id) }
    };

    const resp = await axios.post(`${X_BASE}/qr_codes`, payload, {
      auth: { username: X_KEY, password: '' },
      headers: { ...HDRS, 'api-version': '2022-07-31' },
      timeout: 15000
    });

    const qr = resp.data;

    session.qr_code_id = qr.id;
    session.qr_string = qr.qr_string;
    session.expires_at = qr.expires_at ? new Date(qr.expires_at) : null;
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
        status: 'pending'
      }
    });
  } catch (err) {
    next(err);
  }
};

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
