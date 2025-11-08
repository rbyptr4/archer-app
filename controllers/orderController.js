// controllers/orderController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');

const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const User = require('../models/userModel');
const Member = require('../models/memberModel');
const Order = require('../models/orderModel');
const MemberSession = require('../models/memberSessionModel');
const VoucherClaim = require('../models/voucherClaimModel');

const throwError = require('../utils/throwError');
const { sendText, buildOrderReceiptMessage } = require('../utils/wablas');
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

/* ================= Cookie presets ================= */
const cookieAccess = { ...baseCookie, httpOnly: true, maxAge: 15 * 60 * 1000 };
const cookieRefresh = { ...baseCookie, httpOnly: true, maxAge: REFRESH_TTL_MS };
const cookieDevice = { ...baseCookie, httpOnly: false, maxAge: REFRESH_TTL_MS };

/* ================= Konstanta & helper status ================= */
const ALLOWED_STATUSES = ['created', 'accepted', 'completed', 'cancelled'];
const ALLOWED_PAY_STATUS = ['verified', 'paid', 'refunded', 'void'];

const DELIVERY_ALLOWED = [
  'pending',
  'assigned',
  'picked_up',
  'on_the_way',
  'delivered',
  'failed'
];

function parsePpnRate() {
  const raw = Number(process.env.PPN_RATE ?? 0.11); // default 11%
  if (!Number.isFinite(raw)) return 0.11;
  return raw > 1 ? raw / 100 : raw;
}

const normFt = (v) =>
  String(v).toLowerCase() === 'delivery' ? 'delivery' : 'dine_in';

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
    assigned: ['picked_up', 'failed'],
    picked_up: ['on_the_way', 'failed'],
    on_the_way: ['delivered', 'failed'],
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

  const folderId =
    getDriveFolder('payment_proof') || getDriveFolder('orders') || null;
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

/* ================= MERGE CARTS: session_id -> member ================= */
const mergeTwoCarts = (dst, src) => {
  for (const it of src.items || []) {
    const idx = dst.items.findIndex((d) => d.line_key === it.line_key);
    if (idx >= 0) {
      dst.items[idx].quantity = clamp(
        asInt(dst.items[idx].quantity, 1) + asInt(it.quantity, 1),
        1,
        999
      );
    } else {
      dst.items.push(it.toObject ? it.toObject() : { ...it });
    }
  }
  recomputeTotals(dst);
};

const attachOrMergeCartsForIdentity = async (iden) => {
  if (!iden?.memberId || !iden?.session_id) return;

  const SOURCES = ['online', 'qr'];
  for (const src of SOURCES) {
    const sessionCart = await Cart.findOne({
      status: 'active',
      source: src,
      session_id: iden.session_id,
      $or: [{ member: null }, { member: { $exists: false } }]
    });
    if (!sessionCart) continue;

    let memberCart = await Cart.findOne({
      status: 'active',
      source: src,
      member: iden.memberId
    });

    if (memberCart) {
      mergeTwoCarts(memberCart, sessionCart);
      await memberCart.save();
      await Cart.deleteOne({ _id: sessionCart._id }).catch(() => {});
      continue;
    }

    try {
      const r = await Cart.updateOne(
        {
          _id: sessionCart._id,
          status: 'active',
          source: src,
          session_id: iden.session_id,
          $or: [{ member: null }, { member: { $exists: false } }]
        },
        { $set: { member: iden.memberId, session_id: null } }
      );
      if (!r.matchedCount) continue;
    } catch (e) {
      if (e && e.code === 11000) {
        memberCart = await Cart.findOne({
          status: 'active',
          source: src,
          member: iden.memberId
        });
        if (memberCart) {
          const freshSession = await Cart.findById(sessionCart._id);
          if (freshSession) {
            mergeTwoCarts(memberCart, freshSession);
            await memberCart.save();
            await Cart.deleteOne({ _id: freshSession._id }).catch(() => {});
          }
          continue;
        }
        throw e;
      }
      throw e;
    }
  }
};

