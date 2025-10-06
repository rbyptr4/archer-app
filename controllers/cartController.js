const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
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

// ===== utils =====
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

// identity
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

// ensure member
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

// ========== CONTROLLERS ==========
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

// POST /cart/checkout  (supports optional payment_proof file)
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

  // optional: payment proof upload (multer -> req.file)
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

  const Order = mongoose.model('Order');
  const orderDoc = await Order.create({
    member: cart.member,
    table_number: cart.table_number,
    source: 'qr',
    fulfillment_type: 'dine_in',
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
    total_price: cart.total_price,
    payment_method,
    payment_proof_url,
    status: 'created',
    payment_status: 'unpaid',
    placed_at: new Date()
  });

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

  if (!upd)
    return res.status(409).json({
      message: 'Cart sudah tidak aktif (mungkin telah di-checkout paralel).'
    });

  await Member.findByIdAndUpdate(member._id, {
    $inc: { total_spend: orderDoc.total_price || 0 },
    $set: { last_visit_at: new Date() }
  });

  // emits
  const payload = {
    id: String(orderDoc._id),
    table_number: orderDoc.table_number,
    member: { id: String(member._id), name: member.name, phone: member.phone },
    total_price: orderDoc.total_price,
    total_quantity: orderDoc.total_quantity,
    status: orderDoc.status,
    payment_status: orderDoc.payment_status,
    placed_at: orderDoc.placed_at,
    payment_proof_url: orderDoc.payment_proof_url || ''
  };
  emitToStaff('order:new', payload);
  emitToMember(member._id, 'order:new', payload);
  emitToTable(orderDoc.table_number, 'order:new', payload);

  res.status(201).json({
    order: {
      _id: orderDoc._id,
      table_number: orderDoc.table_number,
      total_price: orderDoc.total_price,
      status: orderDoc.status,
      payment_status: orderDoc.payment_status,
      placed_at: orderDoc.placed_at,
      payment_proof_url: orderDoc.payment_proof_url || ''
    },
    message: 'Checkout berhasil'
  });
});
