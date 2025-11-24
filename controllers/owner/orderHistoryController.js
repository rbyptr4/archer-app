// controllers/orderHistoryController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Order = require('../../models/orderModel');
const OrderHistory = require('../../models/orderHistoryModel');
const Expense = require('../../models/expenseModel'); // sesuaikan path model Expenses kamu
const { parsePeriod } = require('../../utils/periodRange');
const throwError = require('../../utils/throwError');

/* ===================== Helpers umum ===================== */
const asInt = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const toBool = (v) => String(v) === 'true';

function buildCommonMatch(q = {}) {
  const match = {};

  if (q.source) match.source = q.source; // 'qr' | 'online' | 'pos'
  if (q.fulfillment_type) match.fulfillment_type = q.fulfillment_type; // 'dine_in'|'delivery'
  if (q.payment_status) match.payment_status = q.payment_status; // 'paid'|'refunded'|'void'|'unpaid'
  if (q.status) match.status = q.status;
  if (q.table) match.table_number = Number(q.table);

  // filter kasir / member
  if (q.cashier_id && mongoose.Types.ObjectId.isValid(q.cashier_id)) {
    match['verified_by.id'] = new mongoose.Types.ObjectId(String(q.cashier_id));
  }
  if (q.member_id && mongoose.Types.ObjectId.isValid(q.member_id)) {
    match['member.id'] = new mongoose.Types.ObjectId(String(q.member_id));
  }
  if (q.is_member === 'true') match['member.is_member'] = true;
  if (q.is_member === 'false') match['member.is_member'] = false;

  // refund/cancel flags cepat
  if (q.refund_only === 'true') match.is_refund = true;
  if (q.cancel_only === 'true') match.is_cancelled = true;

  return match;
}

/** Ambil {start,end} dari parsePeriod helper kamu */
function getRangeFromQuery(q = {}, fallbackMode = 'calendar') {
  const { start, end } = parsePeriod({
    period: q.mode || q.period || 'day',
    start: q.from,
    end: q.to,
    mode: q.range_mode || fallbackMode, // 'calendar' | 'rolling'
    weekStartsOn: Number.isFinite(+q.weekStartsOn) ? +q.weekStartsOn : 1
  });
  return { start, end };
}

exports.recordOrderHistory = asyncHandler(
  async (orderOrId, eventType, user = null, extra = {}) => {
    let orderDoc = null;
    if (!orderOrId) throwError('orderId required', 400);

    if (
      typeof orderOrId === 'string' ||
      orderOrId instanceof mongoose.Types.ObjectId
    ) {
      orderDoc = await OrderHistory.db
        .model('Order')
        .findById(orderOrId)
        .lean();
      if (!orderDoc) throwError('Order tidak ditemukan', 404);
    } else if (orderOrId && orderOrId._id) {
      orderDoc = orderOrId;
    } else {
      throwError('order parameter invalid', 400);
    }

    const entry = {
      type: eventType || 'generic',
      from: extra.from ?? null,
      to: extra.to ?? null,
      by: user
        ? {
            id: user._id || user.id,
            name: user.name || '',
            role: user.role || ''
          }
        : undefined,
      note: extra.note || undefined,
      at: extra.at || new Date(),
      // helpful metadata for fallback minimal docs
      transaction_code: extra.transaction_code || orderDoc.transaction_code,
      source: extra.source || orderDoc.source,
      fulfillment_type: extra.fulfillment_type || orderDoc.fulfillment_type,
      status: extra.status || orderDoc.status,
      payment_status: extra.payment_status || orderDoc.payment_status,
      placed_at: extra.placed_at || orderDoc.placed_at,
      paid_at: extra.paid_at || orderDoc.paid_at,
      items_subtotal: extra.items_subtotal ?? orderDoc.items_subtotal,
      grand_total: extra.grand_total ?? orderDoc.grand_total,
      total_quantity: extra.total_quantity ?? orderDoc.total_quantity,
      line_count:
        extra.line_count ??
        (Array.isArray(orderDoc.items) ? orderDoc.items.length : undefined)
    };

    // push to timeline (model will upsert minimal doc if none exists)
    await OrderHistory.createChangeEntry(orderDoc._id, entry);
  }
);

