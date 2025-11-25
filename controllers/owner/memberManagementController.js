const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Member = require('../../models/memberModel');
const throwError = require('../../utils/throwError');
const { parseRange } = require('../../utils/periodRange');

const asInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

function buildMemberMatch({ search = '' } = {}) {
  const match = {};
  const s = String(search || '').trim();
  if (s) {
    const rx = new RegExp(s, 'i');
    match.$or = [{ name: rx }, { phone: rx }];
  }
  return match;
}

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

// Top spender dengan filter
exports.topSpenders = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);
  const limit = Math.min(asInt(req.query.limit, 50), 200);

  const rows = await Order.aggregate([
    {
      $match: {
        payment_status: 'verified',
        member: { $ne: null },
        paid_at: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: '$member',
        total_spend_period: { $sum: { $ifNull: ['$grand_total', 0] } },
        total_orders: { $sum: 1 }
      }
    },
    { $sort: { total_spend_period: -1 } },
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
        member_id: '$_id',
        name: '$member.name',
        phone: '$member.phone',
        address: '$member.address',
        total_orders: 1,
        total_spend_period: 1
      }
    }
  ]);

  res.json({
    period: { start, end },
    total: rows.length,
    items: rows
  });
});

exports.listMemberSummary = asyncHandler(async (req, res) => {
  let { limit = 10, search = '', cursor } = req.query;
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 200);

  const baseMatch = buildMemberMatch({ search });

  const matchCursor = {};
  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime())) {
      matchCursor.createdAt = { $lt: d };
    }
  }

  const combinedMatch = { $and: [baseMatch, matchCursor] };

  // pipeline: match -> sort desc -> limit+1 -> project only required fields
  const pipeline = [
    { $match: combinedMatch },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit + 1 },
    {
      $project: {
        name: 1,
        phone: 1,
        total_spend: 1,
        createdAt: 1
      }
    }
  ];

  const raw = await Member.aggregate(pipeline).allowDiskUse(true);

  // next_cursor logic
  let next_cursor = null;
  let rows = raw;
  if (raw.length > limit) {
    const extra = raw[limit]; // there is an extra
    next_cursor = extra?.createdAt
      ? new Date(extra.createdAt).toISOString()
      : null;
    rows = raw.slice(0, limit);
  }

  // optional total count for search (still useful for FE)
  const total = await Member.countDocuments(baseMatch);

  // map to minimal shape (no extra fields)
  const data = rows.map((r) => ({
    name: r.name || '',
    phone: r.phone || '',
    total_spend: r.total_spend || 0,
    createdAt: r.createdAt
  }));

  res.json({
    limit,
    next_cursor,
    total,
    data
  });
});

exports.getMemberDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const m = await Member.findById(id).lean();
  if (!m) throwError('Member tidak ditemukan', 404);

  res.json({
    member: {
      _id: m._id,
      name: m.name,
      phone: m.phone,
      gender: m.gender,
      createdAt: m.createdAt,
      points: m.points || 0,
      spend_point_total: m.spend_point_total,
      birthday: m.birthday,
      total_spend: m.total_spend || 0,
      visit_count: m.visit_count || 0,
      last_visit_at: m.last_visit_at || null
    }
  });
});

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
