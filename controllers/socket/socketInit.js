// controllers/socket/socketInit.js
const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const User = require('../../models/userModel');
const Order = require('../../models/orderModel');
const GuestSession = require('../../models/guestSessionModel');
const socketBus = require('./socketBus'); // expects: { setIO, getIO, rooms, emitToRole, emitToCourier, emitToMember, emitToGuest }
const { setIO, rooms } = socketBus;

// konfigurasi lookback (ms)
const DEFAULT_MISSED_LOOKBACK_MS = Number(
  process.env.SOCKET_MISSED_LOOKBACK_MS || 3 * 60 * 60 * 1000
); // default 3 jam

function parseAllowedOrigins() {
  const single = process.env.APP_URL || '';
  const multi = process.env.FRONTEND_URLS || '';
  const list = [].concat(single ? [single] : []).concat(
    multi
      ? multi
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  );
  if (!list.length) list.push('http://localhost:3000', 'http://127.0.0.1:3000');
  const defaults = [
    process.env.APP_URL || 'https://archer-app.vercel.app',
    'http://localhost:5173'
  ];
  return Array.from(new Set(list.concat(defaults)));
}

function normalizeCookies(socket) {
  return cookie.parse(socket.handshake.headers.cookie || '');
}

async function resolveStaffFromCookie(cookies) {
  try {
    const token = cookies.accessToken;
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;
    const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const userId = String(payload.sub || payload.id || '');
    if (!userId) return null;
    const user = await User.findById(userId).select('role name').lean();
    if (!user) return null;
    return { id: String(user._id), role: user.role, name: user.name || '' };
  } catch {
    return null;
  }
}

function verifyMemberAccessJWT(raw) {
  const secrets = [
    process.env.MEMBER_ACCESS_SECRET,
    process.env.MEMBER_TOKEN_SECRET
  ].filter(Boolean);
  for (const sec of secrets) {
    try {
      const p = jwt.verify(raw, sec);
      const memberId = String(p.sub || p.id || p.memberId || '');
      if (memberId) return { id: memberId };
    } catch {}
  }
  return null;
}

function toOrderSummary(orderDoc) {
  if (!orderDoc) return null;
  return {
    id: String(orderDoc._id),
    transaction_code: orderDoc.transaction_code || null,
    fulfillment_type: orderDoc.fulfillment_type || null,
    table_number: orderDoc.table_number ?? null,
    placed_at: orderDoc.placed_at
      ? new Date(orderDoc.placed_at).toISOString()
      : orderDoc.createdAt
      ? new Date(orderDoc.createdAt).toISOString()
      : null,
    items_preview: Array.isArray(orderDoc.items)
      ? orderDoc.items
          .slice(0, 3)
          .map((i) => ({ name: i.name, qty: i.quantity }))
      : [],
    total_quantity:
      orderDoc.total_quantity ??
      (Array.isArray(orderDoc.items)
        ? orderDoc.items.reduce((s, it) => s + (it.quantity || 0), 0)
        : 0),
    items_total: orderDoc.items_subtotal || 0,
    grand_total: orderDoc.grand_total || 0,
    payment_status: orderDoc.payment_status || 'unpaid',
    status: orderDoc.status || 'created',
    delivery: orderDoc.delivery || null,
    member: orderDoc.member
      ? {
          id: String(orderDoc.member),
          name: orderDoc.customer_name || null,
          phone: orderDoc.customer_phone || null
        }
      : null,
    guestToken: orderDoc.guestToken || null
  };
}

/**
 * Bangun dan kirim batch "missed" berdasarkan data Order (tidak menyimpan notif ke DB).
 * - roles: array of roles to evaluate (e.g. ['cashier'])
 * - options: { courierUserId, lookbackMs }
 */