exports.snapshotOrder = asyncHandler(async (orderOrId, opts = {}) => {
  // resolve order doc if needed
  let orderDoc = null;
  if (!orderOrId) throwError('orderId required', 400);

  if (
    typeof orderOrId === 'string' ||
    orderOrId instanceof mongoose.Types.ObjectId
  ) {
    orderDoc = await OrderHistory.db.model('Order').findById(orderOrId);
    if (!orderDoc) throwError('Order tidak ditemukan', 404);
  } else if (orderOrId && (orderOrId._id || orderOrId._doc)) {
    // If it's a Mongoose doc or plain object, pass through (createFromOrder handles both)
    orderDoc = orderOrId;
  } else {
    throwError('order parameter invalid', 400);
  }

  await OrderHistory.createFromOrder(orderDoc, opts);
});

exports.listWithTimeline = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { start, end } = getRangeFromQuery(req.query);
  const match = buildCommonMatch(req.query);

  // gunakan paid_at untuk filter waktu (umumnya laporan penjualan)
  if (start && end) match.paid_at = { $gte: start, $lte: end };

  const docs = await OrderHistory.find(match)
    .sort({ paid_at: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  if (!docs.length) {
    return res.json({ count: 0, items: [] });
  }

  // mapping & format hasil agar FE tinggal render timeline
  const items = docs.map((d) => {
    const timeline = [];

    // 1️⃣ Buat event awal dari snapshot utama (created)
    if (d.placed_at) {
      timeline.push({
        label: 'Order dibuat',
        type: 'created',
        from: null,
        to: 'created',
        at: d.placed_at,
        by: d.verified_by ? d.verified_by.name : null
      });
    }

    // 2️⃣ Tambahkan event timeline (perubahan status)
    if (Array.isArray(d.timeline) && d.timeline.length) {
      d.timeline
        .filter((t) => t && t.type)
        .sort((a, b) => new Date(a.at) - new Date(b.at))
        .forEach((t) => {
          timeline.push({
            label:
              t.type === 'payment_status'
                ? `Pembayaran ${t.to}`
                : t.type === 'order_status'
                ? `Order ${t.to}`
                : t.type === 'delivery_status'
                ? `Delivery ${t.to}`
                : t.type,
            type: t.type,
            from: t.from || null,
            to: t.to || null,
            at: t.at || null,
            by: t.by ? t.by.name : null,
            note: t.note || ''
          });
        });
    }

    // 3️⃣ Tambahkan event selesai bila ada status completed
    if (d.status === 'completed' && d.completed_at) {
      timeline.push({
        label: 'Pesanan selesai',
        type: 'order_status',
        from: 'accepted',
        to: 'completed',
        at: d.completed_at,
        by: d.verified_by?.name || null
      });
    }

    // urutkan timeline terbaru di atas (FE bisa langsung render top-down)
    timeline.sort((a, b) => new Date(b.at) - new Date(a.at));

    return {
      id: d._id,
      transaction_code: d.transaction_code,
      member_name: d.member?.name || d.customer?.name || '',
      grand_total: d.grand_total || 0,
      status: d.status,
      payment_status: d.payment_status,
      fulfillment_type: d.fulfillment_type,
      source: d.source,
      paid_at: d.paid_at,
      placed_at: d.placed_at,
      timeline
    };
  });

  res.json({
    count: items.length,
    items
  });
});

exports.totalCancelledTransactions = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const match = buildCommonMatch(req.query);
  match.paid_at = { $gte: start, $lte: end };

  const [agg] = await OrderHistory.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        cancelled_count: { $sum: { $cond: ['$is_cancelled', 1, 0] } },
        refunded_count: {
          $sum: { $cond: [{ $eq: ['$payment_status', 'refunded'] }, 1, 0] }
        },
        total_refunded: {
          $sum: {
            $cond: [{ $eq: ['$payment_status', 'refunded'] }, '$grand_total', 0]
          }
        }
      }
    }
  ]);

  let list = undefined;
  if (String(req.query.include) === 'list') {
    const limit = Math.min(asInt(req.query.limit, 50), 200);
    list = await OrderHistory.find({
      ...match,
      $or: [{ is_cancelled: true }, { payment_status: 'refunded' }]
    })
      .sort({ paid_at: -1 })
      .limit(limit)
      .lean();
  }

  res.json({
    period: { start, end },
    cancelled_count: agg?.cancelled_count || 0,
    refunded_count: agg?.refunded_count || 0,
    total_refunded: agg?.total_refunded || 0,
    list
  });
});

exports.getHistoryDetail = asyncHandler(async (req, res) => {
  const doc = await OrderHistory.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'History tidak ditemukan' });
  res.json({ history: doc });
});

