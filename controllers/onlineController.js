const asyncHandler = require('express-async-handler');
const crypto = require('crypto');

const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const Member = require('../models/memberModel');
const Order = require('../models/orderModel');
const MemberSession = require('../models/memberSessionModel');

const throwError = require('../utils/throwError');
const { baseCookie } = require('../utils/authCookies');
const { uploadBuffer } = require('../utils/googleDrive');
const { getDriveFolder } = require('../utils/driveFolders');
const { emitToMember, emitToStaff } = require('./socket/socketBus');

const {
  DELIVERY_MAX_RADIUS_KM,
  CAFE_COORD,
  DELIVERY_FLAT_FEE
} = require('../config/onlineConfig');
const { haversineKm } = require('../utils/distance');

const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  REFRESH_TTL_MS,
  signAccessToken,
  generateOpaqueToken,
  hashToken
} = require('../utils/memberToken');

const { nextDailyTxCode } = require('../utils/txCode');

const VoucherClaim = require('../models/voucherClaimModel');
const { validateAndPrice } = require('../utils/voucherEngine');

/* =============== Cookie presets (member session) =============== */
const cookieAccess = { ...baseCookie, httpOnly: true, maxAge: 15 * 60 * 1000 };
const cookieRefresh = { ...baseCookie, httpOnly: true, maxAge: REFRESH_TTL_MS };
const cookieDevice = { ...baseCookie, httpOnly: false, maxAge: REFRESH_TTL_MS };

/* ===================== Utils umum ===================== */
const asInt = (v, def = 0) => (Number.isFinite(+v) ? +v : def);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const normalizePhone = (phone = '') =>
  phone.replace(/\s+/g, '').replace(/^(\+62|62|0)/, '0');

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

/* ===================== Delivery fee helper ===================== */
// Flat fee 5k (bisa override via env DELIVERY_FLAT_FEE)
const calcDeliveryFee = () =>
  Number(DELIVERY_FLAT_FEE ?? process.env.DELIVERY_FLAT_FEE ?? 5000);

/* ===================== Identity ONLINE (tanpa meja) ===================== */
const getOnlineIdentity = (req) => {
  const memberId = req.member?.id || null;
  const sessionId =
    req.headers['x-online-session'] || req.body?.online_session_id || null;
  if (!memberId && !sessionId)
    return { memberId: null, sessionId: 'anonymous' };
  return { memberId, sessionId };
};

const findOrCreateOnlineCart = async ({ memberId, sessionId }) => {
  const filter = {
    status: 'active',
    source: 'online',
    ...(memberId ? { member: memberId } : { session_id: sessionId })
  };
  let cart = await Cart.findOne(filter).lean();
  if (cart) return cart;

  const created = await Cart.create({
    member: memberId || null,
    session_id: memberId ? null : sessionId,
    table_number: null,
    items: [],
    total_items: 0,
    total_quantity: 0,
    total_price: 0,
    status: 'active',
    source: 'online'
  });
  return created.toObject();
};

