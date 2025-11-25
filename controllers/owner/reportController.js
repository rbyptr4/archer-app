const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const dayjs = require('dayjs');

const Expense = require('../../models/expenseModel');
const Order = require('../../models/orderModel');
const Member = require('../../models/memberModel');

const throwError = require('../../utils/throwError');
const { parseRange } = require('../../utils/periodRange');

const asInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

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

function buildMemberMatch({ search = '' } = {}) {
  const match = {};
  const s = String(search || '').trim();
  if (s) {
    const rx = new RegExp(s, 'i');
    match.$or = [{ name: rx }, { phone: rx }];
  }
  return match;
}

// Data dashboard laporan
exports.reportDashboard = asyncHandler(async (req, res) => {
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

// data transaksi
exports.totalTransactions = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  const match = {
    status: 'completed',
    paid_at: { $gte: start, $lte: end }
  };

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

  const findQuery = { ...match };

  if (cursor) {
    if (!mongoose.Types.ObjectId.isValid(cursor)) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    findQuery._id = { $lt: mongoose.Types.ObjectId(cursor) };
  }

  const rows = await Order.find(findQuery)
    .select(
      'member customer_name customer_phone grand_total transaction_code createdAt'
    )
    .populate('member', 'name phone')
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  let nextCursor = null;
  let resultRows = rows;
  if (rows.length > limit) {
    const extra = rows.pop(); // remove extra
    nextCursor = extra._id.toString();
    resultRows = rows;
  } else if (rows.length > 0) {
    nextCursor = null;
  }

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
      _id: r._id
    };
  });

  res.json({
    period: { start, end },
    total_transactions: count,
    total_grand: totalGrand,
    average_per_order: averagePerOrder,
    limit,
    nextCursor,
    orders
  });
});

// Detail order
exports.getDetailOrder = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!req.user) throwError('Unauthorized', 401);
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  // populate member (ambil hanya name & phone)
  const order = await Order.findById(id)
    .populate({ path: 'member', select: 'name phone' })
    .lean();
  if (!order) throwError('Order tidak ditemukan', 404);

  const safeNumber = (v) => (Number.isFinite(+v) ? +v : 0);

  // Susun response yang bersih / minimal (aggregate approach)
  const slim = {
    id: String(order._id),
    transaction_code: order.transaction_code,
    customer: {
      // prioritas: member (populate) -> explicit customer_name/phone di order
      name: order.member?.name || order.customer_name || null,
      phone: order.member?.phone || order.customer_phone || null
    },
    fulfillment_type: order.fulfillment_type || null,
    table_number: order.table_number ?? null,
    payment_status: order.payment_status ?? null,
    // items: show base price, addons and line_subtotal (no per-item tax/service)
    items: (order.items || []).map((it) => {
      const qty = safeNumber(it.quantity || 0);
      const basePrice = safeNumber(it.base_price || 0);

      const addons_unit = (it.addons || []).reduce(
        (s, a) => s + (Number.isFinite(+a.price) ? +a.price : 0) * (a.qty || 1),
        0
      );

      const unit_before_tax = basePrice + addons_unit;
      const line_subtotal = Number(it.line_subtotal ?? unit_before_tax * qty);

      return {
        name: it.name,
        menu: String(it.menu || ''),
        menu_code: it.menu_code || '',
        imageUrl: it.imageUrl || '',
        qty,
        base_price: basePrice,
        addons: (it.addons || []).map((a) => ({
          name: a.name,
          price: safeNumber(a.price),
          qty: a.qty || 1
        })),
        notes: it.notes || '',
        line_subtotal
      };
    }),
    totals: {
      items_subtotal: safeNumber(order.items_subtotal || 0), // BEFORE tax
      service_fee: safeNumber(order.service_fee || 0),
      delivery_fee: safeNumber(order.delivery_fee || 0),
      items_discount: safeNumber(order.items_discount || 0),
      shipping_discount: safeNumber(order.shipping_discount || 0),
      tax_rate_percent: safeNumber(
        order.tax_rate_percent || Math.round((parsePpnRate() || 0.11) * 100)
      ),
      tax_amount: safeNumber(order.tax_amount || 0),
      rounding_delta: safeNumber(order.rounding_delta || 0),
      grand_total: safeNumber(order.grand_total || 0)
    },
    payment: {
      method: order.payment_method || null,
      provider: order.payment_provider || null,
      status: order.payment_status || null,
      proof_url: order.payment_proof_url || null,
      paid_at: order.paid_at || null
    },
    status: order.status || null,
    placed_at: order.placed_at || null,
    created_at: order.createdAt || null,
    updated_at: order.updatedAt || null,
    delivery: order.delivery
      ? {
          mode: order.delivery.mode || null,
          address_text: order.delivery.address_text || null,
          location:
            order.delivery.location &&
            typeof order.delivery.location.lat === 'number'
              ? {
                  lat: order.delivery.location.lat,
                  lng: order.delivery.location.lng
                }
              : null,
          distance_km: order.delivery.distance_km ?? null,
          delivery_fee: order.delivery.delivery_fee ?? null,
          slot_label: order.delivery.slot_label || null,
          scheduled_at: order.delivery.scheduled_at || null,
          status: order.delivery.status || null,
          // <-- pickup_window ditambahkan di sini (safe check)
          pickup_window: order.delivery.pickup_window
            ? {
                from: order.delivery.pickup_window.from || null,
                to: order.delivery.pickup_window.to || null
              }
            : null
        }
      : null
  };

  return res.status(200).json({ success: true, order: slim });
});

