// controllers/owner/reportController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Order = require('../../models/orderModel');
const Member = require('../../models/memberModel');
// OPTIONAL: kalau belum ada, kamu bisa comment baris Expense ini + fungsi yang memakainya
let Expense = null;
try {
  Expense = require('../../models/expenseModel');
} catch {
  /* optional */
}

const { parsePeriod } = require('../../utils/periodRange');

/* ========================= Helpers ========================= */
function rangeFromQuery(q) {
  const { period, start, end, mode, weekStartsOn } = q || {};
  const { start: s, end: e } = parsePeriod({
    period,
    start,
    end,
    mode,
    weekStartsOn
  });
  return { start: s, end: e };
}

// granularity untuk timeseries chart berdasarkan period yang diminta
function inferBucket(period = 'day') {
  const p = String(period || '').toLowerCase();
  if (p === 'year' || p === 'overall') return 'month';
  if (p === 'month') return 'day';
  if (p === 'week') return 'day';
  return 'hour'; // default detail
}

// builder $match untuk PAID dan CANCELLED
function matchPaid(rs) {
  return {
    payment_status: 'paid',
    paid_at: { $gte: rs.start, $lte: rs.end },
    isDeleted: { $ne: true }
  };
}
function matchCancelled(rs) {
  return {
    status: 'cancelled',
    cancelled_at: { $gte: rs.start, $lte: rs.end },
    isDeleted: { $ne: true }
  };
}

// util aman aggregate Expense (kalau model belum ada)
async function safeExpenseAggregate(pipeline) {
  if (!Expense) return [];
  try {
    return await Expense.aggregate(pipeline);
  } catch {
    return [];
  }
}

/* ==================== 1) Laporan Order/Transaksi ==================== */

/**
 * GET /reports/orders/summary
 * Query: period|start|end|mode|weekStartsOn
 * Return:
 *  - total_paid (jumlah order yang paid pada range)
 *  - total_cancelled (jumlah order batal pada range)
 *  - omzet_paid (sum grand_total pada order paid)
 */
exports.orderSummary = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);

  const [paidCountAgg, paidAmtAgg, cancelledCount] = await Promise.all([
    Order.countDocuments(matchPaid(rs)),
    Order.aggregate([
      { $match: matchPaid(rs) },
      { $group: { _id: null, omzet: { $sum: '$grand_total' } } }
    ]),
    Order.countDocuments(matchCancelled(rs))
  ]);

  const omzet_paid = paidAmtAgg?.[0]?.omzet || 0;

  res.json({
    total_paid: paidCountAgg,
    total_cancelled: cancelledCount,
    omzet_paid
  });
});

/**
 * GET /reports/orders/list
 * Daftar order pada range:
 *  - type=paid (default) → filter pakai paid_at
 *  - type=all → pakai createdAt
 *  - type=cancelled → pakai cancelled_at
 * Query: type, period|start|end|mode|weekStartsOn, limit (default 100)
 */
exports.orderList = asyncHandler(async (req, res) => {
  const { type = 'paid', limit = 100 } = req.query;
  const rs = rangeFromQuery(req.query);

  let q = { isDeleted: { $ne: true } };
  if (type === 'paid') {
    Object.assign(q, {
      payment_status: 'paid',
      paid_at: { $gte: rs.start, $lte: rs.end }
    });
  } else if (type === 'cancelled') {
    Object.assign(q, {
      status: 'cancelled',
      cancelled_at: { $gte: rs.start, $lte: rs.end }
    });
  } else {
    // all by createdAt
    Object.assign(q, { createdAt: { $gte: rs.start, $lte: rs.end } });
  }

  const orders = await Order.find(q)
    .populate('member', 'name phone')
    .populate('verified_by', 'name') // kasir/verifikator pembayaran
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 100, 500));

  res.json({ orders });
});

/**
 * GET /reports/orders/timeseries
 * Timeseries omzet (grand_total) untuk order paid pada range, di-bucket
 * otomatis berdasar period: hour/day/month
 * Return: { buckets: [ { t, count, omzet } ] }
 */
exports.orderTimeseries = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);
  const bucket = inferBucket(req.query.period);

  // Pakai $dateTrunc (MongoDB 5.0+) agar rapi
  const buckets = await Order.aggregate([
    { $match: matchPaid(rs) },
    {
      $group: {
        _id: {
          t: {
            $dateTrunc: {
              date: '$paid_at',
              unit: bucket,
              timezone: 'Asia/Jakarta'
            }
          }
        },
        count: { $sum: 1 },
        omzet: { $sum: '$grand_total' }
      }
    },
    { $project: { _id: 0, t: '$_id.t', count: 1, omzet: 1 } },
    { $sort: { t: 1 } }
  ]);

  res.json({ buckets, bucket });
});

/**
 * GET /reports/orders/top-menu
 * Top menu berdasarkan qty & sales (order paid dalam range)
 * Query: limit (default 10)
 */
exports.orderTopMenu = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  const top = await Order.aggregate([
    { $match: matchPaid(rs) },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.menu',
        name: { $last: '$items.name' },
        total_qty: { $sum: '$items.quantity' },
        total_sales: { $sum: '$items.line_subtotal' }
      }
    },
    { $sort: { total_qty: -1 } },
    { $limit: limit }
  ]);

  res.json({ top });
});

/* ==================== 2) Laporan Keuangan ==================== */