exports.deleteHistory = asyncHandler(async (req, res) => {
  const doc = await OrderHistory.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: 'History tidak ditemukan' });

  await OrderHistory.deleteOne({ _id: doc._id });
  res.json({ message: 'History dihapus' });
});

exports.summaryByPeriod = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const match = buildCommonMatch(req.query);

  match.paid_at = { $gte: start, $lte: end };

  const orderPipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        transaksiMasuk: {
          $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] }
        },
        transaksiSelesai: {
          $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
        },
        omzet: { $sum: { $ifNull: ['$grand_total', 0] } }
      }
    }
  ];

  const [ordersAgg] = await Order.aggregate(orderPipeline);

  const expenseMatch = { date: { $gte: start, $lte: end } };

  const expensePipeline = [
    { $match: expenseMatch },
    {
      $group: {
        _id: null,
        totalExpense: { $sum: { $ifNull: ['$amount', 0] } },
        count: { $sum: 1 }
      }
    }
  ];

  const [expenseAgg] = await Expense.aggregate(expensePipeline);

  // Ambil nilai fallback ke 0
  const omzet = (ordersAgg && Number(ordersAgg.omzet || 0)) || 0;
  const pengeluaran = (expenseAgg && Number(expenseAgg.totalExpense || 0)) || 0;
  const pendapatan = omzet - pengeluaran;

  const transaksi_masuk = (ordersAgg && ordersAgg.transaksiMasuk) || 0;
  const transaksi_selesai = (ordersAgg && ordersAgg.transaksiSelesai) || 0;

  res.json({
    period: { start, end },
    transaksi_masuk,
    transaksi_selesai,
    omzet,
    pendapatan,
    pengeluaran
  });
});

// ===================== 2) totalPaidTransactions (dari Order) =====================
exports.totalPaidTransactions = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const match = buildCommonMatch({ ...req.query, payment_status: 'paid' });

  // default window & if you want still filter status completed/verified by default? we respect query override;
  // but since metric is "paid transactions", we won't force status=completed here.
  match.paid_at = { $gte: start, $lte: end };

  const [agg] = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total_grand: { $sum: '$grand_total' },
        total_items_subtotal: { $sum: '$items_subtotal' }
      }
    }
  ]);

  let list;
  if (String(req.query.include) === 'list') {
    const limit = Math.min(asInt(req.query.limit, 50), 200);
    list = await Order.find(match).sort({ paid_at: -1 }).limit(limit).lean();
  }

  const count = agg?.count || 0;
  const totalGrand = agg?.total_grand || 0;
  res.json({
    period: { start, end },
    count,
    total_grand: totalGrand,
    total_items_subtotal: agg?.total_items_subtotal || 0,
    average_per_orders: count ? Math.round(totalGrand / count) : 0,
    list
  });
});

// ===================== 3) financeSales (dari Order) =====================
exports.financeSales = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const metric = ['omzet', 'pendapatan'].includes(String(req.query.metric))
    ? String(req.query.metric)
    : 'pendapatan';
  const groupBy = ['day', 'week', 'month', 'year', 'none'].includes(
    String(req.query.groupBy)
  )
    ? String(req.query.groupBy)
    : 'none';

  // default filter: completed + verified, kecuali user override
  const baseMatch = buildCommonMatch({ ...req.query });
  if (!req.query.status) baseMatch.status = 'created';
  if (!req.query.payment_status) baseMatch.payment_status = 'paid';
  baseMatch.paid_at = { $gte: start, $lte: end };

  const sumField = metric === 'omzet' ? '$items_subtotal' : '$grand_total';

  if (groupBy === 'none') {
    const [agg] = await Order.aggregate([
      { $match: baseMatch },
      { $group: { _id: null, total: { $sum: sumField } } }
    ]);
    return res.json({
      period: { start, end },
      metric,
      total: agg?.total || 0
    });
  }

  const keyField =
    groupBy === 'day'
      ? '$dayKey'
      : groupBy === 'week'
      ? '$weekKey'
      : groupBy === 'month'
      ? '$monthKey'
      : '$year';

  // ensure we have those keys on Order model? If not, compute via $dateToString on paid_at
  // We'll use $dateToString to be safe (no need dayKey in Order)
  const dateKeySpec =
    groupBy === 'day'
      ? { $dateToString: { date: '$paid_at', format: '%Y-%m-%d' } }
      : groupBy === 'week'
      ? { $dateToString: { date: '$paid_at', format: '%G-W%V' } }
      : groupBy === 'month'
      ? { $dateToString: { date: '$paid_at', format: '%Y-%m' } }
      : { $dateToString: { date: '$paid_at', format: '%Y' } };

  const items = await Order.aggregate([
    { $match: baseMatch },
    { $group: { _id: dateKeySpec, total: { $sum: sumField } } },
    { $sort: { _id: 1 } }
  ]);

  res.json({
    period: { start, end },
    metric,
    items: items.map((x) => ({ key: x._id, total: x.total })),
    total: items.reduce((s, x) => s + (x.total || 0), 0)
  });
});

