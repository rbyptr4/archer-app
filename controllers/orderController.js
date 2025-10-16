// controllers/onlineController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');

const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const Member = require('../models/memberModel');
const Order = require('../models/orderModel');
const MemberSession = require('../models/memberSessionModel');
const VoucherClaim = require('../models/voucherClaimModel');

const throwError = require('../utils/throwError');
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

// === NEW: logger history ===
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
const ALLOWED_STATUSES = [
  'created',
  'accepted',
  'preparing',
  'served',
  'completed',
  'cancelled'
];
const ALLOWED_PAY_STATUS = ['unpaid', 'paid', 'refunded', 'void'];

const canTransit = (from, to) => {
  const flow = {
    created: ['accepted', 'cancelled'],
    accepted: ['preparing', 'cancelled'],
    preparing: ['served', 'cancelled'],
    served: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
  };
  return (flow[from] || []).includes(to);
};
const isKitchenStatus = (s) => s === 'accepted' || s === 'preparing';

const DELIVERY_ALLOWED = [
  'pending',
  'assigned',
  'picked_up',
  'on_the_way',
  'delivered',
  'failed'
];

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

exports.modeResolver = asyncHandler(async (req, _res, next) => {
  const ft = req.body?.fulfillment_type || req.query?.fulfillment_type;
  const headerSrc = String(req.headers['x-order-source'] || '').toLowerCase();
  const tableNumber = asInt(req.query.table ?? req.body?.table_number, 0);

  let mode = 'online';
  let source = 'online';
  if (String(ft) === 'delivery') {
    mode = 'online';
    source = 'online';
  } else if (tableNumber) {
    mode = 'self_order';
    source = 'qr';
  } else if (headerSrc === 'qr') {
    mode = 'self_order';
    source = 'qr';
  }

  const sessionHeader =
    req.headers['x-online-session'] ||
    req.headers['x-qr-session'] ||
    req.body?.online_session_id ||
    req.body?.session_id ||
    null;

  req.orderMode = mode; // 'self_order' | 'online'
  req.orderSource = source; // 'qr' | 'online'
  req.session_id = sessionHeader ? String(sessionHeader).trim() : null;
  req.table_number = tableNumber || null;

  next();
});

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

const findOrCreateCart = async (iden) => {
  const filter = {
    status: 'active',
    source: iden.source,
    ...(iden.mode === 'self_order' ? { table_number: iden.table_number } : {}),
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.session_id })
  };
  let cart = await Cart.findOne(filter).lean();
  if (cart) return cart;

  const created = await Cart.create({
    member: iden.memberId || null,
    session_id: iden.memberId ? null : iden.session_id || crypto.randomUUID(),
    table_number: iden.mode === 'self_order' ? iden.table_number : null,
    items: [],
    total_items: 0,
    total_quantity: 0,
    total_price: 0,
    status: 'active',
    source: iden.source
  });
  return created.toObject();
};

/* =============== Member helper (unified) =============== */
const ensureMemberForCheckout = async (req, res, joinChannel) => {
  if (req.member?.id) {
    const m = await Member.findById(req.member.id).lean();
    if (!m) throwError('Member tidak ditemukan', 404);
    return m;
  }

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
      name,
      phone: normalizedPhone,
      join_channel: joinChannel, // 'self_order' | 'online' | 'pos'
      visit_count: 1,
      last_visit_at: new Date(),
      is_active: true
    });
  } else {
    if (name && member.name !== name) member.name = name;
    member.visit_count += 1;
    member.last_visit_at = new Date();
    if (!member.is_active) member.is_active = true;
    await member.save();
  }

  // Start sesi device-bound
  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

  const accessToken = signAccessToken(member);
  const refreshToken = generateOpaqueToken();
  const refreshHash = hashToken(refreshToken);

  await MemberSession.create({
    member: member._id,
    device_id,
    refresh_hash: refreshHash,
    user_agent: req.get('user-agent') || '',
    ip: req.ip,
    expires_at: new Date(Date.now() + REFRESH_TTL_MS)
  });

  res.cookie(ACCESS_COOKIE, accessToken, cookieAccess);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieRefresh);
  res.cookie(DEVICE_COOKIE, device_id, cookieDevice);

  return member.toObject ? member.toObject() : member;
};

/* ===================== CART ENDPOINTS (unified) ===================== */
exports.getCart = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  if (iden.mode === 'self_order' && !iden.table_number) {
    throwError('Nomor meja belum diisi.', 400);
  }
  const cart = await findOrCreateCart(iden);
  res.status(200).json(cart);
});

