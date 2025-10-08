// controllers/orderController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { awardPointsIfEligible } = require('../utils/loyalty');

const Order = require('../models/orderModel');
const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const Member = require('../models/memberModel');
const MemberSession = require('../models/memberSessionModel');

const VoucherClaim = require('../models/voucherClaimModel');
const { validateAndPrice } = require('../utils/voucherEngine');

const { nextDailyTxCode } = require('../utils/txCode');
const throwError = require('../utils/throwError');
const { baseCookie } = require('../utils/authCookies');
const { uploadBuffer } = require('../utils/googleDrive');
const { getDriveFolder } = require('../utils/driveFolders');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('./socket/socketBus');

const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  REFRESH_TTL_MS,
  signAccessToken,
  generateOpaqueToken,
  hashToken
} = require('../utils/memberToken');

/* =============== Cookie presets (member session) =============== */
const cookieAccess = { ...baseCookie, httpOnly: true, maxAge: 15 * 60 * 1000 };
const cookieRefresh = { ...baseCookie, httpOnly: true, maxAge: REFRESH_TTL_MS };
const cookieDevice = { ...baseCookie, httpOnly: false, maxAge: REFRESH_TTL_MS };

/* ================== Konstanta & Helper ================== */
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

// ===== utils cart =====
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

const computeLineSubtotal = (basePrice, addons, qty) => {
  const addonsTotal = normalizeAddons(addons).reduce(
    (sum, a) => sum + a.price * a.qty,
    0
  );
  const unit = asInt(basePrice, 0) + addonsTotal;
  return unit * clamp(asInt(qty, 1), 1, 999);
};

const recomputeTotals = (cart) => {
  let totalQty = 0;
  let totalPrice = 0;
  for (const it of cart.items) {
    totalQty += it.quantity;
    totalPrice += it.line_subtotal;
  }
  cart.total_items = cart.items.length;
  cart.total_quantity = totalQty;
  cart.total_price = totalPrice;
  return cart;
};

// identity untuk QR (butuh table)
const getIdentity = (req) => {
  const memberId = req.member?.id || null;
  const sessionId = req.headers['x-qr-session'] || req.body?.session_id || null;
  const tableNumber = asInt(req.query.table ?? req.body?.table_number, 0);
  if (!tableNumber) throwError('table_number wajib diisi', 400);
  if (!memberId && !sessionId)
    throwError('Butuh member login atau X-QR-Session', 401);
  return { memberId, sessionId, tableNumber };
};

const findOrCreateActiveCart = async ({ memberId, sessionId, tableNumber }) => {
  const filter = {
    status: 'active',
    table_number: tableNumber,
    ...(memberId ? { member: memberId } : { session_id: sessionId })
  };
  let cart = await Cart.findOne(filter).lean();
  if (cart) return cart;
  const created = await Cart.create({
    member: memberId || null,
    session_id: memberId ? null : sessionId,
    table_number: tableNumber,
    items: [],
    total_items: 0,
    total_quantity: 0,
    total_price: 0,
    status: 'active',
    source: 'qr'
  });
  return created.toObject();
};