// ===================== 4) financeExpenses (tidak berubah) =====================
exports.financeExpenses = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const groupBy = ['day', 'week', 'month', 'year', 'none'].includes(
    String(req.query.groupBy)
  )
    ? String(req.query.groupBy)
    : 'none';

  const match = {
    isDeleted: { $ne: true },
    date: { $gte: start, $lte: end }
  };
  if (req.query.type) match.type = String(req.query.type);

  if (groupBy === 'none') {
    const [agg] = await Expense.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    return res.json({
      period: { start, end },
      total: agg?.total || 0
    });
  }

  const keySpec =
    groupBy === 'day'
      ? { $dateToString: { date: '$date', format: '%Y-%m-%d' } }
      : groupBy === 'week'
      ? { $dateToString: { date: '$date', format: '%G-W%V' } }
      : groupBy === 'month'
      ? { $dateToString: { date: '$date', format: '%Y-%m' } }
      : { $dateToString: { date: '$date', format: '%Y' } };

  const items = await Expense.aggregate([
    { $match: match },
    { $group: { _id: keySpec, total: { $sum: '$amount' } } },
    { $sort: { _id: 1 } }
  ]);

  res.json({
    period: { start, end },
    items: items.map((x) => ({ key: x._id, total: x.total })),
    total: items.reduce((s, x) => s + (x.total || 0), 0)
  });
});

// ===================== 5) profitLoss (Order + Expense) =====================
exports.profitLoss = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const revenueMetric = ['pendapatan', 'omzet'].includes(
    String(req.query.revenue_metric)
  )
    ? String(req.query.revenue_metric)
    : 'pendapatan';

  // Revenue from Order model (default completed + verified)
  const revenueMatchBase = buildCommonMatch({ ...req.query });
  if (!req.query.status) revenueMatchBase.status = 'created';
  if (!req.query.payment_status) revenueMatchBase.payment_status = 'paid';
  revenueMatchBase.paid_at = { $gte: start, $lte: end };
  const revenueField =
    revenueMetric === 'omzet' ? '$items_subtotal' : '$grand_total';

  const [revAgg] = await Order.aggregate([
    { $match: revenueMatchBase },
    { $group: { _id: null, total: { $sum: revenueField } } }
  ]);
  const revenue = revAgg?.total || 0;

  // Expenses
  const expenseMatch = {
    isDeleted: { $ne: true },
    date: { $gte: start, $lte: end }
  };
  if (req.query.expense_type)
    expenseMatch.type = String(req.query.expense_type);

  const [expAgg] = await Expense.aggregate([
    { $match: expenseMatch },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const expenses = expAgg?.total || 0;

  const profit = revenue - expenses;

  const result = {
    period: { start, end },
    revenue_metric: revenueMetric,
    revenue,
    expenses,
    profit
  };

  if (toBool(req.query.detail)) {
    const expenseByType = await Expense.aggregate([
      { $match: expenseMatch },
      {
        $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } }
      },
      { $sort: { total: -1 } }
    ]);

    const revenueBreak = await Order.aggregate([
      { $match: revenueMatchBase },
      {
        $group: {
          _id: { source: '$source', fulfillment: '$fulfillment_type' },
          total: { $sum: revenueField },
          count: { $sum: 1 }
        }
      },
      { $sort: { total: -1 } }
    ]);

    result.detail = {
      expense_by_type: expenseByType.map((x) => ({
        type: x._id,
        total: x.total,
        count: x.count
      })),
      revenue_breakdown: revenueBreak.map((x) => ({
        source: x._id.source,
        fulfillment_type: x._id.fulfillment,
        total: x.total,
        count: x.count
      }))
    };
  }

  res.json(result);
});