/**
 * GET /reports/finance/summary
 * - omzet_paid: sum grand_total dari order paid (paid_at in range)
 * - total_expense: sum amount dari Expense (createdAt in range) — optional
 * - profit: omzet_paid - total_expense
 */
exports.financeSummary = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);

  const [omzetAgg, expenseAgg] = await Promise.all([
    Order.aggregate([
      { $match: matchPaid(rs) },
      { $group: { _id: null, omzet: { $sum: '$grand_total' } } }
    ]),
    safeExpenseAggregate([
      {
        $match: {
          isDeleted: { $ne: true },
          createdAt: { $gte: rs.start, $lte: rs.end }
        }
      },
      { $group: { _id: null, total_expense: { $sum: '$amount' } } }
    ])
  ]);

  const omzet_paid = omzetAgg?.[0]?.omzet || 0;
  const total_expense = expenseAgg?.[0]?.total_expense || 0;
  const profit = omzet_paid - total_expense;

  res.json({ omzet_paid, total_expense, profit });
});

/**
 * GET /reports/finance/expense-list
 * Daftar pengeluaran (optional model). Query: period|start|end|...
 */
exports.expenseList = asyncHandler(async (req, res) => {
  if (!Expense)
    return res.json({ expenses: [], note: 'Expense model belum tersedia' });
  const rs = rangeFromQuery(req.query);
  const data = await Expense.find({
    isDeleted: { $ne: true },
    createdAt: { $gte: rs.start, $lte: rs.end }
  })
    .populate('created_by', 'name')
    .sort({ createdAt: -1 });

  res.json({ expenses: data });
});

/**
 * GET /reports/finance/profit-loss
 * Laba/Rugi ringkas:
 *  - omzet_paid (paid_at range)
 *  - (opsional) COGS kalau kamu punya modelnya sendiri (sementara 0)
 *  - expense_operational (Expense)
 *  - profit = omzet - expense_operational - COGS
 */
exports.profitLoss = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);

  const omzetAgg = await Order.aggregate([
    { $match: matchPaid(rs) },
    { $group: { _id: null, omzet: { $sum: '$grand_total' } } }
  ]);
  const omzet_paid = omzetAgg?.[0]?.omzet || 0;

  const expenseAgg = await safeExpenseAggregate([
    {
      $match: {
        isDeleted: { $ne: true },
        createdAt: { $gte: rs.start, $lte: rs.end }
      }
    },
    { $group: { _id: null, total_expense: { $sum: '$amount' } } }
  ]);
  const expense_operational = expenseAgg?.[0]?.total_expense || 0;

  const cogs = 0; // TODO: jika ada tabel HPP/COGS, tarik di sini
  const profit = omzet_paid - expense_operational - cogs;

  res.json({ omzet_paid, expense_operational, cogs, profit });
});

/* ==================== 3) Laporan Member ==================== */

/**
 * GET /reports/members/summary
 * - total_members (aktif & tidak — sesuaikan kebijakan)
 * - new_members (createdAt di range)
 */
exports.memberSummary = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);

  const [total, newcomers] = await Promise.all([
    Member.countDocuments({ isDeleted: { $ne: true } }),
    Member.countDocuments({
      isDeleted: { $ne: true },
      createdAt: { $gte: rs.start, $lte: rs.end }
    })
  ]);

  res.json({ total_members: total, new_members: newcomers });
});

/**
 * GET /reports/members/list
 * List seluruh member ringkas
 */
exports.memberList = asyncHandler(async (_req, res) => {
  const members = await Member.find({ isDeleted: { $ne: true } })
    .select('name phone points total_spend last_visit_at createdAt is_active')
    .sort({ createdAt: -1 });

  res.json({ members });
});

/**
 * GET /reports/members/top-customer
 * Top pelanggan berdasarkan total belanja (grand_total) PAID di range
 */
exports.topCustomer = asyncHandler(async (req, res) => {
  const rs = rangeFromQuery(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  const top = await Order.aggregate([
    { $match: Object.assign(matchPaid(rs), { member: { $ne: null } }) },
    {
      $group: {
        _id: '$member',
        total_spent: { $sum: '$grand_total' },
        total_orders: { $sum: 1 }
      }
    },
    { $sort: { total_spent: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'members',
        localField: '_id',
        foreignField: '_id',
        as: 'member'
      }
    },
    { $unwind: '$member' },
    {
      $project: {
        _id: 0,
        member_id: '$_id',
        name: '$member.name',
        phone: '$member.phone',
        total_spent: 1,
        total_orders: 1
      }
    }
  ]);

  res.json({ top });
});

/**
 * GET /reports/members/:id/detail
 * Detail pelanggan + histori order paid pada range
 */
exports.memberDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: 'member id tidak valid' });

  const rs = rangeFromQuery(req.query);

  const [member, orders] = await Promise.all([
    Member.findOne({ _id: id, isDeleted: { $ne: true } }).select(
      'name phone points total_spend last_visit_at createdAt is_active'
    ),
    Order.find({
      member: id,
      payment_status: 'paid',
      paid_at: { $gte: rs.start, $lte: rs.end },
      isDeleted: { $ne: true }
    })
      .populate('verified_by', 'name')
      .sort({ paid_at: -1 })
  ]);

  if (!member)
    return res.status(404).json({ message: 'Member tidak ditemukan' });

  res.json({ member, orders });
});