async function emitMissedOrdersOnJoin(socket, roles = [], options = {}) {
  try {
    const lookbackMs = Number(options.lookbackMs || DEFAULT_MISSED_LOOKBACK_MS);
    const since = new Date(Date.now() - lookbackMs);

    for (const role of roles) {
      if (role === 'cashier') {
        const q = { status: 'created', createdAt: { $gte: since } };
        const count = await Order.countDocuments(q);
        const raw = await Order.find(q)
          .select(
            'transaction_code grand_total placed_at payment_status total_quantity fulfillment_type guestToken member createdAt'
          )
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();
        const items = raw.map((o) => ({
          id: String(o._id),
          transaction_code: o.transaction_code || '',
          placed_at: o.placed_at || o.createdAt || null,
          payment_status: o.payment_status || null,
          fulfillment_type: o.fulfillment_type || null,
          total_quantity: Number(o.total_quantity || 0),
          grand_total: Number(o.grand_total || 0),
          member: o.member ? String(o.member) : null,
          guestToken: o.guestToken || null
        }));
        socket.emit('notifications:batch', {
          targetType: 'role',
          target: 'cashier',
          count,
          message:
            count > 0
              ? `${count} pesanan masuk selama Anda offline (${Math.round(
                  lookbackMs / 1000 / 60
                )} menit terakhir). Silakan cek halaman pesanan.`
              : 'Tidak ada pesanan baru dalam periode ini.',
          items
        });
      } else if (role === 'kitchen') {
        const q = {
          status: 'accepted',
          payment_status: 'verified',
          placed_at: { $gte: since }
        };
        const count = await Order.countDocuments(q);
        const raw = await Order.find(q)
          .select('transaction_code items placed_at total_quantity')
          .sort({ placed_at: 1 })
          .limit(50)
          .lean();
        const items = raw.map((o) => ({
          id: String(o._id),
          transaction_code: o.transaction_code || '',
          placed_at: o.placed_at || null,
          items: (o.items || [])
            .slice(0, 5)
            .map((it) => ({ name: it.name, qty: it.quantity })),
          total_quantity: Number(o.total_quantity || 0)
        }));
        socket.emit('notifications:batch', {
          targetType: 'role',
          target: 'kitchen',
          count,
          message:
            count > 0
              ? `${count} pesanan accepted saat Anda offline (${Math.round(
                  lookbackMs / 1000 / 60
                )} menit terakhir).`
              : 'Tidak ada pesanan kitchen dalam periode ini.',
          items
        });
      } else if (role === 'courier') {
        const baseQ = {
          fulfillment_type: 'delivery',
          status: { $nin: ['cancelled'] },
          'delivery.status': { $in: ['pending', 'assigned'] },
          placed_at: { $gte: since }
        };

        if (options.courierUserId) {
          const qAssigned = {
            ...baseQ,
            $or: [
              { 'delivery.courier.user': options.courierUserId },
              { 'delivery.courier.id': options.courierUserId },
              { 'delivery.courier.userId': options.courierUserId }
            ]
          };
          const count = await Order.countDocuments(qAssigned);
          const raw = await Order.find(qAssigned)
            .select(
              'transaction_code grand_total placed_at delivery.status customer_name customer_phone'
            )
            .sort({ placed_at: -1 })
            .limit(50)
            .lean();
          const items = raw.map((o) => ({
            id: String(o._id),
            transaction_code: o.transaction_code || '',
            placed_at: o.placed_at || null,
            delivery_status: o.delivery?.status || null,
            customer_name: o.customer_name || '',
            customer_phone: o.customer_phone || '',
            grand_total: Number(o.grand_total || 0)
          }));
          socket.emit('notifications:batch', {
            targetType: 'user',
            target: String(options.courierUserId),
            count,
            message:
              count > 0
                ? `${count} delivery relevan untuk Anda (${Math.round(
                    lookbackMs / 1000 / 60
                  )} menit terakhir).`
                : 'Tidak ada delivery relevan dalam periode ini.',
            items
          });
        } else {
          const count = await Order.countDocuments(baseQ);
          const raw = await Order.find(baseQ)
            .select('transaction_code grand_total placed_at delivery.status')
            .sort({ placed_at: -1 })
            .limit(50)
            .lean();
          const items = raw.map((o) => ({
            id: String(o._id),
            transaction_code: o.transaction_code || '',
            placed_at: o.placed_at || null,
            delivery_status: o.delivery?.status || null,
            grand_total: Number(o.grand_total || 0)
          }));
          socket.emit('notifications:batch', {
            targetType: 'role',
            target: 'courier',
            count,
            message:
              count > 0
                ? `${count} delivery pending/assigned selama Anda offline (${Math.round(
                    lookbackMs / 1000 / 60
                  )} menit terakhir).`
                : 'Tidak ada delivery dalam periode ini.',
            items
          });
        }
      } else if (role === 'owner') {
        const qCashier = { status: 'created', createdAt: { $gte: since } };
        const qKitchen = {
          status: 'accepted',
          payment_status: 'verified',
          placed_at: { $gte: since }
        };
        const qCourier = {
          fulfillment_type: 'delivery',
          status: { $nin: ['cancelled'] },
          'delivery.status': { $in: ['pending', 'assigned'] },
          placed_at: { $gte: since }
        };
        const [cCount, kCount, dCount] = await Promise.all([
          Order.countDocuments(qCashier),
          Order.countDocuments(qKitchen),
          Order.countDocuments(qCourier)
        ]);
        socket.emit('notifications:batch', {
          targetType: 'role',
          target: 'owner',
          counts: { cashier: cCount, kitchen: kCount, courier: dCount },
          message: `Ringkasan: ${cCount} created, ${kCount} kitchen, ${dCount} delivery pending/assigned (${Math.round(
            lookbackMs / 1000 / 60
          )} menit terakhir).`
        });
      } else {
        socket.emit('notifications:batch', {
          targetType: 'role',
          target: role,
          count: 0,
          items: []
        });
      }
    }
  } catch (e) {
    console.error('[emitMissedOrdersOnJoin] error', e?.message || e);
  }
}

