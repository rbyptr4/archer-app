// controllers/orderHistoryController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const OrderHistory = require('../../models/orderHistoryModel');
const Expense = require('../../models/expenseModel'); // sesuaikan path model Expenses kamu
const { parsePeriod } = require('../../utils/periodRange');

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

/* ===================== 1) Laporan periode (harian/mingguan/bulanan/tahunan/kustom) ===================== */
/**
 * GET /order-history/summary
 * Query:
 *  - mode/period: day|week|month|year|overall  (default: day)
 *  - range_mode: calendar|rolling              (default: calendar)
 *  - from,to: ISO (override period jika diisi)
 *  - (opsional filter umum): source, fulfillment_type, cashier_id, member_id, is_member, table, status, payment_status
 * Response: ringkasan count & sums
 */
exports.summaryByPeriod = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const match = buildCommonMatch(req.query);
  // default gunakan paid_at untuk jendela waktu laporan
  match.paid_at = { $gte: start, $lte: end };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        allCount: { $sum: 1 },
        paidCount: {
          $sum: { $cond: [{ $eq: ['$payment_status', 'paid'] }, 1, 0] }
        },
        refundedCount: {
          $sum: { $cond: [{ $eq: ['$payment_status', 'refunded'] }, 1, 0] }
        },
        voidCount: {
          $sum: { $cond: [{ $eq: ['$payment_status', 'void'] }, 1, 0] }
        },
        cancelledCount: { $sum: { $cond: ['$is_cancelled', 1, 0] } },

        omzet: { $sum: '$items_subtotal' },
        pendapatan: { $sum: '$grand_total' },
        delivery_fee: { $sum: '$delivery_fee' },
        items_discount: { $sum: '$items_discount' },
        shipping_discount: { $sum: '$shipping_discount' },
        grand_total: { $sum: '$grand_total' }
      }
    }
  ];

  const [agg] = await OrderHistory.aggregate(pipeline);
  res.json({
    period: { start, end },
    count: {
      all: agg?.allCount || 0,
      paid: agg?.paidCount || 0,
      refunded: agg?.refundedCount || 0,
      void: agg?.voidCount || 0,
      cancelled: agg?.cancelledCount || 0
    },
    sums: {
      omzet: agg?.omzet || 0,
      pendapatan: agg?.pendapatan || 0,
      delivery_fee: agg?.delivery_fee || 0,
      items_discount: agg?.items_discount || 0,
      shipping_discount: agg?.shipping_discount || 0,
      grand_total: agg?.grand_total || 0
    }
  });
});

/* ===================== 2) Total Transaksi Lunas (filter) ===================== */
/**
 * GET /order-history/transactions/paid
 * Query: (periode + filter umum) + include=list&limit=...
 */
exports.totalPaidTransactions = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const match = buildCommonMatch({ ...req.query, payment_status: 'paid' });
  match.paid_at = { $gte: start, $lte: end };

  const [agg] = await OrderHistory.aggregate([
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

  let list = undefined;
  if (String(req.query.include) === 'list') {
    const limit = Math.min(asInt(req.query.limit, 50), 200);
    list = await OrderHistory.find(match)
      .sort({ paid_at: -1 })
      .limit(limit)
      .lean();
  }

  const count = agg?.count || 0;
  const totalGrand = agg?.total_grand || 0;
  res.json({
    period: { start, end },
    count,
    total_grand: totalGrand,
    total_items_subtotal: agg?.total_items_subtotal || 0,
    avg_ticket_size: count ? Math.round(totalGrand / count) : 0,
    list
  });
});

/* ===================== 3) Total Transaksi Batal (cancel/refund) ===================== */
/**
 * GET /order-history/transactions/cancelled
 * Query: (periode + filter umum) + include=list
 */
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