exports.addItem = asyncHandler(async (req, res) => {
  const { menu_id, quantity = 1, addons = [], notes = '' } = req.body || {};
  if (!menu_id) throwError('menu_id wajib', 400);

  const iden = getIdentity(req);
  const menu = await Menu.findById(menu_id).lean();
  if (!menu || !menu.isActive)
    throwError('Menu tidak ditemukan / tidak aktif', 404);
  if (req.orderMode === 'self_order' && !req.table_number) {
    throwError('Nomor meja wajib diisi sebelum menambah item', 400);
  }
  const qty = clamp(asInt(quantity, 1), 1, 999);
  const normAddons = normalizeAddons(addons);
  const line_key = makeLineKey({ menuId: menu._id, addons: normAddons, notes });

  const filter = {
    status: 'active',
    source: iden.source,
    ...(iden.mode === 'self_order' ? { table_number: iden.table_number } : {}),
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.session_id })
  };
  let cart = await Cart.findOne(filter);
  if (!cart) {
    cart = await Cart.create({
      member: iden.memberId || null,
      session_id: iden.memberId ? null : iden.session_id || crypto.randomUUID(),
      table_number: iden.mode === 'self_order' ? iden.table_number : null,
      items: [],
      status: 'active',
      source: iden.source
    });
  }

  const idx = cart.items.findIndex((it) => it.line_key === line_key);
  if (idx >= 0) {
    const newQty = clamp(cart.items[idx].quantity + qty, 1, 999);
    cart.items[idx].quantity = newQty;
  } else {
    cart.items.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: asInt(menu.price, 0),
      quantity: qty,
      addons: normAddons,
      notes: String(notes || '').trim(),
      line_key,
      category: menu.category || menu.bigCategory || null
    });
  }

  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

exports.updateItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const { quantity, addons, notes } = req.body || {};
  const iden = getIdentity(req);

  const filter = {
    status: 'active',
    source: iden.source,
    ...(iden.mode === 'self_order' ? { table_number: iden.table_number } : {}),
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.session_id })
  };
  const cart = await Cart.findOne(filter);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  const idx = cart.items.findIndex((it) => String(it._id) === String(itemId));
  if (idx < 0) throwError('Item tidak ditemukan di cart', 404);

  if (quantity !== undefined) {
    const q = clamp(asInt(quantity, 0), 0, 999);
    if (q === 0) cart.items.splice(idx, 1);
    else cart.items[idx].quantity = q;
  }
  if (cart.items[idx]) {
    if (addons !== undefined) cart.items[idx].addons = normalizeAddons(addons);
    if (notes !== undefined) cart.items[idx].notes = String(notes || '').trim();
    cart.items[idx].line_key = makeLineKey({
      menuId: cart.items[idx].menu,
      addons: cart.items[idx].addons,
      notes: cart.items[idx].notes
    });
  }

  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

exports.removeItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const iden = getIdentity(req);

  const filter = {
    status: 'active',
    source: iden.source,
    ...(iden.mode === 'self_order' ? { table_number: iden.table_number } : {}),
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.session_id })
  };
  const cart = await Cart.findOne(filter);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  const before = cart.items.length;
  cart.items = cart.items.filter((it) => String(it._id) !== String(itemId));
  if (before === cart.items.length)
    throwError('Item tidak ditemukan di cart', 404);

  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

