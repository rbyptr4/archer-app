// controllers/memberReportController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Member = require('../../models/memberModel');
const Order = require('../../models/orderModel');
const throwError = require('../../utils/throwError');
const { parseRange } = require('../../utils/periodRange');

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
    message: 'Ringkasan pelanggan (simple)',
    limit,
    next_cursor,
    total,
    data
  });
});

exports.newCustomers = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  // Gender filter (optional)
  const gender =
    req.query.gender === 'male' || req.query.gender === 'female'
      ? req.query.gender
      : null;

  const match = {
    createdAt: { $gte: start, $lte: end }
  };

  // Jika gender dikirim -> filter, kalau tidak -> ALL gender
  if (gender) match.gender = gender;

  // Ambil semua member baru (sesuai filter)
  const rows = await Member.find(match).select('createdAt gender').lean();

  // Ambil juga data male/female (tanpa filter gender)
  const genderRows = await Member.find({
    createdAt: { $gte: start, $lte: end }
  })
    .select('gender')
    .lean();

  const maleCount = genderRows.filter((x) => x.gender === 'male').length;
  const femaleCount = genderRows.filter((x) => x.gender === 'female').length;

  // BUCKET HARIAN
  const days = [];
  const cur = new Date(start);

  while (cur <= end) {
    const dayStr = cur.toISOString().substring(0, 10);
    days.push({ key: dayStr, count: 0 });
    cur.setDate(cur.getDate() + 1);
  }

  // Hitung jumlah per hari
  for (const m of rows) {
    const d = m.createdAt.toISOString().substring(0, 10);
    const bucket = days.find((x) => x.key === d);
    if (bucket) bucket.count++;
  }

  res.json({
    period: { start, end },
    gender_filter: gender || 'all',
    items: days,
    total: rows.length,
    gender_stats: {
      male: maleCount,
      female: femaleCount
    }
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
        spend: { $sum: { $ifNull: ['$grand_total', 0] } },
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