const getActiveCartForIdentity = async (
  iden,
  { allowCreateOnline = false, defaultFt = null }
) => {
  await attachOrMergeCartsForIdentity(iden);

  const requestedSource = iden.source || '';
  // Bisa match dengan member atau session_id (atau keduanya)
  const identityFilter = (() => {
    const parts = [];
    if (iden.memberId) parts.push({ member: iden.memberId });
    if (iden.session_id) parts.push({ session_id: iden.session_id });
    if (!parts.length) return {}; // fallback: tanpa filter identitas (jarang)
    if (parts.length === 1) return parts[0];
    return { $or: parts };
  })();

  // 🔧 perbaikan: hormati requestedSource
  const sourcesToCheck = (() => {
    if (requestedSource === 'qr') return ['qr'];
    if (requestedSource === 'online') return ['online'];
    // fallback kalau gak jelas: prefer online baru qr
    return ['online', 'qr'];
  })();

  let cart = null;
  let cartsQueried = [];
  let foundSource = null;

  for (const src of sourcesToCheck) {
    const carts = await Cart.find({
      status: 'active',
      source: src,
      ...identityFilter
    })
      .sort([
        ['table_number', -1],
        ['updatedAt', -1]
      ])
      .limit(2)
      .lean();

    if (carts.length) {
      cart = carts[0];
      cartsQueried = carts;
      foundSource = src;
      break;
    }
  }

  if (!cart) {
    if (requestedSource === 'qr') {
      throwError(
        'Belum ada cart self-order. Silakan assign nomor meja dahulu.',
        400
      );
    } else if (allowCreateOnline) {
      const ensureSession = iden.memberId
        ? null
        : iden.session_id || crypto.randomUUID();

      const upsertFilter = {
        status: 'active',
        source: 'online',
        ...(iden.memberId
          ? { member: iden.memberId }
          : { session_id: ensureSession })
      };

      const setOnInsert = {
        member: iden.memberId || null,
        session_id: iden.memberId ? null : ensureSession,
        table_number: null,
        fulfillment_type: defaultFt ? normFt(defaultFt) : 'dine_in',
        items: [],
        total_items: 0,
        total_quantity: 0,
        total_price: 0,
        status: 'active',
        source: 'online'
      };

      try {
        const upserted = await Cart.findOneAndUpdate(
          upsertFilter,
          { $setOnInsert: setOnInsert },
          { new: true, upsert: true, lean: true }
        );
        cart = upserted;
        foundSource = 'online';
      } catch (e) {
        if (e && e.code === 11000) {
          const retry = await Cart.findOne(upsertFilter).lean();
          if (retry) {
            cart = retry;
            foundSource = 'online';
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }
  }

  if (cart && cartsQueried.length > 1) {
    await Cart.deleteMany({
      _id: { $in: cartsQueried.slice(1).map((c) => c._id) },
      status: 'active',
      source: foundSource,
      ...identityFilter
    }).catch(() => {});
  }

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

/* ===================== CART ENDPOINTS ===================== */
exports.getCart = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const allowCreateOnline = false;
  let cart = await getActiveCartForIdentity(iden, {
    allowCreateOnline,
    defaultFt: req.query?.fulfillment_type || null
  });
  res.status(200).json(cart);
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
  if (!cartObj) throwError('Cart tidak ditemukan', 404);

  // Ambil cart aslinya (bukan .lean()) supaya bisa save
  const cart = await Cart.findById(cartObj._id);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  const ref = String(itemId || '').trim();
  if (!ref) throwError('Parameter itemId kosong', 400);

  // Cari item pakai _id ATAU line_key (fallback)
  let idx = cart.items.findIndex(
    (it) => String(it._id) === ref || String(it.line_key) === ref
  );
  if (idx < 0) throwError('Item tidak ditemukan di cart', 404);

  // ================== Update field ==================
  // quantity
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

  // addons & notes
  if (cart.items[idx]) {
    if (addons !== undefined) {
      cart.items[idx].addons = normalizeAddons(addons);
    }
    if (notes !== undefined) {
      cart.items[idx].notes = String(notes || '').trim();
    }

    // Rebuild line_key sesuai kondisi terbaru
    cart.items[idx].line_key = makeLineKey({
      menuId: cart.items[idx].menu,
      addons: cart.items[idx].addons,
      notes: cart.items[idx].notes
    });

    // Jika setelah update line_key bentrok dengan item lain, merge qty
    const newKey = cart.items[idx].line_key;
    const dupIdx = cart.items.findIndex(
      (it, i) => i !== idx && String(it.line_key) === String(newKey)
    );
    if (dupIdx >= 0) {
      // Gabung quantity dan hapus item yang diedit (agar tidak ganda)
      cart.items[dupIdx].quantity = clamp(
        asInt(
          (cart.items[dupIdx].quantity || 0) + (cart.items[idx].quantity || 0),
          0
        ),
        0,
        999
      );
      cart.items.splice(idx, 1);
      // optional: set idx = dupIdx jika ingin lanjut proses lain
    }
  }

  // ================== Recompute & Save ==================
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

/* ===== Toggle fulfillment type dari Cart ===== */
// PATCH /cart/fulfillment-type  { fulfillment_type: 'dine_in'|'delivery' }
exports.setFulfillmentType = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const ft = String(req.body?.fulfillment_type || '').toLowerCase();

  if (!['dine_in', 'delivery'].includes(ft)) {
    throwError('fulfillment_type tidak valid', 400);
  }
  // Self-order QR tetap tidak boleh set ke delivery
  if ((iden.source || 'online') === 'qr' && ft !== 'dine_in') {
    throwError('Self-order hanya mendukung dine_in', 400);
  }

  const identityFilter = iden.memberId
    ? { member: iden.memberId }
    : { session_id: iden.session_id };

  /* ================== CASE A: Target DELIVERY (QR -> ONLINE) ================== */
  if (ft === 'delivery') {
    // Filter identitas
    const identityFilter = iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.session_id };

    // 1) Ambil QR cart (jika ada)
    const qrCart = await Cart.findOne({
      status: 'active',
      source: 'qr',
      ...identityFilter
    });

    // 2) Ambil atau buat ONLINE cart (karena targetnya delivery)
    const ensureSession = iden.memberId
      ? null
      : iden.session_id || crypto.randomUUID();

    let onlineCart = await Cart.findOneAndUpdate(
      {
        status: 'active',
        source: 'online',
        ...(iden.memberId
          ? { member: iden.memberId }
          : { session_id: ensureSession })
      },
      {
        $setOnInsert: {
          member: iden.memberId || null,
          session_id: iden.memberId ? null : ensureSession,
          table_number: null,
          fulfillment_type: 'delivery',
          items: [],
          total_items: 0,
          total_quantity: 0,
          total_price: 0,
          status: 'active',
          source: 'online'
        }
      },
      { new: true, upsert: true }
    );

    // 3) Jika QR ada item, MERGE -> ONLINE lalu kosongkan QR
    if (qrCart && (qrCart.items?.length || 0) > 0) {
      const idxMap = new Map(
        (onlineCart.items || []).map((it, i) => [String(it.line_key), i])
      );

      for (const it of qrCart.items || []) {
        const key = String(it.line_key);
        if (idxMap.has(key)) {
          const i = idxMap.get(key);
          const q =
            asInt(onlineCart.items[i].quantity, 1) + asInt(it.quantity, 1);
          onlineCart.items[i].quantity = clamp(q, 1, 999);
        } else {
          onlineCart.items.push({
            menu: it.menu,
            menu_code: it.menu_code || '',
            name: it.name,
            imageUrl: it.imageUrl || '',
            base_price: asInt(it.base_price, 0),
            quantity: clamp(asInt(it.quantity, 1), 1, 999),
            addons: normalizeAddons(it.addons),
            notes: String(it.notes || '').trim(),
            line_key: key,
            category: it.category || null
          });
          idxMap.set(key, onlineCart.items.length - 1);
        }
      }

      // Kosongkan QR (bukan hapus dokumen)
      qrCart.items = [];
      recomputeTotals(qrCart);
      await qrCart.save();
    }

    // 4) Set konteks delivery pada ONLINE dan simpan
    onlineCart.fulfillment_type = 'delivery';
    onlineCart.table_number = null;
    recomputeTotals(onlineCart);
    await onlineCart.save();

    return res.status(200).json(onlineCart.toObject());
  }

  /* =========== CASE B: Target DINE_IN (ONLINE -> QR) [migrasi sebaliknya] =========== */
  // Ambil cart QR jika ada
  let qrCart = await Cart.findOne({
    status: 'active',
    source: 'qr',
    ...identityFilter
  });

  // Ambil cart ONLINE sumber item (kalau ada)
  let onlineCartObj = await getActiveCartForIdentity(
    { ...iden, source: 'online' },
    { allowCreateOnline: false }
  );
  let onlineCart = onlineCartObj
    ? await Cart.findById(onlineCartObj._id)
    : null;

  // Pastikan ada table_number: ambil dari body atau dari qrCart yang eksisting
  const incomingTable = asInt(req.body?.table_number, 0);
  const finalTableNo =
    incomingTable || (qrCart ? asInt(qrCart.table_number, 0) : 0);
  if (!finalTableNo) {
    throwError('Nomor meja wajib saat pindah ke dine_in', 400);
  }

  // Jika belum ada cart QR, buat/ambil satu
  if (!qrCart) {
    const ensureSession = iden.memberId
      ? null
      : iden.session_id || crypto.randomUUID();
    qrCart = await Cart.findOneAndUpdate(
      {
        status: 'active',
        source: 'qr',
        ...(iden.memberId
          ? { member: iden.memberId }
          : { session_id: ensureSession })
      },
      {
        $setOnInsert: {
          member: iden.memberId || null,
          session_id: iden.memberId ? null : ensureSession,
          table_number: finalTableNo,
          fulfillment_type: 'dine_in',
          items: [],
          total_items: 0,
          total_quantity: 0,
          total_price: 0,
          status: 'active',
          source: 'qr'
        }
      },
      { new: true, upsert: true }
    );
  } else {
    // update nomor meja jika datang table_number baru
    if (incomingTable) qrCart.table_number = finalTableNo;
  }

  // Kalau ada cart ONLINE: merge item-nya ke QR
  if (onlineCart && (onlineCart.items?.length || 0) > 0) {
    const idxMap = new Map(
      (qrCart.items || []).map((it, i) => [String(it.line_key), i])
    );
    for (const it of onlineCart.items || []) {
      const key = String(it.line_key);
      if (idxMap.has(key)) {
        const i = idxMap.get(key);
        const q = asInt(qrCart.items[i].quantity, 1) + asInt(it.quantity, 1);
        qrCart.items[i].quantity = clamp(q, 1, 999);
      } else {
        qrCart.items.push({
          menu: it.menu,
          menu_code: it.menu_code || '',
          name: it.name,
          imageUrl: it.imageUrl || '',
          base_price: asInt(it.base_price, 0),
          quantity: clamp(asInt(it.quantity, 1), 1, 999),
          addons: normalizeAddons(it.addons),
          notes: String(it.notes || '').trim(),
          line_key: key,
          category: it.category || null
        });
        idxMap.set(key, qrCart.items.length - 1);
      }
    }
    qrCart.fulfillment_type = 'dine_in';
    qrCart.table_number = finalTableNo;
    recomputeTotals(qrCart);
    await qrCart.save();

    // Kosongkan ONLINE
    onlineCart.items = [];
    recomputeTotals(onlineCart);
    await onlineCart.save();

    return res.status(200).json(qrCart.toObject());
  }

  // Tidak ada ONLINE atau kosong → cukup set FT di cart tujuan (QR)
  qrCart.fulfillment_type = 'dine_in';
  qrCart.table_number = finalTableNo;
  recomputeTotals(qrCart);
  await qrCart.save();

  return res.status(200).json(qrCart.toObject());
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

  // ===== Resolve fulfillment type =====
  const ft =
    iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
  if (!['dine_in', 'delivery'].includes(ft)) {
    throwError('fulfillment_type tidak valid', 400);
  }

  // ===== Validasi metode bayar =====
  const method = String(payment_method || '').toLowerCase();
  if (!isPaymentMethodAllowed(iden0.source || 'online', ft, method)) {
    throwError('Metode pembayaran tidak diizinkan untuk mode ini', 400);
  }

  // Flag metode
  const methodIsGateway = method === PM.QRIS; // hanya QRIS yang ke PG
  const requiresProof = needProof(method);

  // ===== Identitas member / guest (tetap seperti kode kamu) =====
  const originallyLoggedIn = !!iden0.memberId;
  const wantRegister = String(register_decision || 'register') === 'register';

  let member = null;
  let customer_name = '';
  let customer_phone = '';

  if (originallyLoggedIn || wantRegister) {
    const joinChannel = iden0.mode === 'self_order' ? 'self_order' : 'online';
    member = await ensureMemberForCheckout(req, res, joinChannel);
  } else {
    customer_name = String(name || '').trim();
    customer_phone = String(phone || '').trim();
    if (!customer_name && !customer_phone) {
      throwError('Tanpa member: isi minimal nama atau no. telp', 400);
    }
  }

  // ===== Ambil cart aktif (kode kamu, tidak diubah) =====
  const iden = {
    ...iden0,
    memberId: member?._id || iden0.memberId || null,
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

  // ===== Idempotency (tetap) =====
  if (
    idempotency_key &&
    cart.last_idempotency_key === idempotency_key &&
    cart.order_id
  ) {
    return res.status(200).json({
      order: { _id: cart.order_id },
      idempotent: true,
      message: 'Checkout sudah diproses sebelumnya'
    });
  }

  if (member && !cart.member) {
    cart.member = member._id;
    cart.session_id = null;
  }

  // ===== Delivery setup (tetap) =====
  let delivery = undefined;
  let delivery_fee = 0;
  if (ft === 'delivery') {
    const latN = Number(lat),
      lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
      throwError('Lokasi (lat,lng) wajib untuk delivery', 400);
    }
    const distance_km = haversineKm(CAFE_COORD, { lat: latN, lng: lngN });
    if (distance_km > Number(DELIVERY_MAX_RADIUS_KM || 0)) {
      throwError(`Di luar radius ${DELIVERY_MAX_RADIUS_KM} km`, 400);
    }
    delivery_fee = calcDeliveryFee();
    delivery = {
      address_text: String(address_text || '').trim(),
      location: { lat: latN, lng: lngN },
      distance_km: Number(distance_km.toFixed(2)),
      delivery_fee,
      note_to_rider: String(note_to_rider || ''),
      status: 'pending'
    };
  }

  // ===== Voucher pricing (tetap) =====
  recomputeTotals(cart);
  await cart.save();

  let eligibleClaimIds = [];
  if (member) {
    if (Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
      const rawClaims = await VoucherClaim.find({
        _id: { $in: voucherClaimIds },
        member: member._id,
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
    memberId: member ? member._id : null,
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

  // ===== PPN =====
  const rate = parsePpnRate();
  const taxBase =
    priced.totals.baseSubtotal -
    priced.totals.itemsDiscount +
    priced.totals.deliveryFee -
    priced.totals.shippingDiscount;
  const taxAmount = Math.round(Math.max(0, taxBase * rate));
  const taxRatePercent = Math.round(rate * 100 * 100) / 100;

  priced.totals.taxAmount = taxAmount;
  priced.totals.taxRatePercent = taxRatePercent;
  priced.totals.grandTotal = taxBase + taxAmount;

  // ===== Bukti transfer (kalau perlu) =====
  const payment_proof_url = await handleTransferProofIfAny(req, method);

  // ===== Tentukan payment_status awal =====
  let payment_status = 'unpaid';
  let payment_provider = null;

  if (methodIsGateway) {
    // qris via PG
    payment_provider = 'xendit';
    payment_status = 'unpaid';
  } else if (requiresProof) {
    // transfer + bukti → dianggap paid, nunggu verify manual
    payment_status = 'paid';
  } else {
    // cash / card di flow online: default unpaid, nanti kasir ubah (atau pakai POS endpoint)
    payment_status = 'unpaid';
  }

  // ===== Buat Order =====
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: member ? member._id : null,
          customer_name: member ? '' : customer_name,
          customer_phone: member ? '' : customer_phone,
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
            notes: it.notes,
            category: it.category || null
          })),

          delivery_fee: priced.totals.deliveryFee,
          items_discount: priced.totals.itemsDiscount,
          shipping_discount: priced.totals.shippingDiscount,
          discounts: priced.breakdown,

          payment_method: method,
          payment_provider,
          payment_status,
          payment_proof_url,

          status: 'created',
          placed_at: new Date()
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
  if (member) {
    for (const claimId of priced.chosenClaimIds || []) {
      try {
        const c = await VoucherClaim.findById(claimId);
        if (
          c &&
          c.status === 'claimed' &&
          String(c.member) === String(member._id)
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
      } catch (_) {}
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
  if (member) {
    await Member.findByIdAndUpdate(member._id, {
      $inc: { total_spend: order.grand_total || 0 },
      $set: { last_visit_at: new Date() }
    });
  }

  /* ===== Emit realtime ===== */
  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: member
      ? { id: String(member._id), name: member.name, phone: member.phone }
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
  if (member) emitToMember(member._id, 'order:new', payload);
  if ((iden.source || 'online') === 'qr' && order.table_number) {
    emitToTable(order.table_number, 'order:new', payload);
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

exports.assignTable = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);

  const table_number = asInt(req.body?.table_number, 0);
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

  const identityFilter = iden.memberId
    ? { member: iden.memberId }
    : { session_id: sessionId };

  let cart = await Cart.findOne({
    status: 'active',
    source: 'qr',
    ...identityFilter
  });

  if (!cart) {
    cart = await Cart.create({
      member: iden.memberId || null,
      session_id: iden.memberId ? null : sessionId,
      table_number,
      fulfillment_type: 'dine_in',
      items: [],
      total_items: 0,
      total_quantity: 0,
      total_price: 0,
      status: 'active',
      source: 'qr'
    });
  } else {
    cart.table_number = table_number;
    await cart.save();
  }

  await Cart.deleteMany({
    _id: { $ne: cart._id },
    status: 'active',
    source: 'qr',
    ...identityFilter
  }).catch(() => {});

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

  // Tentukan nama & phone yang ditampilkan
  const displayName = order.member?.name || order.customer_name || '';
  const displayPhone = order.member?.phone || order.customer_phone || '';

  return {
    id: String(order._id),
    transaction_code: order.transaction_code || '',
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    // ringkasan harga
    pricing: {
      items_subtotal: order.items_subtotal,
      service_fee: order.service_fee,
      delivery_fee: order.delivery_fee,
      items_discount: order.items_discount,
      shipping_discount: order.shipping_discount,
      tax_amount: order.tax_amount,
      rounding_delta: order.rounding_delta,
      grand_total: order.grand_total
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
    items: (order.items || []).map((it) => ({
      name: it.name,
      menu_code: it.menu_code || '',
      imageUrl: it.imageUrl || '',
      quantity: it.quantity,
      addons: (it.addons || []).map((ad) => ({
        name: ad.name,
        price: ad.price,
        qty: ad.qty
      })),
      line_subtotal: it.line_subtotal
    })),
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

  // ===== Metode bayar POS (khusus) =====
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

  // ===== Build items & subtotal (tanpa voucher/ongkir) =====
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

  // ===== Pajak (PPN) & grand total =====
  const rate = (() => {
    const raw = Number(process.env.PPN_RATE ?? 0.11);
    if (!Number.isFinite(raw)) return 0.11;
    return raw > 1 ? raw / 100 : raw;
  })();
  const taxBase = itemsSubtotal; // POS: no voucher, no delivery
  const taxAmount = Math.round(Math.max(0, taxBase * rate));
  const taxRatePercent = Math.round(rate * 100 * 100) / 100; // 2 desimal
  const grandTotal = taxBase + taxAmount;

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

          // totals (tanpa voucher/ongkir)
          items_subtotal: itemsSubtotal,
          items_discount: 0,
          delivery_fee: 0,
          shipping_discount: 0,
          discounts: [],
          grand_total: grandTotal,

          // pajak
          tax_rate_percent: taxRatePercent,
          tax_amount: taxAmount,

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
  const taxAmount = Math.round(Math.max(0, taxBase * rate));
  const grandTotal = taxBase + taxAmount;

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
      grand_total: grandTotal
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

  // Ambil minimal field untuk validasi status
  const order = await Order.findById(
    id,
    'fulfillment_type status payment_status member transaction_code'
  );
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.fulfillment_type !== 'delivery') {
    throwError('Order ini bukan delivery', 400);
  }
  if (order.status === 'cancelled' || order.payment_status !== 'paid') {
    throwError('Order belum layak dikirim (harus paid & tidak cancelled)', 409);
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
    {
      new: true,
      runValidators: false // kita hanya set field delivery; hindari validator global yang mungkin bergantung pada pricing
    }
  );

  // Payload notifikasi
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
    message: 'Kurir berhasil di-assign',
    order: updated.toObject()
  });
});

/**
 * PATCH /orders/:id/delivery/status
 * Body: { status: 'assigned'|'picked_up'|'on_the_way'|'delivered'|'failed', note?: string }
 */
exports.updateDeliveryStatus = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status, note } = req.body || {};
  if (!DELIVERY_ALLOWED.includes(status))
    throwError('Status delivery tidak valid', 400);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);
  if (order.fulfillment_type !== 'delivery') {
    throwError('Order ini bukan delivery', 400);
  }
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
  if (status === 'picked_up') order.delivery.picked_up_at = now;
  if (status === 'on_the_way') order.delivery.on_the_way_at = now;
  if (status === 'delivered') order.delivery.delivered_at = now;
  if (status === 'failed') order.delivery.failed_at = now;
  if (note) {
    order.delivery.status_note = String(note).trim();
  }

  if (
    status === 'delivered' &&
    order.payment_status === 'paid' &&
    order.status !== 'completed'
  ) {
    order.status = 'completed';
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