exports.clearCart = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const filter = {
    status: 'active',
    source: iden.source,
    ...(iden.mode === 'self_order' ? { table_number: iden.table_number } : {}),
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.session_id })
  };
  const cart = await Cart.findOne(filter);
  if (!cart) throwError('Cart tidak ditemukan', 404);

  cart.items = [];
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
  const iden = getIdentity(req);
  const {
    name,
    phone,
    fulfillment_type, // 'dine_in' | 'delivery'
    address_text,
    lat,
    lng,
    note_to_rider,
    idempotency_key,
    voucherClaimIds = []
  } = req.body || {};

  const ft =
    iden.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
  if (!['dine_in', 'delivery'].includes(ft)) {
    throwError('fulfillment_type tidak valid', 400);
  }
  if (iden.mode === 'self_order' && ft !== 'dine_in') {
    throwError('Self-order hanya mendukung dine_in', 400);
  }

  if (!req.file?.buffer) {
    throwError('Bukti pembayaran wajib dikirim', 400);
  }

  const joinChannel = iden.mode === 'self_order' ? 'self_order' : 'online';
  const member = await ensureMemberForCheckout(req, res, joinChannel);

  let cart = await Cart.findOne({
    status: 'active',
    source: iden.source,
    ...(iden.mode === 'self_order' ? { table_number: iden.table_number } : {}),
    $or: [{ member: member._id }, { session_id: iden.session_id }]
  });

  if (!cart) throwError('Cart tidak ditemukan / kosong', 404);
  if (!cart.items?.length) throwError('Cart kosong', 400);

  // Idempotency via cart
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

  // Pastikan cart terikat member
  if (!cart.member) {
    cart.member = member._id;
    cart.session_id = null;
  }

  // Upload bukti bayar (kalau ada)
  let payment_proof_url = '';
  if (req.file?.buffer && req.file?.mimetype) {
    const folderId = getDriveFolder('invoice');
    const uploaded = await uploadBuffer(
      req.file.buffer,
      `payment-${Date.now()}`,
      req.file.mimetype,
      folderId
    );
    payment_proof_url = `https://drive.google.com/uc?export=view&id=${uploaded.id}`;
  }

  // Delivery block & fee (hanya untuk delivery)
  let delivery = undefined;
  let delivery_fee = 0;

  if (ft === 'delivery') {
    const latN = Number(lat),
      lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
      throwError('Lokasi (lat,lng) wajib untuk delivery', 400);
    }
    const distance_km = haversineKm(CAFE_COORD, { lat: latN, lng: lngN });
    if (distance_km > Number(DELIVERY_MAX_RADIUS_KM || 0) + 1e-9) {
      throwError(`Di luar radius ${DELIVERY_MAX_RADIUS_KM}km`, 400);
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

  // Recompute cart
  recomputeTotals(cart);
  await cart.save();

  // Voucher pricing
  let priced = {
    totals: {
      baseSubtotal: cart.total_price,
      itemsDiscount: 0,
      deliveryFee: delivery_fee,
      shippingDiscount: 0,
      grandTotal: cart.total_price + delivery_fee
    },
    breakdown: [],
    chosenClaimIds: []
  };

  // Aktifkan voucher untuk delivery (bisa diaktifkan dine_in kalau mau)
  if (ft === 'delivery') {
    priced = await validateAndPrice({
      memberId: member._id,
      cart: {
        items: cart.items.map((it) => ({
          menuId: it.menu,
          qty: it.quantity,
          price: it.base_price,
          category: it.category || null
        }))
      },
      deliveryFee: delivery_fee,
      voucherClaimIds
    });
  }

  // Self-order wajib punya nomor meja (jika belum, beri dari body)
  if (iden.mode === 'self_order') {
    const incomingTable = asInt(req.body?.table_number, 0);
    if (!cart.table_number && incomingTable) {
      cart.table_number = incomingTable;
      await cart.save();
    }
    if (!cart.table_number) {
      throwError('Silakan isi nomor meja terlebih dahulu', 400);
    }
  }

  // Buat ORDER dengan kode transaksi harian unik
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: cart.member,
          table_number: iden.mode === 'self_order' ? cart.table_number : null,
          source: iden.source, // 'qr' | 'online'
          fulfillment_type: ft, // 'dine_in' | 'delivery'
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
            line_subtotal: it.line_subtotal,
            category: it.category || null
          })),
          total_quantity: cart.total_quantity,
          delivery,
          items_subtotal: priced.totals.baseSubtotal,
          items_discount: priced.totals.itemsDiscount,
          delivery_fee: priced.totals.deliveryFee,
          shipping_discount: priced.totals.shippingDiscount,
          discounts: priced.breakdown,
          grand_total: priced.totals.grandTotal,
          payment_method: iden.mode === 'online' ? 'qr' : 'manual',
          payment_proof_url,
          status: 'created',
          payment_status: 'unpaid',
          placed_at: new Date()
        });
      } catch (e) {
        if (e && e.code === 11000 && /transaction_code/.test(String(e.message)))
          continue;
        throw e;
      }
    }
    throw new Error('Gagal generate transaction_code unik');
  })();

  // Konsumsi voucher claims (kalau ada)
  for (const claimId of priced.chosenClaimIds) {
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

  // Tandai cart selesai
  await Cart.findByIdAndUpdate(
    cart._id,
    {
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
    },
    { new: true }
  );

  // Statistik member
  await Member.findByIdAndUpdate(member._id, {
    $inc: { total_spend: order.grand_total || 0 },
    $set: { last_visit_at: new Date() }
  });

  // Emit realtime
  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: { id: String(member._id), name: member.name, phone: member.phone },
    items_total: order.items_subtotal,
    grand_total: order.grand_total,
    total_quantity: order.total_quantity,
    source: order.source,
    fulfillment_type: order.fulfillment_type,
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    placed_at: order.placed_at,
    payment_proof_url: order.payment_proof_url || '',
    delivery: order.delivery || null,
    table_number: order.table_number || null
  };
  emitToStaff('order:new', payload);
  emitToMember(member._id, 'order:new', payload);
  if (iden.mode === 'self_order' && order.table_number) {
    emitToTable(order.table_number, 'order:new', payload);
  }

  res.status(201).json({
    order: { ...order.toObject(), transaction_code: order.transaction_code },
    message: 'Checkout berhasil'
  });
});

