// controllers/orderOpsController.js
const asyncHandler = require('express-async-handler');
const Order = require('../models/orderModel');
const throwError = require('../utils/throwError');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('./socket/socketBus');

/* ===== Consts & helpers ===== */
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
    pending: ['assigned'],
    assigned: ['picked_up'],
    picked_up: ['on_the_way'],
    on_the_way: ['delivered', 'failed'],
    delivered: [],
    failed: []
  };
  return (flow[from] || []).includes(to);
};

const emitAll = (event, payload, tableNumber) => {
  emitToMember(payload.member || payload.member_id, event, payload);
  emitToStaff(event, payload);
  if (tableNumber) emitToTable(tableNumber, event, payload);
};

/* ===================== Pembayaran ===================== */
/**
 * PATCH /orders/:id/pay
 * Body (opsional): { paid_at?: ISOString }
 * Hasil: set payment_status='paid', set paid_at/verified_by/verified_at, emit 'order:paid'
 */
exports.markPaid = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { paid_at } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  // idempotent: kalau sudah paid, balikin aja
  if (order.payment_status === 'paid') {
    return res.status(200).json(order.toObject());
  }

  order.payment_status = 'paid';
  order.paid_at = paid_at ? new Date(paid_at) : new Date();
  order.verified_by = req.user?.id || null;
  order.verified_at = new Date();
  await order.save();

  const payload = {
    id: String(order._id),
    member: String(order.member),
    table_number: order.table_number || null,
    payment_status: order.payment_status,
    paid_at: order.paid_at
  };
  emitAll('order:paid', payload, order.table_number);

  res.status(200).json(order.toObject());
});

/**
 * PATCH /orders/:id/payment
 * Body: { status: 'unpaid'|'refunded'|'void' }
 * Catatan: tidak untuk set 'paid' (pakai /pay).
 */
exports.updatePaymentStatus = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status } = req.body || {};
  const allowed = ['unpaid', 'refunded', 'void'];
  if (!allowed.includes(status)) throwError('payment_status tidak valid', 400);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  order.payment_status = status;
  if (status !== 'paid') {
    order.paid_at = null;
    order.verified_by = null;
    order.verified_at = null;
  }
  await order.save();

  const payload = {
    id: String(order._id),
    member: String(order.member),
    table_number: order.table_number || null,
    payment_status: order.payment_status,
    paid_at: order.paid_at || null
  };
  emitAll('order:paid', payload, order.table_number);

  res.status(200).json(order.toObject());
});

/* ===================== Delivery Ops ===================== */
/**
 * PATCH /orders/:id/delivery/assign
 * Body: { userId?: string, name?: string }
 * Guard: fulfillment_type='delivery' & payment_status='paid'
 */
exports.assignCourier = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { userId, name } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);

  if (order.fulfillment_type !== 'delivery') {
    throwError('Bukan order delivery', 400);
  }
  if (!order.canAssignCourier()) {
    throwError('Tidak bisa assign sebelum paid', 409);
  }

  order.delivery.assignee = { user: userId || null, name: name || '' };
  order.delivery.status = 'assigned';
  order.delivery.timestamps = {
    ...(order.delivery.timestamps || {}),
    assigned_at: new Date()
  };
  await order.save();

  const payload = {
    id: String(order._id),
    member: String(order.member),
    table_number: order.table_number || null,
    delivery_status: order.delivery.status,
    assignee: order.delivery.assignee || null,
    at: new Date()
  };
  emitToMember(order.member, 'delivery:assigned', payload);
  emitToStaff('delivery:assigned', payload);

  res.status(200).json(order.toObject());
});

/**
 * PATCH /orders/:id/delivery/status
 * Body: { status: 'assigned'|'picked_up'|'on_the_way'|'delivered'|'failed' }
 * Guard:
 *  - Transisi harus valid.
 *  - 'assigned' & 'picked_up' & 'on_the_way' awal → wajib paid.
 */
exports.updateDeliveryStatus = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status } = req.body || {};
  if (!DELIVERY_ALLOWED.includes(status))
    throwError('Delivery status tidak valid', 400);

  const order = await Order.findById(req.params.id);
  if (!order) throwError('Order tidak ditemukan', 404);
  if (order.fulfillment_type !== 'delivery')
    throwError('Bukan order delivery', 400);

  const from = order.delivery?.status || 'pending';
  if (from === status) return res.status(200).json(order.toObject());
  if (!canTransitDelivery(from, status)) {
    throwError(
      `Transisi delivery dari "${from}" ke "${status}" tidak diizinkan`,
      400
    );
  }

  // butuh paid untuk tahap-tahap awal pengantaran
  if (
    ['assigned', 'picked_up', 'on_the_way'].includes(status) &&
    order.payment_status !== 'paid'
  ) {
    throwError('Tidak boleh ubah status delivery sebelum paid', 409);
  }

  // set status + timestamps
  order.delivery.status = status;
  order.delivery.timestamps = order.delivery.timestamps || {};
  const now = new Date();
  if (status === 'picked_up') order.delivery.timestamps.picked_up_at = now;
  if (status === 'delivered') order.delivery.timestamps.delivered_at = now;
  if (status === 'failed') order.delivery.timestamps.failed_at = now;

  await order.save();

  const payload = {
    id: String(order._id),
    member: String(order.member),
    table_number: order.table_number || null,
    from_delivery_status: from,
    delivery_status: order.delivery.status,
    at: now
  };
  emitToMember(order.member, 'delivery:status', payload);
  emitToStaff('delivery:status', payload);

  res.status(200).json(order.toObject());
});

/**
 * GET /orders/delivery-board?status[]=assigned&status[]=on_the_way&limit=50&cursor=ISO
 * List papan delivery untuk staff
 */
exports.listDeliveryBoard = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { status, limit = 50, cursor } = req.query || {};
  const q = { fulfillment_type: 'delivery' };

  if (status) {
    const arr = Array.isArray(status) ? status : [status];
    const allowed = arr.filter((s) => DELIVERY_ALLOWED.includes(s));
    if (allowed.length) q['delivery.status'] = { $in: allowed };
  }

  if (cursor) q.createdAt = { $lt: new Date(cursor) };

  const items = await Order.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 50, 200))
    .lean();

  res.status(200).json({
    items,
    next_cursor: items.length ? items[items.length - 1].createdAt : null
  });
});
