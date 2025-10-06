// socket/initSocket.js
const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const User = require('../../models/userModel');
const { setIO, rooms } = require('./socketBus');

async function resolveStaffFromCookie(cookies) {
  try {
    const token = cookies.accessToken;
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;
    const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const userId = String(payload.sub || payload.id || '');
    if (!userId) return null;

    const user = await User.findById(userId).select('role pages').lean();
    if (!user) return null;

    const pages =
      user.pages instanceof Map
        ? Object.fromEntries(user.pages)
        : user.pages || {};
    return { id: String(user._id), role: user.role, pages };
  } catch (_) {
    return null;
  }
}

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: [process.env.FRONTEND_URL || process.env.FE_URL],
      credentials: true
    }
  });

  setIO(io);

  io.on('connection', async (socket) => {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');

    // ====== Member room (opsional) ======
    try {
      if (cookies.memberToken && process.env.MEMBER_TOKEN_SECRET) {
        const m = jwt.verify(
          cookies.memberToken,
          process.env.MEMBER_TOKEN_SECRET
        );
        if (m?.id) socket.join(rooms.member(m.id));
      }
    } catch (_) {}

    // ====== Staff & Kitchen ======
    const staff = await resolveStaffFromCookie(cookies);
    if (staff && (staff.role === 'owner' || staff.role === 'employee')) {
      socket.join(rooms.staff);
      if (staff.role === 'owner' || staff.pages?.kitchen === true) {
        socket.join('kitchen'); // room dapur
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
