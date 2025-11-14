// controllers/socket/socketInit.js
const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const User = require('../../models/userModel');
const Order = require('../../models/orderModel');
const GuestSession = require('../../models/guestSessionModel');
const { setIO, rooms } = require('./socketBus');

const {
  ACCESS_COOKIE: MEMBER_ACCESS_COOKIE
} = require('../../utils/memberToken');

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
  // fallback dev
  if (!list.length) list.push('http://localhost:3000', 'http://127.0.0.1:3000');
  // juga tambah alamat FE yang biasa dipakai di projectmu
  const defaults = [
    process.env.APP_URL || 'https://archer-app.vercel.app',
    'http://localhost:5173'
  ];
  return Array.from(new Set(list.concat(defaults)));
}

async function resolveStaffFromCookie(cookies) {
  try {
    const token = cookies.accessToken;
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;
    const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const userId = String(payload.sub || payload.id || '');
    if (!userId) return null;
    const user = await User.findById(userId).select('role pages name').lean();
    if (!user) return null;
    const pages =
      user.pages instanceof Map
        ? Object.fromEntries(user.pages)
        : user.pages || {};
    return {
      id: String(user._id),
      role: user.role,
      pages,
      name: user.name || ''
    };
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

function normalizeCookies(socket) {
  return cookie.parse(socket.handshake.headers.cookie || '');
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

function initSocket(httpServer) {
  const allowedOrigins = parseAllowedOrigins();

  const io = new Server(httpServer, {
    cors: {
      // gunakan fungsi agar bisa cek daftar dynamic
      origin(origin, cb) {
        // ketika origin === undefined (mis. SSR / same-origin non-browser), izinkan
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS (socket): ' + origin));
      },
      // samakan dengan app.js
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
    // mulai dari polling lalu upgrade ke websocket (lebih robust di proxy seperti Railway)
    transports: ['polling', 'websocket'],
    allowEIO3: true
  });

  // simpan reference
  setIO(io);

  // Optional: bantu debug handshake failure (log awal)
  io.use((socket, next) => {
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
    return next();
  });

  io.on('connection', async (socket) => {
    try {
      console.log('[socket] connected:', socket.id, 'handshake:', {
        origin: socket.handshake.headers.origin,
        url: socket.handshake.url
      });
    } catch (e) {}

    const cookies = normalizeCookies(socket);

    // Member via cookie/token
    try {
      const rawMemberJwt = cookies[MEMBER_ACCESS_COOKIE] || cookies.memberToken;
      if (rawMemberJwt) {
        const m = verifyMemberAccessJWT(rawMemberJwt);
        if (m?.id) socket.join(rooms.member(m.id));
      }
    } catch {
      // ignore
    }

    // Staff resolve
    const staff = await resolveStaffFromCookie(cookies);
    if (
      staff &&
      (staff.role === 'owner' ||
        staff.role === 'employee' ||
        staff.role === 'courier')
    ) {
      socket.join(rooms.staff);
      if (staff.role === 'owner' || staff.pages?.cashier === true)
        socket.join(rooms.cashier);
      if (staff.role === 'owner' || staff.pages?.kitchen === true)
        socket.join(rooms.kitchen);
      if (staff.role === 'courier' || staff.pages?.courier === true)
        socket.join(rooms.courier(staff.id));
    }

    // welcome
    try {
      const who = staff && staff.name ? staff.name : 'Pengguna';
      socket.emit('system:welcome', {
        msg: `Selamat datang, ${who}`,
        serverTime: new Date().toISOString()
      });
    } catch {}

    // guest join
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

        socket.join(rooms.guest(token));
        if (typeof ack === 'function') ack({ ok: true });

        // emit initial orders (bounded)
        try {
          const limit = 30;
          const orders = await Order.find({ guestToken: token })
            .sort({ placed_at: -1 })
            .limit(limit)
            .lean();
          if (Array.isArray(orders) && orders.length) {
            const items = orders.map(toOrderSummary);
            socket.emit('orders:initial', { items });
          }
        } catch (emitErr) {
          console.error(
            '[join:guest][orders:initial] emit failed',
            emitErr?.message || emitErr
          );
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
        socket.leave(rooms.guest(token));
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: 'failed' });
      }
    });

    socket.on('join:member', (payload, ack) => {
      try {
        const memberId = payload && payload.memberId;
        if (!memberId)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'memberId required' })
            : null;
        socket.join(rooms.member(memberId));
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: 'failed' });
      }
    });
  });

  return io;
}

module.exports = { initSocket };
