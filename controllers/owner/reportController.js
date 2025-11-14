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
exports.transactionSummary = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const period = String(req.query?.period || 'day'); // day|month|year|range
  const dateQ = String(req.query?.date || '').trim(); // YYYY-MM-DD
  const monthQ = String(req.query?.month || '').trim(); // YYYY-MM
  const yearQ = String(req.query?.year || '').trim(); // YYYY
  const fromQ = req.query?.from || null; // ISO
  const toQ = req.query?.to || null; // ISO

  // shift override (optional)
  const defaultShift1 = '00:00-14:59';
  const defaultShift2 = '15:00-23:59';
  const shift1Str = String(req.query?.shift1 || defaultShift1).trim();
  const shift2Str = String(req.query?.shift2 || defaultShift2).trim();

  // helper to parse base range based on period
  let rangeFrom, rangeTo;
  const now = dayjs().tz(LOCAL_TZ);

  if (period === 'day') {
    const base = dateQ ? dayjs(dateQ).tz(LOCAL_TZ) : now;
    if (!base.isValid()) throwError('date tidak valid (YYYY-MM-DD)', 400);
    rangeFrom = base.startOf('day');
    rangeTo = base.endOf('day');
  } else if (period === 'month') {
    const base = monthQ ? dayjs(monthQ + '-01').tz(LOCAL_TZ) : now;
    if (!base.isValid()) throwError('month tidak valid (YYYY-MM)', 400);
    rangeFrom = base.startOf('month');
    rangeTo = base.endOf('month');
  } else if (period === 'year') {
    const base = yearQ ? dayjs(String(yearQ) + '-01-01').tz(LOCAL_TZ) : now;
    if (!base.isValid()) throwError('year tidak valid (YYYY)', 400);
    rangeFrom = base.startOf('year');
    rangeTo = base.endOf('year');
  } else if (period === 'range') {
    if (!fromQ || !toQ)
      throwError('Untuk period=range, kirimkan from & to (ISO).', 400);
    const f = dayjs(fromQ).tz(LOCAL_TZ);
    const t = dayjs(toQ).tz(LOCAL_TZ);
    if (!f.isValid() || !t.isValid())
      throwError('from/to tidak valid (ISO).', 400);
    rangeFrom = f.startOf('minute');
    rangeTo = t.endOf('minute');
  } else {
    throwError('period tidak valid. Gunakan day|month|year|range', 400);
  }

  // If shift override is provided (user may want to see only shift1 or shift2)
  // support query param `only_shift=1|2` to restrict to only that shift.
  const onlyShift = String(req.query?.only_shift || '').trim(); // '1' or '2' or ''

  const toRangeDayjs = (rangeStr, baseDay) => {
    const parsed = parseTimeRangeToDayjs(
      rangeStr,
      baseDay.format('YYYY-MM-DD')
    );
    if (!parsed) return null;
    return { from: parsed.from, to: parsed.to };
  };

  // Build ranges to compute: full period + shift1 + shift2 (shift ranges inside the same day)
  // For monthly/yearly/range, shift1/shift2 will be interpreted per-day if period === 'day'
  // If period !== day and onlyShift set, we will apply shift time-of-day across all days in range (aggregate by paid_at)
  // Simpler approach: when period === 'day' calculate shifts with same baseDay; else if onlyShift provided, restrict paid_at time-of-day across whole range.

  const ranges = [];

  // full range
  ranges.push({ id: 'full', from: rangeFrom, to: rangeTo });

  // For day: compute shift1 & shift2 as provided
  if (period === 'day') {
    const shift1 = toRangeDayjs(shift1Str, rangeFrom);
    const shift2 = toRangeDayjs(shift2Str, rangeFrom);
    if (!shift1 || !shift2)
      throwError('Format shift tidak valid. Gunakan "HH:mm-HH:mm".', 400);
    ranges.push({ id: 'shift1', from: shift1.from, to: shift1.to });
    ranges.push({ id: 'shift2', from: shift2.from, to: shift2.to });
  } else if (onlyShift === '1' || onlyShift === '2') {
    // interpret shift times-of-day across entire date range
    const baseForShift = rangeFrom; // we'll use only HH:mm parts
    const shift1 = toRangeDayjs(shift1Str, baseForShift);
    const shift2 = toRangeDayjs(shift2Str, baseForShift);
    if (!shift1 || !shift2)
      throwError('Format shift tidak valid. Gunakan "HH:mm-HH:mm".', 400);

    // create a function to test time-of-day instead of building many ranges
    ranges.push({
      id: onlyShift === '1' ? 'shift1' : 'shift2',
      from: shift1.from,
      to: shift1.to,
      applyDaily: true,
      which: onlyShift === '1' ? shift1 : shift2
    });
  } else {
    // not day and no onlyShift -> still include shift summaries but not apply them (optional)
    // We'll still try to compute aggregated by_payment_method for full range only.
  }

  // helper builder: match for paid orders in a given from/to (dayjs objects)
  const buildOrderMatchFor = (fromD, toD) => ({
    payment_status: { $in: ['paid', 'verified'] },
    paid_at: { $gte: fromD.toDate(), $lte: toD.toDate() },
    status: { $ne: 'cancelled' }
  });

  // helper aggregation to get omzet + count + by payment method
  const aggregateOrdersForRange = async (fromD, toD, applyDailyTimeWindow) => {
    // If applyDailyTimeWindow === {fromDayjs,toDayjs, daily:true} we need to match based on time-of-day across days.
    if (!applyDailyTimeWindow) {
      const match = buildOrderMatchFor(fromD, toD);
      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: { $ifNull: ['$payment_method', 'unknown'] },
            omzet: { $sum: { $ifNull: ['$grand_total', 0] } },
            count: { $sum: 1 }
          }
        }
      ];
      const rows = await Order.aggregate(pipeline).allowDiskUse(true);
      // normalize
      const methods = { transfer: 0, qris: 0, cash: 0, card: 0, unknown: 0 };
      let total = 0;
      let totalCount = 0;
      for (const r of rows || []) {
        const m = String(r._id || 'unknown');
        const amt = Number(r.omzet || 0);
        const cnt = Number(r.count || 0);
        if (Object.prototype.hasOwnProperty.call(methods, m)) methods[m] = amt;
        else methods.unknown += amt;
        total += amt;
        totalCount += cnt;
      }
      return {
        total_amount: total,
        total_count: totalCount,
        by_payment_method: methods
      };
    }

    // applyDailyTimeWindow: select orders in [fromD_global, toD_global] AND where paid_at time-of-day within window
    // We'll query by paid_at between global from/to, then filter in JS by time-of-day (safe for moderate data sizes).
    const globalMatch = {
      payment_status: { $in: ['paid', 'verified'] },
      paid_at: { $gte: fromD.toDate(), $lte: toD.toDate() },
      status: { $ne: 'cancelled' }
    };
    const docs = await Order.find(globalMatch)
      .select('payment_method grand_total paid_at')
      .lean();
    const methods = { transfer: 0, qris: 0, cash: 0, card: 0, unknown: 0 };
    let total = 0;
    let totalCount = 0;

    const dayWindowFrom = applyDailyTimeWindow.from; // dayjs with a sample date, we use HH:mm
    const dayWindowTo = applyDailyTimeWindow.to;

    for (const d of docs || []) {
      if (!d.paid_at) continue;
      const p = dayjs(d.paid_at).tz(LOCAL_TZ);
      // build day-local window for this date
      const dayStr = p.format('YYYY-MM-DD');
      const winFrom = dayWindowFrom
        .clone()
        .set('year', p.year())
        .set('month', p.month())
        .set('date', p.date());
      const winTo = dayWindowTo
        .clone()
        .set('year', p.year())
        .set('month', p.month())
        .set('date', p.date());
      // if windowTo < windowFrom, assume window crosses midnight -> add 1 day to winTo
      if (winTo.isBefore(winFrom)) winTo.add(1, 'day');
      if (p.isBetween(winFrom, winTo, null, '[]')) {
        const m = String(d.payment_method || 'unknown');
        const amt = Number(d.grand_total || 0);
        if (Object.prototype.hasOwnProperty.call(methods, m)) methods[m] += amt;
        else methods.unknown += amt;
        total += amt;
        totalCount += 1;
      }
    }

    return {
      total_amount: total,
      total_count: totalCount,
      by_payment_method: methods
    };
  };

  // compute pengeluaran: attempt to use Expense model if available
  let pengeluaran = 0;
  try {
    let ExpenseModel = null;
    try {
      ExpenseModel = require('../models/expenseModel');
    } catch (e) {
      ExpenseModel = null;
    }
    if (ExpenseModel) {
      const expAgg = await ExpenseModel.aggregate([
        {
          $match: {
            createdAt: { $gte: rangeFrom.toDate(), $lte: rangeTo.toDate() }
          }
        },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$amount', 0] } } } }
      ]);
      pengeluaran = expAgg?.[0]?.total || 0;
    } else {
      // no expense model found in project, default 0
      pengeluaran = 0;
    }
  } catch (err) {
    console.error('[transactionSummary][expense]', err?.message || err);
    pengeluaran = 0;
  }

  // run aggregations for ranges
  const results = {};
  for (const r of ranges) {
    if (r.applyDaily) {
      const agg = await aggregateOrdersForRange(rangeFrom, rangeTo, {
        from: r.which.from,
        to: r.which.to
      });
      results[r.id] = agg;
    } else {
      const agg = await aggregateOrdersForRange(r.from, r.to, null);
      results[r.id] = agg;
    }
  }

  // prepare response: full, shift1, shift2 (if present)
  const omzet = results.full?.total_amount || 0;
  const total_transactions = results.full?.total_count || 0;
  const by_payment_method = results.full?.by_payment_method || {
    transfer: 0,
    qris: 0,
    cash: 0,
    card: 0,
    unknown: 0
  };

  const shift1_summary = results.shift1 || null;
  const shift2_summary = results.shift2 || null;

  const pendapatan = omzet - pengeluaran;

  return res.json({
    success: true,
    period: period,
    range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
    totals: {
      pengeluaran,
      omzet,
      pendapatan,
      total_transactions
    },
    by_payment_method,
    shifts: {
      shift1: shift1_summary
        ? {
            total_amount: shift1_summary.total_amount,
            total_count: shift1_summary.total_count,
            by_payment_method: shift1_summary.by_payment_method
          }
        : null,
      shift2: shift2_summary
        ? {
            total_amount: shift2_summary.total_amount,
            total_count: shift2_summary.total_count,
            by_payment_method: shift2_summary.by_payment_method
          }
        : null
    }
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
