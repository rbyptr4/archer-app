// controllers/orderController.js
const asyncHandler = require('express-async-handler');
const Order = require('../models/orderModel');
const Cart = require('../models/cartModel');
const Menu = require('../models/menuModel');
const Member = require('../models/memberModel');
const throwError = require('../utils/throwError');
const generateMemberToken = require('../utils/generateMemberToken');
const { baseCookie } = require('../utils/authCookies');
const { uploadBuffer } = require('../utils/googleDrive');
const { getDriveFolder } = require('../utils/driveFolders');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('./socket/socketBus');

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
const DELIVERY_ALLOWED = [
  'pending',
  'assigned',
  'picked_up',
  'on_the_way',
  'delivered',
  'failed'
];

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

const canTransitDelivery = (from, to) => {
  const flow = {
    pending: ['assigned'],
    assigned: ['picked_up'],
    picked_up: ['on_the_way'],
    on_the_way: ['delivered', 'failed'],
    delivered: [],
    failed: []
  };
  return (flow[from] || []).includes(to);
};

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

// ensure member (auto-register saat checkout QR)
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

  const memberToken = generateMemberToken(member);
  res.cookie('memberToken', memberToken, {
    ...baseCookie,
    httpOnly: true,
    maxAge: 60 * 60 * 1000
  });
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

  // Guard: paid dulu untuk masuk kitchen
  if (isKitchenStatus(status) && !order.canMoveToKitchen()) {
    throwError('Order belum paid. Tidak bisa masuk accepted/preparing.', 409);
  }

  // Guard: delivery completed hanya bila sudah delivered
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
    // aturan ringan
    if (order.payment_status === 'paid') {
      order.payment_status = 'refunded';
    } else if (order.payment_status === 'unpaid') {
      order.payment_status = 'void';
    }
  }
  await order.save();

  const payload = {
    id: String(order._id),
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

/* ================== CART QR (tanpa meja? → di QR wajib meja) ================== */
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

// POST /cart/checkout (QR dine-in). Bisa kirim file payment_proof (opsional).
exports.checkout = asyncHandler(async (req, res) => {
  const { idempotency_key, payment_method = 'manual' } = req.body || {};
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

  // BUAT ORDER — match schema baru
  const orderDoc = await Order.create({
    member: cart.member,
    table_number: cart.table_number,
    source: 'qr',
    fulfillment_type: 'dine_in', // Wajib sesuai schema
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
    total_quantity: cart.total_quantity, // schema juga akan validasi/overwrite di pre('validate')
    payment_method, // default 'manual' utk QR dine-in
    payment_proof_url, // boleh kosong utk QR (schema enforce wajibnya hanya utk 'online')
    status: 'created',
    payment_status: 'unpaid',
    placed_at: new Date()
  });

  // Tandai cart sudah checkout
  const upd = await Cart.findOneAndUpdate(
    { _id: cart._id, status: 'active' },
    {
      $set: {
        status: 'checked_out',
        checked_out_at: new Date(),
        order_id: orderDoc._id,
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
    $inc: { total_spend: orderDoc.grand_total || 0 },
    $set: { last_visit_at: new Date() }
  });

  // Emit
  const payload = {
    id: String(orderDoc._id),
    table_number: orderDoc.table_number,
    member: { id: String(member._id), name: member.name, phone: member.phone },
    items_total: orderDoc.items_total,
    grand_total: orderDoc.grand_total,
    total_quantity: orderDoc.total_quantity,
    status: orderDoc.status,
    payment_status: orderDoc.payment_status,
    placed_at: orderDoc.placed_at,
    payment_proof_url: orderDoc.payment_proof_url || ''
  };
  emitToStaff('order:new', payload);
  emitToMember(member._id, 'order:new', payload);
  if (orderDoc.table_number)
    emitToTable(orderDoc.table_number, 'order:new', payload);

  res.status(201).json({
    order: {
      _id: orderDoc._id,
      table_number: orderDoc.table_number,
      items_total: orderDoc.items_total,
      grand_total: orderDoc.grand_total,
      total_quantity: orderDoc.total_quantity,
      status: orderDoc.status,
      payment_status: orderDoc.payment_status,
      placed_at: orderDoc.placed_at,
      payment_proof_url: orderDoc.payment_proof_url || ''
    },
    message: 'Checkout berhasil'
  });
});

exports.createPosDineIn = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const {
    table_number,
    items,
    member_id,
    name,
    phone,
    mark_paid = false,
    payment_method = 'cash'
  } = req.body || {};

  const tableNo = asInt(table_number, 0);
  if (!tableNo) throwError('table_number wajib', 400);
  if (!Array.isArray(items) || !items.length) throwError('items wajib', 400);

  // Resolve member (opsional)
  let member = null;
  if (member_id) {
    member = await Member.findById(member_id).lean();
    if (!member) throwError('Member tidak ditemukan', 404);
  } else if (name && phone) {
    // Cari-by phone, kalau tak ada → buat, tapi TIDAK set cookie (ini POS)
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

  // Bangun line items dari master Menu
  const orderItems = [];
  let totalQty = 0;
  for (const it of items) {
    const menu = await Menu.findById(it.menu_id).lean();
    if (!menu || !menu.isActive)
      throwError('Menu tidak ditemukan / tidak aktif', 404);
    const qty = clamp(asInt(it.quantity, 1), 1, 999);
    const normAddons = normalizeAddons(it.addons);

    orderItems.push({
      menu: menu._id,
      menu_code: menu.menu_code || '',
      name: menu.name,
      imageUrl: menu.imageUrl || '',
      base_price: menu.price,
      quantity: qty,
      addons: normAddons,
      notes: String(it.notes || '').trim(),
      line_subtotal: computeLineSubtotal(menu.price, normAddons, qty)
    });
    totalQty += qty;
  }

  // Buat ORDER (source 'pos' + dine_in + meja)
  const now = new Date();
  const order = await Order.create({
    member: member ? member._id : null,
    table_number: tableNo,
    source: 'pos',
    fulfillment_type: 'dine_in',
    items: orderItems,
    total_quantity: totalQty, // schema kamu juga re-validate & hitung items_total/grand_total
    payment_method,
    payment_status: mark_paid ? 'paid' : 'unpaid',
    paid_at: mark_paid ? now : null,
    verified_by: mark_paid ? req.user?.id || null : null,
    verified_at: mark_paid ? now : null,
    status: 'created',
    placed_at: now
  });

  // Emit realtime
  const payload = {
    id: String(order._id),
    member: member
      ? { id: String(member._id), name: member.name, phone: member.phone }
      : null,
    table_number: order.table_number,
    items_total: order.items_total,
    grand_total: order.grand_total,
    total_quantity: order.total_quantity,
    source: order.source,
    fulfillment_type: order.fulfillment_type,
    status: order.status,
    payment_status: order.payment_status,
    placed_at: order.placed_at
  };
  emitToStaff('order:new', payload);
  if (order.table_number) emitToTable(order.table_number, 'order:new', payload);
  if (member) emitToMember(member._id, 'order:new', payload);

  res.status(201).json({ order, message: 'Order POS dine-in dibuat' });
});
