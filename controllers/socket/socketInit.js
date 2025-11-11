// socket/initSocket.js
const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const User = require('../../models/userModel');
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
  if (!list.length) list.push('http://localhost:3000', 'http://127.0.0.1:3000');
  return Array.from(new Set(list));
}

async function resolveStaffFromCookie(cookies) {
  try {
    const token = cookies.accessToken;
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;
    const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const userId = String(payload.sub || payload.id || '');
    if (!userId) return null;

    // ambil field yang perlu saja; jangan andalkan courierId di model
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
      // catatan: tidak lagi mengembalikan courierId
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

function initSocket(httpServer) {
  const allowedOrigins = parseAllowedOrigins();
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Not allowed by CORS (socket): ${origin}`));
      },
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  setIO(io);

  io.on('connection', async (socket) => {
    const cookies = normalizeCookies(socket);

    // ===== Member (customer) via cookie/token =====
    try {
      const rawMemberJwt = cookies[MEMBER_ACCESS_COOKIE] || cookies.memberToken;
      if (rawMemberJwt) {
        const m = verifyMemberAccessJWT(rawMemberJwt);
        if (m?.id) socket.join(rooms.member(m.id));
      }
    } catch {
      // ignore
    }

    // ===== Staff: owner / employee / kurir =====
    const staff = await resolveStaffFromCookie(cookies);
    if (
      staff &&
      (staff.role === 'owner' ||
        staff.role === 'employee' ||
        staff.role === 'courier')
    ) {
      // join global staff room (opsional)
      socket.join(rooms.staff);

      // join room kasir bila punya akses
      if (staff.role === 'owner' || staff.pages?.cashier === true) {
        socket.join(rooms.cashier);
      }

      // join room kitchen bila punya akses
      if (staff.role === 'owner' || staff.pages?.kitchen === true) {
        socket.join(rooms.kitchen);
      }

      // --- refactor courier join:
      // sebelumnya pakai user.courierId; sekarang kita join courier room berdasarkan user._id
      // Syarat join: user memiliki halaman/akses courier (pages.courier === true) atau role === 'courier'
      if (staff.role === 'courier' || staff.pages?.courier === true) {
        // rooms.courier expects an id string; gunakan staff.id (user._id)
        socket.join(rooms.courier(staff.id));
      }
    }

    // ===== welcome =====
    try {
      const who = staff && staff.name ? staff.name : 'Pengguna';
      socket.emit('system:welcome', {
        msg: `Selamat datang, ${who}`,
        serverTime: new Date().toISOString()
      });
    } catch {
      // ignore
    }

    // ===== Handlers: guest / member join via event =====
    socket.on('join:guest', async (payload, ack) => {
      try {
        const token = payload && payload.guestToken;
        if (!token)
          return typeof ack === 'function'
            ? ack({ ok: false, error: 'guestToken required' })
            : null;
        socket.join(rooms.guest(token));
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
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
