// controllers/memberReportController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Member = require('../../models/memberModel');
const OrderHistory = require('../../models/orderHistoryModel');
const throwError = require('../../utils/throwError');
const { parsePeriod } = require('../../utils/periodRange');

const asInt = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

/** Helper: cari member by name/phone */
function buildMemberMatch({ search = '' } = {}) {
  const match = {};
  const s = String(search || '').trim();
  if (s) {
    const rx = new RegExp(s, 'i');
    match.$or = [{ name: rx }, { phone: rx }];
  }
  return match;
}

/** {start,end} dari parsePeriod */
function getRangeFromQuery(q = {}, fallbackMode = 'calendar') {
  const { start, end } = parsePeriod({
    period: q.mode || q.period || 'day',
    start: q.from,
    end: q.to,
    mode: q.range_mode || fallbackMode,
    weekStartsOn: Number.isFinite(+q.weekStartsOn) ? +q.weekStartsOn : 1
  });
  return { start, end };
}

/* ===========================================================
 * 1) Ringkasan pelanggan (list + metrik periode)
 * GET /member-reports/summary
 * Query:
 *  - page, limit, search
 *  - mode/period|from,to|range_mode (parsePeriod) -> apply ke paid_at (paid only)
 *  - sort: 'spend' | 'orders' | 'last_visit' | 'created' | 'lifetime_spend'
 * =========================================================== */
exports.listMemberSummary = asyncHandler(async (req, res) => {
  let { limit = 10, search = '', sort = 'created', cursor } = req.query;
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 200);

  const { start, end } = getRangeFromQuery(req.query);
  const baseMatch = buildMemberMatch({ search });

  // sorting setelah enrich tetap seperti sebelumnya
  const sortStage =
    sort === 'spend'
      ? { period_spend: -1 }
      : sort === 'orders'
      ? { period_orders: -1 }
      : sort === 'last_visit'
      ? { last_visit_at: -1 }
      : sort === 'lifetime_spend'
      ? { total_spend: -1 }
      : { createdAt: -1 };

  // cursor based on createdAt: expect cursor = ISO date string
  const matchCursor = {};
  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) {
      matchCursor.createdAt = { $lt: d };
    }
  }

  const pipeline = [
    { $match: { $and: [baseMatch, matchCursor] } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit + 1 }, // ambil 1 lebih untuk deteksi next_cursor

    // lookup orders paid in period
    {
      $lookup: {
        from: 'orderhistories',
        let: { mid: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$member.id', '$$mid'] },
                  { $eq: ['$payment_status', 'paid'] },
                  { $gte: ['$paid_at', start] },
                  { $lte: ['$paid_at', end] }
                ]
              }
            }
          },
          { $project: { grand_total: 1, paid_at: 1 } }
        ],
        as: 'tx'
      }
    },
    {
      $addFields: {
        period_orders: { $size: '$tx' },
        period_spend: { $sum: '$tx.grand_total' },
        last_paid_at: { $max: '$tx.paid_at' }
      }
    },
    {
      $project: {
        name: 1,
        phone: 1,
        join_channel: 1,
        is_active: 1,
        createdAt: 1,
        last_visit_at: 1,
        visit_count: 1,
        total_spend: 1,
        points: 1,
        period_orders: 1,
        period_spend: 1,
        last_paid_at: 1
      }
    },
    { $sort: sortStage }
  ];

  const raw = await Member.aggregate(pipeline).allowDiskUse(true);

  // next_cursor logic
  let next_cursor = null;
  if (raw.length > limit) {
    const last = raw[limit - 1];
    next_cursor = last?.createdAt
      ? new Date(last.createdAt).toISOString()
      : null;
    raw.splice(limit); // remove extra
  }

  // total count: optional (costly). Jika FE hanya butuh infinite scroll, skip total.
  const total = await Member.countDocuments(baseMatch);

  res.json({
    message: 'Ringkasan pelanggan',
    period: { start, end },
    total,
    limit,
    next_cursor,
    data: raw
  });
});

/* ===========================================================
 * 2) Pelanggan baru (pertumbuhan) — pakai Member.createdAt
 * GET /member-reports/new
 * Query:
 *  - mode/period|from,to|range_mode
 *  - groupBy: 'day'|'week'|'month'|'year'|'none' (default: none)
 * =========================================================== */