// Ringkasan per layanan
exports.orderDeliveryCounts = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const { start, end } = getRangeFromQuery(req.query);

  const pipeline = [
    {
      $match: {
        placed_at: { $gte: start, $lte: end }
      }
    },
    // normalisasi mode delivery
    {
      $addFields: {
        delivery_mode: {
          $let: {
            vars: {
              dm: { $ifNull: ['$delivery.mode', null] },
              ft: { $ifNull: ['$fulfillment_type', null] }
            },
            in: {
              $cond: [
                { $and: [{ $ne: ['$$dm', null] }, { $ne: ['$$dm', ''] }] },
                '$$dm',
                {
                  $cond: [
                    { $eq: ['$$ft', 'dine_in'] },
                    'none',
                    {
                      $cond: [{ $eq: ['$$ft', 'delivery'] }, 'delivery', 'none']
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    },
    // hitung per-order: base grand_total, top-level discounts, dan total discounts dari discounts[] (mis. voucher/promo)
    {
      $addFields: {
        _perOrderTopLevelDiscounts: {
          $add: [
            { $ifNull: ['$items_discount', 0] },
            { $ifNull: ['$shipping_discount', 0] }
          ]
        },
        _perOrderDiscountsArrayTotal: {
          $reduce: {
            input: { $ifNull: ['$discounts', []] },
            initialValue: 0,
            in: {
              $add: ['$$value', { $ifNull: ['$$this.amountTotal', 0] }]
            }
          }
        }
      }
    },
    // group by mode: count, sum grand_total, sum all discounts (top-level + array)
    {
      $group: {
        _id: '$delivery_mode',
        count: { $sum: 1 },
        grand_total_sum: { $sum: { $ifNull: ['$grand_total', 0] } },
        discounts_sum: {
          $sum: {
            $add: [
              '$_perOrderTopLevelDiscounts',
              '$_perOrderDiscountsArrayTotal'
            ]
          }
        }
      }
    }
  ];

  const agg = await Order.aggregate(pipeline).allowDiskUse(true);

  const map = {
    none: {
      count: 0,
      grand_total: 0,
      discounts: 0,
      grand_total_including_discounts: 0
    },
    delivery: {
      count: 0,
      grand_total: 0,
      discounts: 0,
      grand_total_including_discounts: 0
    },
    pickup: {
      count: 0,
      grand_total: 0,
      discounts: 0,
      grand_total_including_discounts: 0
    }
  };

  let totalCount = 0;
  let totalGrand = 0;
  let totalDiscounts = 0;

  for (const r of agg) {
    const key = String(r._id || 'none');
    const cnt = Number(r.count || 0);
    const gsum = Number(r.grand_total_sum || 0);
    const dsum = Number(r.discounts_sum || 0);

    if (!map[key]) {
      map[key] = {
        count: 0,
        grand_total: 0,
        discounts: 0,
        grand_total_including_discounts: 0
      };
    }

    map[key].count = cnt;
    map[key].grand_total = gsum;
    map[key].discounts = dsum;
    map[key].grand_total_including_discounts = gsum + dsum;

    totalCount += cnt;
    totalGrand += gsum;
    totalDiscounts += dsum;
  }

  const total = {
    count: totalCount,
    grand_total: totalGrand,
    discounts: totalDiscounts,
    grand_total_including_discounts: totalGrand + totalDiscounts
  };

  res.json({
    period: { start, end },
    counts: {
      none: map.none,
      delivery: map.delivery,
      pickup: map.pickup,
      total
    }
  });
});

//  list member
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
    id: r._id,
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

// Dashboard
exports.memberDashboard = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);

  const now = dayjs();
  const startToday = now.startOf('day').toDate();
  const start7Days = now.subtract(7, 'day').startOf('day').toDate();
  const startMonth = now.startOf('month').toDate();

  const [total, male, female, newToday, new7days, newThisMonth] =
    await Promise.all([
      Member.countDocuments({}),
      Member.countDocuments({ gender: 'male' }),
      Member.countDocuments({ gender: 'female' }),
      Member.countDocuments({ createdAt: { $gte: startToday } }),
      Member.countDocuments({ createdAt: { $gte: start7Days } }),
      Member.countDocuments({ createdAt: { $gte: startMonth } })
    ]);

  res.json({
    success: true,
    summary: {
      total,
      male,
      female,
      new_today: newToday,
      new_last_7_days: new7days,
      new_this_month: newThisMonth
    }
  });
});

exports.getMemberFullDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throwError('Member ID tidak valid', 400);
  }

  const member = await Member.findById(id).lean();
  if (!member) throwError('Member tidak ditemukan', 404);

  // ===========================
  //   AGGREGATE ORDER MEMBER
  // ===========================
  const orders = await Order.aggregate([
    {
      $match: {
        member: new mongoose.Types.ObjectId(id),
        payment_status: 'verified'
      }
    },
    {
      $project: {
        transaction_code: 1,
        fulfillment_type: 1,
        'delivery.mode': 1,
        payment_status: 1,
        status: 1,
        placed_at: 1,
        paid_at: 1,
        items_discount: 1,
        shipping_discount: 1
      }
    }
  ]);

  const totalTransaksi = orders.length;

  const firstTransaction = orders.length
    ? orders.reduce((a, b) => (a.paid_at < b.paid_at ? a : b)).paid_at
    : null;

  const lastTransaction = orders.length
    ? orders.reduce((a, b) => (a.paid_at > b.paid_at ? a : b)).paid_at
    : null;

  // total diskon yang didapat (top-level)
  const totalDiskon = orders.reduce(
    (sum, o) => sum + (o.items_discount || 0) + (o.shipping_discount || 0),
    0
  );

  // rincian fulfillment
  const summaryFulfillment = {
    dine_in: 0,
    delivery: 0,
    pickup: 0,
    none: 0
  };

  orders.forEach((o) => {
    const mode =
      o.delivery?.mode ||
      (o.fulfillment_type === 'dine_in'
        ? 'dine_in'
        : o.fulfillment_type === 'delivery'
        ? 'delivery'
        : 'none');

    if (summaryFulfillment[mode] !== undefined) {
      summaryFulfillment[mode]++;
    } else {
      summaryFulfillment.none++;
    }
  });

  // ===========================
  //   RECENT 50 ORDERS
  // ===========================
  const recentOrders = await Order.find({ member: id })
    .sort({ placed_at: -1 })
    .limit(50)
    .select({
      transaction_code: 1,
      placed_at: 1,
      status: 1,
      payment_status: 1,
      'delivery.mode': 1
    })
    .lean();

  // ===========================
  //   FINAL RESPONSE (CLEAN)
  // ===========================
  res.json({
    member_profile: {
      id: member._id,
      name: member.name,
      phone: member.phone,
      gender: member.gender,
      createdAt: member.createdAt,
      birthday: member.birthday,
      address: member.address,

      // loyalty
      points: member.points || 0,
      spend_total: member.total_spend || 0,
      spend_point_total: member.spend_point_total || 0,
      visit_count: member.visit_count || 0,
      last_visit_at: member.last_visit_at || null
    },

    transaction_stats: {
      total_transaction: totalTransaksi,
      first_transaction: firstTransaction,
      last_transaction: lastTransaction,
      total_discount: totalDiskon,
      fulfillment_breakdown: summaryFulfillment
    },

    recent_orders: recentOrders
  });
});