/* ===================== 4) Omzet / Pendapatan ===================== */
/**
 * GET /order-history/finance/sales
 * Query:
 *  - metric: omzet|pendapatan (default pendapatan)
 *  - groupBy: day|week|month|year|none (default none)
 *  - (periode + filter umum)
 */
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

  // default paid only jika user tidak override
  const baseMatch = buildCommonMatch({ ...req.query });
  if (!req.query.payment_status) baseMatch.payment_status = 'paid';
  baseMatch.paid_at = { $gte: start, $lte: end };

  const sumField = metric === 'omzet' ? '$items_subtotal' : '$grand_total';

  if (groupBy === 'none') {
    const [agg] = await OrderHistory.aggregate([
      { $match: baseMatch },
      { $group: { _id: null, total: { $sum: sumField } } }
    ]);
    return res.json({
      period: { start, end },
      metric,
      total: agg?.total || 0
    });
  }

  // group pakai key yang sudah ada di doc: dayKey/weekKey/monthKey/year
  const keyField =
    groupBy === 'day'
      ? '$dayKey'
      : groupBy === 'week'
      ? '$weekKey'
      : groupBy === 'month'
      ? '$monthKey'
      : '$year';

  const items = await OrderHistory.aggregate([
    { $match: baseMatch },
    { $group: { _id: keyField, total: { $sum: sumField } } },
    { $sort: { _id: 1 } }
  ]);

  res.json({
    period: { start, end },
    metric,
    items: items.map((x) => ({ key: x._id, total: x.total })),
    total: items.reduce((s, x) => s + (x.total || 0), 0)
  });
});

/* ===================== 5) Pengeluaran (Expenses) ===================== */
/**
 * GET /order-history/finance/expenses
 * Query:
 *  - groupBy: day|week|month|year|none (default none)
 *  - type: filter jenis
 *  - (periode) -> pakai field Expense.date
 */
exports.financeExpenses = asyncHandler(async (req, res) => {
  // untuk expense, tetap pakai parsePeriod kamu (date range)
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

  // bentuk key via $dateToString
  const keySpec =
    groupBy === 'day'
      ? { $dateToString: { date: '$date', format: '%Y-%m-%d' } }
      : groupBy === 'week'
      ? { $dateToString: { date: '$date', format: '%G-W%V' } } // ISO week
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

/* ===================== 6) Laba/Rugi ===================== */
/**
 * GET /order-history/finance/profit-loss
 * Query:
 *  - revenue_metric: pendapatan|omzet (default pendapatan)
 *  - detail: true untuk breakdown
 *  - (periode) untuk revenue (OrderHistory.paid_at) dan expense (Expense.date)
 */
exports.profitLoss = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const revenueMetric = ['pendapatan', 'omzet'].includes(
    String(req.query.revenue_metric)
  )
    ? String(req.query.revenue_metric)
    : 'pendapatan';

  // Revenue dari OrderHistory (default paid only)
  const revenueMatchBase = buildCommonMatch({ ...req.query });
  if (!req.query.payment_status) revenueMatchBase.payment_status = 'paid';
  revenueMatchBase.paid_at = { $gte: start, $lte: end };
  const revenueField =
    revenueMetric === 'omzet' ? '$items_subtotal' : '$grand_total';

  const [revAgg] = await OrderHistory.aggregate([
    { $match: revenueMatchBase },
    { $group: { _id: null, total: { $sum: revenueField } } }
  ]);
  const revenue = revAgg?.total || 0;

  // Expense dari Expense model
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

    const revenueBreak = await OrderHistory.aggregate([
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

/* ===================== Extra: View detail & Delete ===================== */

/** GET /order-history/:id */
exports.getHistoryDetail = asyncHandler(async (req, res) => {
  const doc = await OrderHistory.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'History tidak ditemukan' });
  res.json({ history: doc });
});

/** DELETE /order-history/:id  (owner only) */
exports.deleteHistory = asyncHandler(async (req, res) => {
  const doc = await OrderHistory.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: 'History tidak ditemukan' });

  await OrderHistory.deleteOne({ _id: doc._id });
  res.json({ message: 'History dihapus' });
});

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
  if (!req.query.payment_status) {
    match.payment_status = 'verified';
  }
  match.paid_at = { $gte: start, $lte: end };

  // === Group key ===
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
    // groupBy menu (default)
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

  const rows = await OrderHistory.aggregate(pipeline);

  // === Normalize output ===
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
    // menu
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
