// controllers/socket/socketBus.js
let ioRef = null;
function setIO(io) {
  ioRef = io;
}
const rooms = {
  member: (id) => `member:${id}`,
  staff: 'staff',
  table: (no) => `table:${no}`
};
function safeEmit(room, event, payload) {
  if (!ioRef || !room) return;
  ioRef.to(room).emit(event, payload);
}
function emitToMember(memberId, event, payload) {
  if (!memberId) return;
  safeEmit(rooms.member(memberId), event, payload);
}
function emitToStaff(event, payload) {
  safeEmit(rooms.staff, event, payload);
}
function emitToTable(tableNumber, event, payload) {
  if (!tableNumber) return;
  safeEmit(rooms.table(tableNumber), event, payload);
}

module.exports = { setIO, emitToMember, emitToStaff, emitToTable, rooms };