exports.assignTable = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  if (iden.mode !== 'self_order') throwError('Hanya untuk self-order', 400);

  const table_number = asInt(req.body?.table_number, 0);
  if (!table_number) throwError('table_number wajib', 400);

  let cart = await Cart.findOne({
    status: 'active',
    source: 'qr',
    table_number,
    $or: [{ member: iden.memberId }, { session_id: iden.session_id }]
  });

  if (!cart) {
    await Cart.deleteMany({
      status: 'active',
      source: 'qr',
      table_number: null,
      $or: [{ member: iden.memberId }, { session_id: iden.session_id }]
    });

    cart = await Cart.create({
      member: iden.memberId || null,
      session_id: iden.memberId ? null : iden.session_id || crypto.randomUUID(),
      table_number,
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

  emitToStaff('cart:table_assigned', {
    cart_id: String(cart._id),
    table_number
  });
  emitToTable(table_number, 'cart:table_assigned', {
    cart_id: String(cart._id)
  });

  res.json({ message: 'Nomor meja diset', cart: cart.toObject() });
});

/* ===================== MEMBER ENDPOINTS ===================== */
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

exports.previewPrice = asyncHandler(async (req, res) => {
  if (!req.member?.id) throwError('Harus login sebagai member', 401);
  const { cart, deliveryFee = 0, voucherClaimIds = [] } = req.body || {};
  if (!cart?.items?.length) throwError('Cart kosong', 400);

  const result = await validateAndPrice({
    memberId: req.member.id,
    cart,
    deliveryFee,
    voucherClaimIds
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

exports.listKitchenOrders = asyncHandler(async (_req, res) => {
  const items = await Order.find({
    status: { $in: ['accepted', 'preparing'] },
    payment_status: 'paid'
  })
    .sort({ placed_at: 1 })
    .lean();
  res.status(200).json({ items });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);
  const { status, reason } = req.body || {};
  if (!ALLOWED_STATUSES.includes(status)) throwError('Status tidak valid', 400);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);
  if (order.status === status) return res.status(200).json(order.toObject());
  if (!canTransit(order.status, status))
    throwError(
      `Transisi status dari "${order.status}" ke "${status}" tidak diizinkan`,
      400
    );

  if (isKitchenStatus(status) && !order.canMoveToKitchen?.()) {
    throwError('Order belum paid. Tidak bisa masuk accepted/preparing.', 409);
  }

  if (
    status === 'completed' &&
    order.fulfillment_type === 'delivery' &&
    order.delivery?.status !== 'delivered'
  ) {
    throwError('Order delivery belum delivered. Tidak bisa completed.', 409);
  }

  const fromStatus = order.status;
  order.status = status;
  if (status === 'cancelled') {
    order.cancellation_reason = String(reason || '').trim();
    order.cancelled_at = new Date();
    if (order.payment_status === 'paid') {
      order.payment_status = 'refunded';
    } else if (order.payment_status === 'unpaid') {
      order.payment_status = 'void';
    }
  }
  await order.save();

  // Award poin jika sudah paid tapi belum award
  if (order.payment_status === 'paid' && !order.loyalty_awarded_at) {
    await awardPointsIfEligible(order, Member);
  }

  // === NEW: log refund history jika hasil akhirnya refunded ===
  if (fromStatus !== 'cancelled' && order.payment_status === 'refunded') {
    await logRefundHistory(order);
  }

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: String(order.member),
    table_number: order.table_number || null,
    from_status: fromStatus,
    status: order.status,
    reason: order.cancellation_reason || undefined,
    at: new Date()
  };
  emitToMember(order.member, 'order:status', payload);
  emitToStaff('order:status', payload);
  if (order.table_number)
    emitToTable(order.table_number, 'order:status', payload);

  res.status(200).json(order.toObject());
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  const isStaff = !!req.user;
  const isMemberOwner =
    req.member?.id && String(order.member) === String(req.member.id);
  if (!isStaff && !isMemberOwner) throwError('Unauthorized', 401);

  if (
    isMemberOwner &&
    !(order.status === 'created' && order.payment_status === 'unpaid')
  )
    throwError('Order tidak bisa dibatalkan oleh member pada status ini', 400);
  if (isStaff && (order.status === 'completed' || order.status === 'cancelled'))
    throwError('Order sudah selesai/dibatalkan', 400);

  const fromStatus = order.status;
  order.status = 'cancelled';
  order.payment_status = order.payment_status === 'paid' ? 'refunded' : 'void';
  order.cancellation_reason = String(reason || '').trim();
  order.cancelled_at = new Date();
  await order.save();

  // === NEW: log refund history jika memang jadi refunded ===
  if (order.payment_status === 'refunded') {
    await logRefundHistory(order);
  }

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: String(order.member),
    table_number: order.table_number || null,
    from_status: fromStatus,
    status: order.status,
    reason: order.cancellation_reason,
    at: new Date()
  };
  emitToMember(order.member, 'order:status', payload);
  emitToStaff('order:status', payload);
  if (order.table_number)
    emitToTable(order.table_number, 'order:status', payload);

  res.status(200).json(order.toObject());
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
    mark_paid = false,
    payment_method = 'cash'
  } = req.body || {};

  const tableNo = asInt(table_number, 0);
  if (!tableNo) throwError('table_number wajib', 400);
  if (!Array.isArray(items) || !items.length) throwError('items wajib', 400);

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
      member = await Member.findOne({ phone: normalizedPhone }).lean();
      if (!member) {
        const created = await Member.create({
          name: String(name).trim(),
          phone: normalizedPhone,
          join_channel: 'pos',
          visit_count: 1,
          last_visit_at: new Date(),
          is_active: true
        });
        member = created.toObject();
      }
    }
  } else {
    customer_name = String(name || '').trim();
    customer_phone = String(phone || '').trim();
    if (!customer_name && !customer_phone) {
      throwError('Tanpa member: isi minimal nama atau no. telp', 400);
    }
  }

  // Build items & totals
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
    const line_subtotal = (asInt(menu.price, 0) + addonsTotal) * qty;

    orderItems.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: asInt(menu.price, 0),
      quantity: qty,
      addons: normAddons,
      notes: String(it.notes || '').trim(),
      line_subtotal
    });
    totalQty += qty;
    itemsSubtotal += line_subtotal;
  }

  const now = new Date();

  // Create order
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
          items_subtotal: itemsSubtotal,
          items_discount: 0,
          delivery_fee: 0,
          shipping_discount: 0,
          discounts: [],
          grand_total: itemsSubtotal,
          payment_method,
          payment_status: mark_paid ? 'paid' : 'unpaid',
          paid_at: mark_paid ? now : null,
          verified_by: mark_paid ? req.user?.id || null : null,
          verified_at: mark_paid ? now : null,
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

  if (order.payment_status === 'paid') {
    await awardPointsIfEligible(order, Member);
    // === NEW: log paid history saat dibuat paid ===
    await logPaidHistory(order, req.user);
  }

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
    message: 'Order POS dine-in dibuat'
  });
});

