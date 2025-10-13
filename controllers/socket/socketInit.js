// socket/initSocket.js
const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const User = require('../../models/userModel');
const { setIO, rooms } = require('./socketBus');

const {
  ACCESS_COOKIE: MEMBER_ACCESS_COOKIE // e.g. 'member_access'
} = require('../../utils/memberToken'); // pastikan path sesuai

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
  return Array.from(new Set(list));
}

async function resolveStaffFromCookie(cookies) {
  try {
    const token = cookies.accessToken; // staff cookie name (internal)
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
  // Back-compat: dukung dua skema secret:
  // - MEMBER_ACCESS_SECRET (baru, dari utils/memberToken)
  // - MEMBER_TOKEN_SECRET (lama)
  const secrets = [
    process.env.MEMBER_ACCESS_SECRET,
    process.env.MEMBER_TOKEN_SECRET
  ].filter(Boolean);

  for (const sec of secrets) {
    try {
      const p = jwt.verify(raw, sec);
      const memberId = String(p.sub || p.id || p.memberId || '');
      if (memberId) return { id: memberId };
    } catch {
      // try next secret
    }
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
      credentials: true,
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
        'X-Device-Id'
      ]
    },
    transports: ['websocket', 'polling']
  });

  setIO(io);

  io.on('connection', async (socket) => {
    const cookies = normalizeCookies(socket);

    // ===== Member room (pakai ACCESS_COOKIE yang baru, tapi dukung memberToken lama) =====
    try {
      const rawMemberJwt = cookies[MEMBER_ACCESS_COOKIE] || cookies.memberToken;
      if (rawMemberJwt) {
        const m = verifyMemberAccessJWT(rawMemberJwt);
        if (m?.id) socket.join(rooms.member(m.id));
      }
    } catch {
      // ignore
    }

    const staff = await resolveStaffFromCookie(cookies);
    if (staff && (staff.role === 'owner' || staff.role === 'employee')) {
      socket.join(rooms.staff);
      if (staff.role === 'owner' || staff.pages?.kitchen === true) {
        if (rooms.kitchen) socket.join(rooms.kitchen);
        else socket.join('kitchen');
      }
    }

    const tableNo = Number(socket.handshake.query.table);
    if (Number.isFinite(tableNo) && tableNo > 0) {
      socket.join(rooms.table(tableNo));
    }
  });

  return io;
}

module.exports = { initSocket };