// Top spender bulan ini
exports.topSpendersThisMonth = asyncHandler(async (req, res) => {
  if (!req.user) throwError('Unauthorized', 401);
  const limit = Math.min(asInt(req.query.limit, 50), 200);

  const start = dayjs().startOf('month').toDate();
  const end = dayjs().endOf('month').toDate();

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
    { $unwind: { path: '$member', preserveNullAndEmptyArrays: false } },
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
  ]).allowDiskUse(true);

  res.json({
    period: {
      start,
      end
    },
    total: rows.length,
    items: rows
  });
});

// Top menu
exports.bestSeller = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  // Ambil seluruh menu
  const allMenus = await Menu.find({}).select({ _id: 1, name: 1 }).lean();

  // Agregasi penjualan menu
  const agg = await Order.aggregate([
    {
      $match: {
        payment_status: 'verified',
        paid_at: { $gte: start, $lte: end }
      }
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.menu',
        name: { $last: '$items.name' },
        total_qty: { $sum: '$items.quantity' },
        total_sales: { $sum: '$items.line_subtotal' }
      }
    }
  ]);

  // Map hasil agar mudah di-join
  const soldMap = new Map();
  agg.forEach((r) => {
    soldMap.set(String(r._id), r);
  });

  // Gabungkan dengan semua menu, tampilkan juga yang tidak laku
  const final = allMenus.map((m) => {
    const sold = soldMap.get(String(m._id));
    return {
      menu_id: m._id,
      name: m.name,
      total_qty: sold ? sold.total_qty : 0,
      total_sales: sold ? sold.total_sales : 0
    };
  });

  // Urutkan berdasarkan qty dari yang paling laku ke tidak
  final.sort((a, b) => b.total_qty - a.total_qty);

  res.json({
    period: { start, end },
    total: final.length,
    items: final
  });
});