/* ===================== VERIFY PAYMENT (staff) ===================== */
exports.verifyPayment = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { payment_method = 'qr', note } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.payment_status === 'paid') {
    return res.status(200).json({ message: 'Sudah paid', order });
  }
  if (order.status === 'cancelled') {
    throwError('Order sudah dibatalkan, tidak dapat diverifikasi', 400);
  }

  const now = new Date();
  order.payment_method = payment_method || order.payment_method || 'qr';
  order.payment_status = 'paid';
  order.paid_at = now;
  order.verified_by = req.user._id;
  order.verified_at = now;
  if (!order.placed_at) order.placed_at = now;

  await order.save();

  if (!order.loyalty_awarded_at) {
    await awardPointsIfEligible(order, Member);
  }

  // === NEW: log paid history ===
  await logPaidHistory(order, req.user);

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    status: order.status,
    payment_status: order.payment_status,
    paid_at: order.paid_at,
    verified_by: { id: String(req.user._id), name: req.user.name },
    note: String(note || '')
  };
  emitToStaff('order:payment_verified', payload);
  if (order.member)
    emitToMember(order.member, 'order:payment_verified', payload);
  if (order.table_number)
    emitToTable(order.table_number, 'order:payment_verified', payload);

  res.status(200).json({ message: 'Pembayaran diverifikasi', order });
});

