const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Order = require('../../models/orderModel');
const OrderHistory = require('../../models/orderHistoryModel');
const Expense = require('../../models/expenseModel'); // sesuaikan path model Expenses kamu
const throwError = require('../../utils/throwError');
const { parseRange } = require('../../utils/periodRange');

/* ===================== Helpers umum ===================== */
const asInt = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const toBool = (v) => String(v) === 'true';

function getRangeFromQuery(q = {}) {
  const rangeKey = q.range || q.period || 'today';
  const weekStartsOn = Number.isFinite(+q.weekStartsOn) ? +q.weekStartsOn : 1;
  const { start, end } = parseRange({
    range: rangeKey,
    from: q.from,
    to: q.to,
    weekStartsOn
  });
  return { start, end };
}

exports.summaryByPeriod = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const orderMatch = { paid_at: { $gte: start, $lte: end } };

  const orderPipeline = [
    { $match: orderMatch },
    {
      $group: {
        _id: null,
        transaksiMasuk: { $sum: 1 },
        omzet: { $sum: { $ifNull: ['$grand_total', 0] } }
      }
    }
  ];

  const [ordersAgg] = await Order.aggregate(orderPipeline);

  const expenseMatch = {
    date: { $gte: start, $lte: end },
    isDeleted: { $ne: true }
  };
  const expensePipeline = [
    { $match: expenseMatch },
    {
      $group: { _id: null, totalExpense: { $sum: { $ifNull: ['$amount', 0] } } }
    }
  ];
  const [expenseAgg] = await Expense.aggregate(expensePipeline);

  const omzet = Number(ordersAgg?.omzet || 0);
  const pengeluaran = Number(expenseAgg?.totalExpense || 0);
  const pendapatan = omzet - pengeluaran;

  res.json({
    period: { start, end },
    transaksi_masuk: ordersAgg?.transaksiMasuk || 0,
    omzet,
    pendapatan,
    pengeluaran
  });
});

exports.totalPaidTransactions = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  // params cursor & limit
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  // match untuk aggregate & list (hanya completed & paid_at in range)
  const match = {
    status: 'completed',
    paid_at: { $gte: start, $lte: end }
  };

  // 1) Aggregate: total count & total grand
  const [agg] = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total_grand: { $sum: { $ifNull: ['$grand_total', 0] } }
      }
    }
  ]);

  const count = agg?.count || 0;
  const totalGrand = agg?.total_grand || 0;
  const averagePerOrder = count ? Math.round(totalGrand / count) : 0;

  // 2) Fetch list (paginated via cursor)
  // Build query object for mongoose find
  const findQuery = { ...match };

  // cursor logic: because we sort by createdAt desc, use _id < cursor for "next page"
  if (cursor) {
    // validate cursor
    if (!mongoose.Types.ObjectId.isValid(cursor)) {
      // return bad request
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    // When sorting DESC, to get items after the cursor we want _id < cursor
    findQuery._id = { $lt: mongoose.Types.ObjectId(cursor) };
  }

  // select only required fields + member ref
  const rows = await Order.find(findQuery)
    .select(
      'member customer_name customer_phone grand_total transaction_code createdAt'
    )
    .populate('member', 'name phone') // kalau member ada, ambil name & phone
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1) // ambil satu ekstra untuk cek nextCursor
    .lean();

  // determine nextCursor
  let nextCursor = null;
  let resultRows = rows;
  if (rows.length > limit) {
    const extra = rows.pop(); // remove extra
    nextCursor = extra._id.toString();
    resultRows = rows;
  } else if (rows.length > 0) {
    // kalau tidak ada extra, nextCursor tetap null
    nextCursor = null;
  }

  // map rows -> shape minimal (name, phone, grand_total, transaction_code, created_at)
  const orders = resultRows.map((r) => {
    const member = r.member;
    const name = member?.name || r.customer_name || '';
    const phone = member?.phone || r.customer_phone || '';
    return {
      name,
      phone,
      grand_total: r.grand_total || 0,
      transaction_code: r.transaction_code || r.transaction_code || '',
      created_at: r.createdAt || r.created_at || null,
      _id: r._id // optional, FE bisa pakai ini sebagai cursor fallback
    };
  });

  // respond (period, aggregates, pagination)
  res.json({
    period: { start, end },
    total_transactions: count,
    total_grand: totalGrand,
    average_per_order: averagePerOrder,
    limit,
    nextCursor, // null jika tidak ada halaman selanjutnya
    orders
  });
});

exports.financeSales = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  // HANYA filter waktu (paid_at)
  const match = { paid_at: { $gte: start, $lte: end } };

  const [agg] = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total_omzet: { $sum: { $ifNull: ['$grand_total', 0] } }
      }
    }
  ]);

  res.json({
    period: { start, end },
    total: agg?.total_omzet || 0
  });
});

exports.financeExpenses = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const match = { isDeleted: { $ne: true }, date: { $gte: start, $lte: end } };

  const [agg] = await Expense.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$amount', 0] } } } }
  ]);

  res.json({
    period: { start, end },
    total: agg?.total || 0
  });
});

/* ===================== profitLoss (sederhana) ===================== */
exports.profitLoss = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const revenueMatch = { paid_at: { $gte: start, $lte: end } };
  const [revAgg] = await Order.aggregate([
    { $match: revenueMatch },
    {
      $group: { _id: null, revenue: { $sum: { $ifNull: ['$grand_total', 0] } } }
    }
  ]);
  const revenue = revAgg?.revenue || 0;

  const expenseMatch = {
    isDeleted: { $ne: true },
    date: { $gte: start, $lte: end }
  };
  const [expAgg] = await Expense.aggregate([
    { $match: expenseMatch },
    { $group: { _id: null, expenses: { $sum: { $ifNull: ['$amount', 0] } } } }
  ]);
  const expenses = expAgg?.expenses || 0;

  res.json({
    period: { start, end },
    revenue,
    expenses,
    profit: revenue - expenses
  });
});

/* ===================== bestSellers (sederhana, hanya periode) ===================== */
exports.bestSellers = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const limit = Math.min(Number(req.query.limit) || 10, 100);

  // filter hanya by paid_at range
  const pipeline = [
    { $match: { paid_at: { $gte: start, $lte: end } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: {
          menu: '$items.menu',
          name: '$items.name',
          code: '$items.menu_code'
        },
        qty: { $sum: '$items.quantity' },
        revenue: { $sum: { $ifNull: ['$items.line_subtotal', 0] } },
        sample_image: { $first: '$items.imageUrl' }
      }
    },
    { $sort: { qty: -1, revenue: -1 } },
    { $limit: limit }
  ];

  const rows = await Order.aggregate(pipeline);

  const items = rows.map((r) => ({
    menu_id: r._id.menu || null,
    code: r._id.code || '',
    name: r._id.name || '(no name)',
    qty: r.qty || 0,
    revenue: r.revenue || 0,
    imageUrl: r.sample_image || ''
  }));

  res.json({
    period: { start, end },
    limit,
    items,
    total_qty: items.reduce((s, x) => s + (x.qty || 0), 0),
    total_revenue: items.reduce((s, x) => s + (x.revenue || 0), 0)
  });
});

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