/* ===================== Member helper ===================== */
const ensureOnlineMember = async (req, res) => {
  if (req.member?.id) {
    const m = await Member.findById(req.member.id).lean();
    if (!m) throwError('Member tidak ditemukan', 404);
    return m;
  }

  const { name, phone } = req.body || {};
  if (!name || !phone) throwError('Nama & nomor HP wajib', 400);

  const normalizedPhone = normalizePhone(phone);
  let member = await Member.findOne({ phone: normalizedPhone });

  if (!member) {
    member = await Member.create({
      name,
      phone: normalizedPhone,
      join_channel: 'online',
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

/* ===================== CART ===================== */
exports.getCart = asyncHandler(async (req, res) => {
  const iden = getOnlineIdentity(req);
  const cart = await findOrCreateOnlineCart(iden);
  res.status(200).json(cart);
});

exports.addToCart = asyncHandler(async (req, res) => {
  const { menu_id, quantity = 1, addons = [], notes = '' } = req.body || {};
  if (!menu_id) throwError('menu_id wajib', 400);

  const iden = getOnlineIdentity(req);
  const menu = await Menu.findById(menu_id).lean();
  if (!menu || !menu.isActive)
    throwError('Menu tidak ditemukan / tidak aktif', 404);

  const qty = clamp(asInt(quantity, 1), 1, 999);
  const normAddons = normalizeAddons(addons);
  const line_key = makeLineKey({ menuId: menu._id, addons: normAddons, notes });

  const filter = {
    status: 'active',
    source: 'online',
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.sessionId })
  };
  let cart = await Cart.findOne(filter);
  if (!cart) {
    cart = await Cart.create({
      member: iden.memberId || null,
      session_id: iden.memberId ? null : iden.sessionId,
      table_number: null,
      items: [],
      status: 'active',
      source: 'online'
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
      // ikutkan kategori untuk voucherEngine (kalau ada)
      category: menu.category || menu.bigCategory || null
    });
  }

  recomputeTotals(cart);
  await cart.save();
  res.status(200).json(cart.toObject());
});

exports.updateCartItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const { quantity, addons, notes } = req.body || {};
  const iden = getOnlineIdentity(req);

  const filter = {
    status: 'active',
    source: 'online',
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.sessionId })
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

exports.removeCartItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const iden = getOnlineIdentity(req);

  const filter = {
    status: 'active',
    source: 'online',
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.sessionId })
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
  const iden = getOnlineIdentity(req);
  const filter = {
    status: 'active',
    source: 'online',
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.sessionId })
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
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throwError('lat & lng wajib', 400);
  }

  // tetap hitung jarak untuk guard radius
  const distance_km = haversineKm(CAFE_COORD, { lat, lng });
  const within_radius =
    distance_km <= Number(DELIVERY_MAX_RADIUS_KM || 0) + 1e-9;

  // fee flat 5k (atau sesuai config/env)
  const delivery_fee = within_radius ? calcDeliveryFee() : null;

  res.status(200).json({
    distance_km: Number(distance_km.toFixed(2)),
    delivery_fee,
    within_radius,
    max_radius_km: Number(DELIVERY_MAX_RADIUS_KM || 0)
  });
});

/* ===================== CHECKOUT ONLINE ===================== */
exports.checkoutOnline = asyncHandler(async (req, res) => {
  const {
    name,
    phone,
    fulfillment_type,
    address_text,
    lat,
    lng,
    note_to_rider,
    idempotency_key,
    voucherClaimIds = []
  } = req.body || {};

  if (!['dine_in', 'delivery'].includes(fulfillment_type)) {
    throwError('fulfillment_type tidak valid', 400);
  }

  // Wajib ada bukti bayar untuk order online
  if (!req.file?.buffer || !req.file?.mimetype) {
    throwError('Bukti pembayaran (payment_proof) wajib', 400);
  }

  // Pastikan member (auto-register + mulai sesi device)
  const member = await ensureOnlineMember(req, res);

  // Ambil cart ONLINE (utamakan yang terikat member)
  const iden = getOnlineIdentity(req);
  let cart =
    (await Cart.findOne({
      status: 'active',
      source: 'online',
      member: member._id
    })) ||
    (iden.sessionId &&
      (await Cart.findOne({
        status: 'active',
        source: 'online',
        session_id: iden.sessionId
      })));

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

  // Pastikan cart terikat ke member
  if (!cart.member) {
    cart.member = member._id;
    cart.session_id = null;
  }

  // Upload bukti bayar ke Drive
  const folderId = getDriveFolder('invoice');
  const uploaded = await uploadBuffer(
    req.file.buffer,
    `online-payment-${Date.now()}`,
    req.file.mimetype,
    folderId
  );
  const payment_proof_url = `https://drive.google.com/uc?export=view&id=${uploaded.id}`;

  let delivery = undefined;
  let delivery_fee = 0;
  if (fulfillment_type === 'delivery') {
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

  // ======= Voucher pricing =======
  const priced = await validateAndPrice({
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

  // Buat ORDER (pakai daily sequence transaction_code)
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: cart.member,
          table_number: null,
          source: 'online',
          fulfillment_type,
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
          payment_method: 'qr',
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

  // konsumsi claim
  for (const claimId of priced.chosenClaimIds) {
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
  }

  // Tandai cart telah checkout & kosongkan
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

  // Update statistik member pakai GRAND TOTAL
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
    delivery: order.delivery || null
  };
  emitToStaff('order:new', payload);
  emitToMember(member._id, 'order:new', payload);

  res.status(201).json({
    order: {
      ...order.toObject(),
      transaction_code: order.transaction_code
    },
    message: 'Checkout berhasil'
  });
});