exports.newCustomers = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const groupBy = ['day', 'week', 'month', 'year', 'none'].includes(
    String(req.query.groupBy)
  )
    ? String(req.query.groupBy)
    : 'none';

  const match = {
    createdAt: { $gte: start, $lte: end }
  };

  if (groupBy === 'none') {
    const count = await Member.countDocuments(match);
    return res.json({ period: { start, end }, count });
  }

  const keySpec =
    groupBy === 'day'
      ? { $dateToString: { date: '$createdAt', format: '%Y-%m-%d' } }
      : groupBy === 'week'
      ? { $dateToString: { date: '$createdAt', format: '%G-W%V' } }
      : groupBy === 'month'
      ? { $dateToString: { date: '$createdAt', format: '%Y-%m' } }
      : { $dateToString: { date: '$createdAt', format: '%Y' } };

  const items = await Member.aggregate([
    { $match: match },
    { $group: { _id: keySpec, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  res.json({
    period: { start, end },
    items: items.map((x) => ({ key: x._id, count: x.count })),
    total: items.reduce((s, x) => s + (x.count || 0), 0)
  });
});

/* ===========================================================
 * 3) Detail pelanggan (+ metrik periode & lifetime)
 * GET /member-reports/:id
 * Query:
 *  - mode/period|from,to|range_mode  (untuk metrik periode paid_at)
 *  - recent_limit (default 10)
 * =========================================================== */
exports.getMemberDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const m = await Member.findById(id).lean();
  if (!m) throwError('Member tidak ditemukan', 404);

  const { start, end } = getRangeFromQuery(req.query);
  const recentLimit = Math.min(asInt(req.query.recent_limit, 10), 50);

  // metrik periode (paid)
  const [agg] = await OrderHistory.aggregate([
    {
      $match: {
        'member.id': new mongoose.Types.ObjectId(id),
        payment_status: 'paid',
        paid_at: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        spend: { $sum: '$grand_total' },
        avg_ticket: { $avg: '$grand_total' },
        last_paid_at: { $max: '$paid_at' }
      }
    }
  ]);

  const refunds = await OrderHistory.countDocuments({
    'member.id': id,
    payment_status: 'refunded',
    paid_at: { $gte: start, $lte: end }
  });

  const recent_orders = await OrderHistory.find({
    'member.id': id,
    payment_status: 'paid',
    paid_at: { $gte: start, $lte: end }
  })
    .sort({ paid_at: -1 })
    .limit(recentLimit)
    .lean();

  // Top items (opsional insight)
  const topItems = await OrderHistory.aggregate([
    {
      $match: {
        'member.id': new mongoose.Types.ObjectId(id),
        payment_status: 'paid',
        paid_at: { $gte: start, $lte: end }
      }
    },
    { $unwind: { path: '$items', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: { name: '$items.name' },
        qty: { $sum: '$items.quantity' },
        spend: { $sum: '$items.line_subtotal' }
      }
    },
    { $sort: { spend: -1, qty: -1 } },
    { $limit: 10 }
  ]);

  res.json({
    member: {
      _id: m._id,
      name: m.name,
      phone: m.phone,
      join_channel: m.join_channel,
      is_active: m.is_active,
      createdAt: m.createdAt,
      points: m.points || 0,
      // lifetime dari koleksi member
      lifetime: {
        total_spend: m.total_spend || 0,
        visit_count: m.visit_count || 0,
        last_visit_at: m.last_visit_at || null
      }
    },
    period: { start, end },
    metrics: {
      period_orders: agg?.orders || 0,
      period_spend: agg?.spend || 0,
      avg_ticket_size: agg?.avg_ticket ? Math.round(agg.avg_ticket) : 0,
      last_paid_at: agg?.last_paid_at || null,
      refunds
    },
    recent_orders,
    top_items: topItems.map((x) => ({
      name: x._id.name,
      qty: x.qty,
      spend: x.spend
    }))
  });
});

/* ===========================================================
 * 4) Top customer by spend (paid only, periode)
 * GET /member-reports/top-spenders
 * Query:
 *  - mode/period|from,to|range_mode
 *  - limit (default 20)
 * =========================================================== */
exports.topSpenders = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const limit = Math.min(asInt(req.query.limit, 20), 200);

  const rows = await OrderHistory.aggregate([
    {
      $match: {
        payment_status: 'paid',
        'member.id': { $ne: null },
        paid_at: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: '$member.id',
        spend: { $sum: '$grand_total' },
        orders: { $sum: 1 },
        last_paid_at: { $max: '$paid_at' }
      }
    },
    { $sort: { spend: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'members',
        localField: '_id',
        foreignField: '_id',
        as: 'member'
      }
    },
    { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        member_id: '$_id',
        name: '$member.name',
        phone: '$member.phone',
        spend: 1,
        orders: 1,
        points: { $ifNull: ['$member.points', 0] },
        last_paid_at: 1,
        lifetime_total_spend: '$member.total_spend',
        lifetime_visit_count: '$member.visit_count',
        join_channel: '$member.join_channel'
      }
    }
  ]);

  res.json({
    period: { start, end },
    total: rows.length,
    items: rows
  });
});

// DELETE /member-reports/member/:id?anonymize=true
exports.deleteMemberAccount = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const anonymize = String(req.query.anonymize) === 'true';

  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const member = await Member.findById(id);
  if (!member) throwError('Member tidak ditemukan', 404);

  let ordersUpdated = 0;
  let historiesUpdated = 0;

  if (anonymize) {
    // Scrub PII di Order (relasi bisa di-null agar tidak orphan sensitif)
    const orderResult = await mongoose.connection
      .collection('orders')
      .updateMany(
        { member: new mongoose.Types.ObjectId(id) },
        {
          $set: {
            member: null,
            customer_name: '[deleted]',
            customer_phone: ''
          }
        }
      );
    ordersUpdated = orderResult.modifiedCount || 0;

    // Scrub PII snapshot di OrderHistory (tetap simpan angka transaksi)
    const histResult = await mongoose.connection
      .collection('orderhistories')
      .updateMany(
        { 'member.id': new mongoose.Types.ObjectId(id) },
        {
          $set: {
            'member.id': null,
            'member.is_member': false,
            'member.name': '[deleted]',
            'member.phone': ''
          }
        }
      );
    historiesUpdated = histResult.modifiedCount || 0;
  }

  await Member.deleteOne({ _id: id });

  res.json({
    message: 'Akun member dihapus',
    anonymized: anonymize,
    affected: {
      orders: ordersUpdated,
      histories: historiesUpdated
    }
  });
});