// List pengeluaran grafik (belum)

// Laba rugi
exports.profitLoss = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  // ----------------- ORDER / OMZET -----------------
  const [orderAgg] = await Order.aggregate([
    {
      $match: {
        payment_status: 'verified',
        paid_at: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: null,
        omzet: { $sum: { $ifNull: ['$grand_total', 0] } }
      }
    }
  ]);

  const grand_total = Number(orderAgg?.omzet || 0);

  // ----------------- EXPENSE -----------------
  const [expenseAgg] = await Expense.aggregate([
    {
      $match: {
        date: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: null,
        expense_total: { $sum: { $ifNull: ['$amount', 0] } }
      }
    }
  ]);

  const expense_total = Number(expenseAgg?.expense_total || 0);

  const profit_loss = grand_total - expense_total;

  res.json({
    period: { start, end },
    grand_total,
    expense_total,
    profit_loss
  });
});

// ---------------------- Grafik --------------------------------

// pertumbuhan member
exports.customerGrowth = asyncHandler(async (req, res) => {
  const { start, end } = getRangeFromQuery(req.query);

  const gender =
    req.query.gender === 'male' || req.query.gender === 'female'
      ? req.query.gender
      : null;

  const match = {
    createdAt: { $gte: start, $lte: end }
  };

  if (gender) match.gender = gender;

  // ambil data sesuai filter gender (untuk chart utama)
  const rows = await Member.find(match).select('createdAt gender').lean();

  // ambil semua gender di periode (untuk breakdown per hari)
  const allGenderRows = await Member.find({
    createdAt: { $gte: start, $lte: end }
  })
    .select('createdAt gender')
    .lean();

  // hitung total gender global periode
  const maleCount = allGenderRows.filter((x) => x.gender === 'male').length;
  const femaleCount = allGenderRows.filter((x) => x.gender === 'female').length;

  // bikin range hari
  const days = [];
  const cur = new Date(start);

  while (cur <= end) {
    const key = cur.toISOString().substring(0, 10);
    days.push({ key, count: 0, male: 0, female: 0 });
    cur.setDate(cur.getDate() + 1);
  }

  // hitung breakdown per hari (tanpa filter gender)
  for (const m of allGenderRows) {
    const d = m.createdAt.toISOString().substring(0, 10);
    const bucket = days.find((x) => x.key === d);
    if (bucket) {
      bucket.count++;
      if (m.gender === 'male') bucket.male++;
      if (m.gender === 'female') bucket.female++;
    }
  }

  res.json({
    period: { start, end },
    gender_filter: gender || 'all',
    items: days, // tiap hari: key, count, male, female
    total: rows.length, // total row sesuai filter gender
    gender_stats: {
      male: maleCount,
      female: femaleCount
    }
  });
});
