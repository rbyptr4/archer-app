let ioRef = null;
function setIO(io) {
  ioRef = io;
}

const rooms = {
  staff: 'staff',
  // page-based rooms: 'page:<pageKey>'
  page: (pageKey) => `page:${pageKey}`,
  courier: (id) => `courier:${id}`,
  member: (id) => `member:${id}`,
  guest: (token) => `guest:${token}`
};

function safeEmit(room, event, payload) {
  if (!ioRef || !room) return;
  ioRef.to(room).emit(event, payload);
}

function emitToStaff(event, payload) {
  safeEmit(rooms.staff, event, payload);
}
function emitToPage(pageKey, event, payload) {
  if (!pageKey) return;
  safeEmit(rooms.page(pageKey), event, payload);
}
function emitToCourier(courierId, event, payload) {
  if (!courierId) return;
  safeEmit(rooms.courier(courierId), event, payload);
}
function emitToMember(memberId, event, payload) {
  if (!memberId) return;
  safeEmit(rooms.member(memberId), event, payload);
}
function emitToGuest(guestToken, event, payload) {
  if (!guestToken) return;
  safeEmit(rooms.guest(guestToken), event, payload);
}

module.exports = {
  setIO,
  rooms,
  emitToStaff,
  emitToPage,
  emitToCourier,
  emitToMember,
  emitToGuest
};