// ===================== 6) bestSellers (dari Order.items) =====================
exports.bestSellers = asyncHandler(async (req, res) => {
  const metric = ['qty', 'revenue'].includes(String(req.query.metric))
    ? String(req.query.metric)
    : 'qty';
  const groupBy = ['menu', 'big_category', 'subcategory'].includes(
    String(req.query.groupBy)
  )
    ? String(req.query.groupBy)
    : 'menu';

  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const collapseVariants = String(req.query.collapse_variants) !== 'false'; // default true

  const { start, end } = getRangeFromQuery(req.query);
  const match = buildCommonMatch({ ...req.query });

  // default to only take completed+verified sales for best-sellers (overrideable)
  if (!req.query.status) match.status = 'created';
  if (!req.query.payment_status) match.payment_status = 'paid';
  match.paid_at = { $gte: start, $lte: end };

  // build group id like before but using Order.items fields
  let groupId;
  if (groupBy === 'big_category') {
    groupId = { big: '$items.category.big' };
  } else if (groupBy === 'subcategory') {
    groupId = {
      subId: '$items.category.subId',
      subName: '$items.category.subName',
      big: '$items.category.big'
    };
  } else {
    if (collapseVariants) {
      groupId = {
        menu: '$items.menu',
        name: '$items.name',
        code: '$items.menu_code',
        category_big: '$items.category.big',
        category_subId: '$items.category.subId',
        category_subName: '$items.category.subName'
      };
    } else {
      groupId = {
        menu: '$items.menu',
        name: '$items.name',
        code: '$items.menu_code',
        category_big: '$items.category.big',
        category_subId: '$items.category.subId',
        category_subName: '$items.category.subName',
        line_key: '$items.line_key',
        notes: '$items.notes',
        addons_sig: {
          $map: {
            input: { $ifNull: ['$items.addons', []] },
            as: 'a',
            in: {
              $concat: [
                '$$a.name',
                ':',
                { $toString: '$$a.price' },
                'x',
                { $toString: '$$a.qty' }
              ]
            }
          }
        }
      };
    }
  }

  const pipeline = [
    { $match: match },
    { $unwind: '$items' },
    {
      $group: {
        _id: groupId,
        qty: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.line_subtotal' },
        orders: { $addToSet: '$_id' },
        first_image: { $first: '$items.imageUrl' }
      }
    },
    { $addFields: { order_count: { $size: '$orders' } } },
    { $project: { orders: 0 } },
    {
      $sort:
        metric === 'revenue'
          ? { revenue: -1, qty: -1 }
          : { qty: -1, revenue: -1 }
    },
    { $limit: limit }
  ];

  const rows = await Order.aggregate(pipeline);

  // normalize output like sebelumnya
  const items = rows.map((r) => {
    if (groupBy === 'big_category') {
      return {
        key: r._id.big || 'Uncategorized',
        type: 'big_category',
        qty: r.qty || 0,
        revenue: r.revenue || 0,
        order_count: r.order_count || 0
      };
    }
    if (groupBy === 'subcategory') {
      return {
        key: String(r._id.subId || r._id.subName || 'unknown'),
        type: 'subcategory',
        subId: r._id.subId || null,
        subName: r._id.subName || '',
        big: r._id.big || null,
        qty: r.qty || 0,
        revenue: r.revenue || 0,
        order_count: r.order_count || 0
      };
    }
    const base = {
      key: String(r._id.menu || r._id.code || r._id.name),
      type: 'menu',
      menu_id: r._id.menu || null,
      code: r._id.code || '',
      name: r._id.name || '(no name)',
      category: {
        big: r._id.category_big || null,
        subId: r._id.category_subId || null,
        subName: r._id.category_subName || ''
      },
      imageUrl: r.first_image || '',
      qty: r.qty || 0,
      revenue: r.revenue || 0,
      order_count: r.order_count || 0
    };
    if (!collapseVariants) {
      base.variant =
        r._id.line_key ||
        [
          r._id.notes || '',
          ...(Array.isArray(r._id.addons_sig) ? r._id.addons_sig : [])
        ]
          .filter(Boolean)
          .join(' | ');
    }
    return base;
  });

  res.json({
    period: { start, end },
    metric,
    groupBy,
    collapse_variants: collapseVariants,
    limit,
    items,
    total_qty: items.reduce((s, x) => s + (x.qty || 0), 0),
    total_revenue: items.reduce((s, x) => s + (x.revenue || 0), 0)
  });
});