/* ===================== REFUND (staff) ===================== */
exports.refundPayment = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { reason } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.payment_status !== 'paid') {
    return res
      .status(400)
      .json({ message: 'Order belum paid / sudah direfund', order });
  }

  const now = new Date();
  order.payment_status = 'refunded';
  order.status = 'cancelled';
  order.cancelled_at = now;
  order.cancellation_reason = String(reason || 'Refund by staff').trim();

  await order.save();

  // === NEW: log refund history ===
  await logRefundHistory(order);

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    status: order.status,
    payment_status: order.payment_status,
    cancelled_at: order.cancelled_at,
    reason: order.cancellation_reason
  };
  emitToStaff('order:refunded', payload);
  if (order.member) emitToMember(order.member, 'order:refunded', payload);
  if (order.table_number)
    emitToTable(order.table_number, 'order:refunded', payload);

  res.status(200).json({ message: 'Order direfund & dibatalkan', order });
});

exports.assignDelivery = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { courier_id, courier_name, courier_phone, note } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.fulfillment_type !== 'delivery') {
    throwError('Order ini bukan delivery', 400);
  }
  if (order.status === 'cancelled' || order.payment_status !== 'paid') {
    throwError('Order belum layak dikirim (harus paid & tidak cancelled)', 409);
  }

  // Inisialisasi blok delivery bila belum ada
  if (!order.delivery) {
    order.delivery = {
      status: 'pending',
      address_text: order.delivery?.address_text || '',
      location: order.delivery?.location || null,
      distance_km: order.delivery?.distance_km || null,
      delivery_fee: order.delivery?.delivery_fee || 0,
      note_to_rider: order.delivery?.note_to_rider || ''
    };
  }

  // Set kurir
  order.delivery.courier = {
    id: courier_id || null,
    name: (courier_name || '').trim(),
    phone: (courier_phone || '').trim()
  };
  order.delivery.status = 'assigned';
  order.delivery.assigned_at = new Date();
  if (note) order.delivery.assign_note = String(note).trim();

  await order.save();

  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    delivery: {
      status: order.delivery.status,
      courier: order.delivery.courier,
      assigned_at: order.delivery.assigned_at
    }
  };
  emitToStaff('order:delivery_assigned', payload);
  if (order.member)
    emitToMember(order.member, 'order:delivery_assigned', payload);

  res.status(200).json({
    message: 'Kurir berhasil di-assign',
    order: order.toObject()
  });
});

/**
 * PATCH /orders/:id/delivery/status
 * Body: { status: 'assigned'|'picked_up'|'on_the_way'|'delivered'|'failed', note?: string }
 * Catatan:
 *  - Transisi harus valid (canTransitDelivery).
 *  - Kalau jadi 'delivered' dan order belum completed, kita auto-complete kalau mau (opsional).
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

  // Update status & timestamp spesifik
  order.delivery.status = status;
  const now = new Date();
  if (status === 'picked_up') order.delivery.picked_up_at = now;
  if (status === 'on_the_way') order.delivery.on_the_way_at = now;
  if (status === 'delivered') order.delivery.delivered_at = now;
  if (status === 'failed') order.delivery.failed_at = now;
  if (note) {
    order.delivery.status_note = String(note).trim();
  }

  // Opsional: auto-complete order saat delivered (kalau sudah paid)
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
 * Query (opsional):
 *   - status: salah satu dari DELIVERY_ALLOWED (kalau kosong -> semua selain 'failed' & 'delivered' default)
 *   - paid_only: 'true' untuk hanya paid
 *   - limit, cursor (ISO) untuk pagination by createdAt desc
 */
exports.deliveryBoard = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status, paid_only = 'false', limit = 50, cursor } = req.query || {};
  const q = {
    fulfillment_type: 'delivery'
  };

  // Default board: tampilkan yang belum selesai (exclude delivered & failed) kalau status tidak dikirim
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