// ensure member (auto-register + start session saat checkout QR)
const ensureMemberForCheckout = async (req, res) => {
  if (req.member?.id) {
    const m = await Member.findById(req.member.id).lean();
    if (!m) throwError('Member tidak ditemukan', 404);
    return m;
  }
  const { name, phone } = req.body || {};
  if (!name || !phone)
    throwError(
      'Checkout membutuhkan akun member. Sertakan name & phone untuk daftar otomatis.',
      401
    );

  const normalizedPhone = normalizePhone(phone);
  let member = await Member.findOne({
    phone: normalizedPhone,
    name: new RegExp(`^${name}$`, 'i')
  });
  if (!member) {
    member = await Member.create({
      name,
      phone: normalizedPhone,
      join_channel: 'self_order',
      visit_count: 1,
      last_visit_at: new Date(),
      is_active: true
    });
  } else {
    member.visit_count += 1;
    member.last_visit_at = new Date();
    if (!member.is_active) member.is_active = true;
    await member.save();
  }

  // start session (device-bound)
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

/* ================== MEMBER ================== */
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

/* ================== STAFF / OWNER ================== */
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

/* ================== PREVIEW HARGA (voucher) ================== */
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

/* ================== STATUS & CANCEL ================== */
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

  if (isKitchenStatus(status) && !order.canMoveToKitchen()) {
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
      // kebijakan voucher saat cancel+paid ditangani di orderOps (updatePaymentStatus) juga
    } else if (order.payment_status === 'unpaid') {
      order.payment_status = 'void';
    }
  }
  await order.save();
  if (order.payment_status === 'paid' && !order.loyalty_awarded_at) {
    await awardPointsIfEligible(order, Member);
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

/* ================== CART QR (wajib meja) ================== */
exports.getCart = asyncHandler(async (req, res) => {
  const iden = getIdentity(req);
  const cart = await findOrCreateActiveCart(iden);
  res.status(200).json(cart);
});

exports.addItem = asyncHandler(async (req, res) => {
  const { menu_id, quantity = 1, addons = [], notes = '' } = req.body || {};
  if (!menu_id) throwError('menu_id wajib diisi', 400);
  const iden = getIdentity(req);

  const menu = await Menu.findById(menu_id).lean();
  if (!menu || !menu.isActive)
    throwError('Menu tidak ditemukan / tidak aktif', 404);

  const qty = clamp(asInt(quantity, 1), 1, 999);
  const normAddons = normalizeAddons(addons);
  const line_key = makeLineKey({ menuId: menu._id, addons: normAddons, notes });
  const line_subtotal = computeLineSubtotal(menu.price, normAddons, qty);

  const filter = {
    status: 'active',
    table_number: iden.tableNumber,
    ...(iden.memberId
      ? { member: iden.memberId }
      : { session_id: iden.sessionId })
  };
  let cart = await Cart.findOne(filter);
  if (!cart) {
    cart = await Cart.create({
      member: iden.memberId || null,
      session_id: iden.memberId ? null : iden.sessionId,
      table_number: iden.tableNumber,
      items: [],
      status: 'active',
      source: 'qr'
    });
  }

  const idx = cart.items.findIndex((it) => it.line_key === line_key);
  if (idx >= 0) {
    const newQty = clamp(cart.items[idx].quantity + qty, 1, 999);
    cart.items[idx].quantity = newQty;
    cart.items[idx].line_subtotal = computeLineSubtotal(
      cart.items[idx].base_price,
      cart.items[idx].addons,
      newQty
    );
  } else {
    cart.items.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: menu.price,
      quantity: qty,
      addons: normAddons,
      notes: String(notes || '').trim(),
      line_key,
      line_subtotal
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
    table_number: iden.tableNumber,
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
    cart.items[idx].line_subtotal = computeLineSubtotal(
      cart.items[idx].base_price,
      cart.items[idx].addons,
      cart.items[idx].quantity
    );
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
    table_number: iden.tableNumber,
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
  const iden = getIdentity(req);
  const filter = {
    status: 'active',
    table_number: iden.tableNumber,
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

// POST /cart/checkout (QR dine-in). Body: { idempotency_key?, payment_method?, voucherClaimIds? [], ... }
// file payment_proof opsional (multer -> req.file)
exports.checkout = asyncHandler(async (req, res) => {
  const {
    idempotency_key,
    payment_method = 'manual',
    voucherClaimIds = []
  } = req.body || {};
  const tableNumber = asInt(req.query.table ?? req.body?.table_number, 0);
  if (!tableNumber) throwError('table_number wajib diisi', 400);

  const member = await ensureMemberForCheckout(req, res);
  const sessionId = req.headers['x-qr-session'] || req.body?.session_id || null;

  let cart =
    (sessionId &&
      (await Cart.findOne({
        status: 'active',
        session_id: sessionId,
        table_number: tableNumber
      }))) ||
    (await Cart.findOne({
      status: 'active',
      member: member._id,
      table_number: tableNumber
    }));

  if (!cart) throwError('Cart tidak ditemukan / kosong', 404);
  if (!cart.items?.length) throwError('Cart kosong', 400);

  // Idempotency sederhana
  if (
    idempotency_key &&
    cart.last_idempotency_key === idempotency_key &&
    cart.order_id
  ) {
    return res.status(200).json({
      cart: cart.toObject ? cart.toObject() : cart,
      order: { _id: cart.order_id },
      message: 'Checkout sudah diproses sebelumnya'
    });
  }

  if (!cart.member) {
    cart.member = member._id;
    cart.session_id = null;
  }
  // recompute
  for (const it of cart.items) {
    const addonsTotal = (it.addons || []).reduce(
      (s, a) => s + (a.price || 0) * (a.qty || 1),
      0
    );
    it.line_subtotal = (it.base_price + addonsTotal) * it.quantity;
  }
  recomputeTotals(cart);
  await cart.save();

  // Upload bukti bayar (opsional)
  let payment_proof_url = '';
  if (req.file?.buffer && req.file?.mimetype) {
    const folderId = getDriveFolder('invoice');
    const uploaded = await uploadBuffer(
      req.file.buffer,
      `invoice-${Date.now()}`,
      req.file.mimetype,
      folderId
    );
    payment_proof_url = `https://drive.google.com/uc?export=view&id=${uploaded.id}`;
  }

  // ==== Voucher pricing (delivery=0 untuk dine-in) ====
  const priced = await validateAndPrice({
    memberId: member._id,
    cart: {
      items: cart.items.map((it) => ({
        menuId: it.menu,
        qty: it.quantity,
        price: it.base_price,
        category: it.category
      }))
    },
    deliveryFee: 0,
    voucherClaimIds
  });

  // buat ORDER (pakai tx code & simpan breakdown)
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: cart.member,
          table_number: cart.table_number,
          source: 'qr',
          fulfillment_type: 'dine_in',
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
            line_subtotal: it.line_subtotal
          })),
          total_quantity: cart.total_quantity,
          items_subtotal: priced.totals.baseSubtotal,
          items_discount: priced.totals.itemsDiscount,
          delivery_fee: 0,
          shipping_discount: priced.totals.shippingDiscount,
          discounts: priced.breakdown,
          grand_total: priced.totals.grandTotal,
          payment_method,
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

  if (order.payment_status === 'paid') {
    await awardPointsIfEligible(order, Member);
  }

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

  // Tandai cart sudah checkout
  const upd = await Cart.findOneAndUpdate(
    { _id: cart._id, status: 'active' },
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
  ).lean();

  if (!upd) {
    return res.status(409).json({
      message: 'Cart sudah tidak aktif (mungkin telah di-checkout paralel).'
    });
  }

  // Update statistik member (pakai GRAND TOTAL)
  await Member.findByIdAndUpdate(member._id, {
    $inc: { total_spend: order.grand_total || 0 },
    $set: { last_visit_at: new Date() }
  });

  // Emit
  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    table_number: order.table_number,
    member: { id: String(member._id), name: member.name, phone: member.phone },
    items_total: order.items_subtotal,
    grand_total: order.grand_total,
    total_quantity: order.total_quantity,
    status: order.status,
    payment_status: order.payment_status,
    placed_at: order.placed_at,
    payment_proof_url: order.payment_proof_url || ''
  };
  emitToStaff('order:new', payload);
  emitToMember(member._id, 'order:new', payload);
  if (order.table_number) emitToTable(order.table_number, 'order:new', payload);

  res.status(201).json({
    order: {
      _id: order._id,
      transaction_code: order.transaction_code,
      table_number: order.table_number,
      items_subtotal: order.items_subtotal,
      grand_total: order.grand_total,
      total_quantity: order.total_quantity,
      discounts: order.discounts,
      status: order.status,
      payment_status: order.payment_status,
      placed_at: order.placed_at,
      payment_proof_url: order.payment_proof_url || ''
    },
    message: 'Checkout berhasil'
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
      const normalizedPhone = String(phone)
        .replace(/\s+/g, '')
        .replace(/^(\+62|62|0)/, '0');
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
    // TANPA MEMBER (guest) — simpan snapshot agar histori tetap ada
    customer_name = String(name || '').trim();
    customer_phone = String(phone || '').trim();
    if (!customer_name && !customer_phone) {
      // longgar: minimal salah satu diisi supaya ada jejak
      throwError(
        'Tanpa member: isi minimal customer_name atau customer_phone',
        400
      );
    }
  }

  // ====== Build items & totals ======
  const orderItems = [];
  let totalQty = 0;
  let itemsSubtotal = 0;

  for (const it of items) {
    const menu = await Menu.findById(it.menu_id).lean();
    if (!menu || !menu.isActive)
      throwError('Menu tidak ditemukan / tidak aktif', 404);
    const qty = clamp(asInt(it.quantity, 1), 1, 999);
    const normAddons = normalizeAddons(it.addons);

    const line_subtotal = computeLineSubtotal(menu.price, normAddons, qty);
    orderItems.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: menu.price,
      quantity: qty,
      addons: normAddons,
      notes: String(it.notes || '').trim(),
      line_subtotal
    });
    totalQty += qty;
    itemsSubtotal += line_subtotal;
  }

  const now = new Date();

  // ====== Create order ======
  const order = await (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const code = await nextDailyTxCode('ARCH');
        return await Order.create({
          member: member ? member._id : null,
          customer_name, // <— NEW
          customer_phone, // <— NEW
          table_number: tableNo,
          source: 'pos',
          fulfillment_type: 'dine_in',
          transaction_code: code,
          items: orderItems,
          total_quantity: totalQty,

          // sinkron dengan model & voucher engine (POS tanpa voucher)
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
  }
  // Emit payload (tetap ada, aman meski member null)
  const payload = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    member: member
      ? { id: String(member._id), name: member.name, phone: member.phone }
      : null,
    customer: !member ? { name: customer_name, phone: customer_phone } : null, // <— Info guest ke FE kalau perlu
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