function initSocket(httpServer) {
  const allowedOrigins = parseAllowedOrigins();

  const io = new Server(httpServer, {
    cors: {
      origin(origin, cb) {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS (socket): ' + origin));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'requiresAuth',
        'X-QR-Session',
        'X-Online-Session',
        'X-Table-Number',
        'X-Order-Source',
        'X-Device-Id',
        'X-Fulfillment-Type',
        'x-callback-token'
      ],
      credentials: true
    },
    transports: ['polling', 'websocket'],
    allowEIO3: true
  });

  // simpan reference ke socketBus
  try {
    setIO(io);
  } catch (e) {
    console.error('[socketInit] setIO failed', e?.message || e);
  }

  io.use((socket, next) => {
    // log handshake singkat
    try {
      const origin =
        socket.handshake.headers.origin ||
        socket.handshake.headers.referer ||
        'unknown';
      console.log(
        '[socket] handshake from origin:',
        origin,
        'cookies:',
        !!socket.handshake.headers.cookie
      );
    } catch (e) {}
    return next();
  });

  io.on('connection', async (socket) => {
    try {
      console.log(
        '[socket] connected:',
        socket.id,
        'url:',
        socket.handshake.url
      );
    } catch (e) {}

    const cookies = normalizeCookies(socket);

    // Member via cookie/token -> join member room
    try {
      const rawMemberJwt =
        cookies.memberToken ||
        cookies[process.env.ACCESS_COOKIE || 'accessToken'];
      if (rawMemberJwt) {
        const m = verifyMemberAccessJWT(rawMemberJwt);
        if (m?.id) {
          socket.join(
            typeof rooms.member === 'function'
              ? rooms.member(m.id)
              : rooms.member
          );
          // emit initial orders for member (bounded)
          try {
            const limit = 30;
            const orders = await Order.find({ member: m.id })
              .sort({ placed_at: -1 })
              .limit(limit)
              .lean();
            if (Array.isArray(orders) && orders.length) {
              socket.emit('orders:initial', {
                items: orders.map(toOrderSummary)
              });
            }
          } catch (e) {
            console.error('[member orders initial] ', e?.message || e);
          }
        }
      }
    } catch (e) {}

    // Staff resolve from cookie -> join role-based rooms
    const staff = await resolveStaffFromCookie(cookies).catch(() => null);
    if (
      staff &&
      ['owner', 'cashier', 'kitchen', 'courier'].includes(String(staff.role))
    ) {
      const role = String(staff.role);
      if (role === 'owner') {
        socket.join(
          typeof rooms.staff === 'function' ? rooms.staff() : rooms.staff
        );
        socket.join(
          typeof rooms.cashier === 'function' ? rooms.cashier() : rooms.cashier
        );
        socket.join(
          typeof rooms.kitchen === 'function' ? rooms.kitchen() : rooms.kitchen
        );
      } else if (role === 'cashier') {
        socket.join(
          typeof rooms.cashier === 'function' ? rooms.cashier() : rooms.cashier
        );
      } else if (role === 'kitchen') {
        socket.join(
          typeof rooms.kitchen === 'function' ? rooms.kitchen() : rooms.kitchen
        );
      } else if (role === 'courier') {
        socket.join(
          typeof rooms.courier === 'function'
            ? rooms.courier(staff.id)
            : rooms.courier
        );
      }

      // kirim batch rekonstruksi dari orders (3 jam default atau env)
      try {
        if (role === 'courier') {
          await emitMissedOrdersOnJoin(socket, [role], {
            courierUserId: staff.id,
            lookbackMs: DEFAULT_MISSED_LOOKBACK_MS
          });
        } else {
          await emitMissedOrdersOnJoin(socket, [role], {
            lookbackMs: DEFAULT_MISSED_LOOKBACK_MS
          });
        }
      } catch (e) {
        console.error('[socket][emitMissedOrdersOnJoin] ', e?.message || e);
      }
    }

    // guest join/leave
    socket.on('join:guest', async (payload, ack) => {
      try {
        const token = payload && payload.guestToken;
        if (!token)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'guestToken required' })
            : null;

        const session = await GuestSession.findOne({ token }).lean();
        if (!session)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'invalid_guest' })
            : null;
        if (session.expiresAt && new Date(session.expiresAt) < new Date())
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'expired' })
            : null;

        socket.join(
          typeof rooms.guest === 'function' ? rooms.guest(token) : rooms.guest
        );
        if (typeof ack === 'function') ack({ ok: true });

        // emit initial orders for guest
        try {
          const limit = 30;
          const orders = await Order.find({ guestToken: token })
            .sort({ placed_at: -1 })
            .limit(limit)
            .lean();
          if (Array.isArray(orders) && orders.length) {
            socket.emit('orders:initial', {
              items: orders.map(toOrderSummary)
            });
          }
        } catch (e) {
          console.error(
            '[join:guest][orders:initial] emit failed',
            e?.message || e
          );
        }

        // emit missed batch for guest (based on orders, e.g., assigned/delivery updates)
        try {
          // we can treat guest missed as delivery/assigned within lookback that relate to guestToken
          const since = new Date(Date.now() - DEFAULT_MISSED_LOOKBACK_MS);
          const q = { guestToken: token, placed_at: { $gte: since } };
          const raw = await Order.find(q)
            .select('transaction_code status placed_at delivery.status')
            .sort({ placed_at: -1 })
            .limit(50)
            .lean();
          socket.emit('notifications:batch', {
            targetType: 'guest',
            target: token,
            count: raw.length,
            items: raw.map((o) => ({
              id: String(o._id),
              message: `Update pesanan ${o.transaction_code || ''}`,
              orderId: String(o._id),
              meta: { status: o.status, delivery: o.delivery?.status || null },
              createdAt: o.placed_at || o.createdAt || null
            }))
          });
        } catch (e) {
          console.error('[join:guest][missed] ', e?.message || e);
        }
      } catch (err) {
        console.error('[join:guest] unexpected', err?.message || err);
        if (typeof ack === 'function') ack({ ok: false, error: 'failed' });
      }
    });

    socket.on('leave:guest', (payload, ack) => {
      try {
        const token = payload && payload.guestToken;
        if (!token)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'guestToken required' })
            : null;
        socket.leave(
          typeof rooms.guest === 'function' ? rooms.guest(token) : rooms.guest
        );
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: 'failed' });
      }
    });

    // join:member explicit (if FE wants to request)
    socket.on('join:member', async (payload, ack) => {
      try {
        const memberId = payload && payload.memberId;
        if (!memberId)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'memberId required' })
            : null;
        socket.join(
          typeof rooms.member === 'function'
            ? rooms.member(memberId)
            : rooms.member
        );
        if (typeof ack === 'function') ack({ ok: true });

        // emit initial orders for member
        try {
          const limit = 30;
          const orders = await Order.find({ member: memberId })
            .sort({ placed_at: -1 })
            .limit(limit)
            .lean();
          if (Array.isArray(orders) && orders.length) {
            socket.emit('orders:initial', {
              items: orders.map(toOrderSummary)
            });
          }
        } catch (e) {
          console.error('[join:member][orders:initial] ', e?.message || e);
        }
      } catch (e) {
        console.error('[join:member] ', e?.message || e);
        if (typeof ack === 'function') ack({ ok: false, error: 'failed' });
      }
    });

    // join role explicit (FE can request; server will verify cookie-role)
    socket.on('join:role', async (payload, ack) => {
      try {
        const role = String((payload && payload.role) || '').toLowerCase();
        if (!['cashier', 'kitchen', 'courier', 'owner'].includes(role))
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'invalid_role' })
            : null;

        const localStaff = await resolveStaffFromCookie(
          normalizeCookies(socket)
        );
        if (!localStaff || localStaff.role !== role)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'not_authorized' })
            : null;

        if (role === 'owner') {
          socket.join(
            typeof rooms.staff === 'function' ? rooms.staff() : rooms.staff
          );
          socket.join(
            typeof rooms.cashier === 'function'
              ? rooms.cashier()
              : rooms.cashier
          );
          socket.join(
            typeof rooms.kitchen === 'function'
              ? rooms.kitchen()
              : rooms.kitchen
          );
        } else if (role === 'cashier') {
          socket.join(
            typeof rooms.cashier === 'function'
              ? rooms.cashier()
              : rooms.cashier
          );
        } else if (role === 'kitchen') {
          socket.join(
            typeof rooms.kitchen === 'function'
              ? rooms.kitchen()
              : rooms.kitchen
          );
        } else if (role === 'courier') {
          socket.join(
            typeof rooms.courier === 'function'
              ? rooms.courier(localStaff.id)
              : rooms.courier
          );
        }

        // emit missed batch for that role/user
        if (role === 'courier') {
          await emitMissedOrdersOnJoin(socket, [role], {
            courierUserId: localStaff.id,
            lookbackMs: DEFAULT_MISSED_LOOKBACK_MS
          });
        } else {
          await emitMissedOrdersOnJoin(socket, [role], {
            lookbackMs: DEFAULT_MISSED_LOOKBACK_MS
          });
        }

        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        console.error('[join:role] error', e?.message || e);
        if (typeof ack === 'function') ack({ ok: false, error: 'failed' });
      }
    });

    // tidak ada system:welcome atau greeting otomatis — FE akan meng-handle UX sendiri
  });

  return io;
}

module.exports = { initSocket };
