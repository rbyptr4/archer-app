// controllers/socket/socketBus.js
// Simple socket bus wrapper untuk project (setIO/getIO + emit helpers)
// Tidak melakukan persistence — hanya emit ke room yang sesuai.
// Pastikan socketInit memanggil setIO(io) saat inisialisasi.

let _io = null;

/**
 * rooms object:
 * - staff: room untuk owner/staff global
 * - cashier: room untuk semua cashier -> 'role:cashier'
 * - kitchen: room untuk semua kitchen -> 'role:kitchen'
 * - courier: function(userId) -> personal courier room 'courier:<userId>'
 * - guest: function(guestToken) -> guest room 'guest:<token>'
 * - member: function(memberId) -> member room 'member:<id>'
 *
 * Jika ingin ubah naming convention, ubah di sini saja.
 */
const rooms = {
  staff: 'staff',
  cashier: 'role:cashier',
  kitchen: 'role:kitchen',
  courier: (id) => `courier:${id}`,
  guest: (token) => `guest:${token}`,
  member: (id) => `member:${id}`
};

function setIO(io) {
  if (!io || typeof io !== 'object') {
    throw new Error('setIO: invalid io instance');
  }
  _io = io;
  // attach shorthand helpers to io for convenience (optional)
  try {
    _io.emitToRole = emitToRole;
    _io.emitToCourier = emitToCourier;
    _io.emitToMember = emitToMember;
    _io.emitToGuest = emitToGuest;
    _io.emitOrdersStream = emitOrdersStream;
  } catch (e) {
    // ignore if can't attach
  }
}

function getIO() {
  if (!_io)
    throw new Error(
      'Socket IO not initialized. Call setIO(io) from socketInit first.'
    );
  return _io;
}

/* ---------------------------
   Room helper
   --------------------------- */
function resolveRoom(roomKeyOrFnOrValue, arg) {
  if (typeof roomKeyOrFnOrValue === 'function') {
    return roomKeyOrFnOrValue(arg);
  }
  return roomKeyOrFnOrValue;
}

/* ---------------------------
   Emit helpers (ephemeral)
   --------------------------- */

/**
 * Emit to a role room (e.g. 'cashier' -> rooms.cashier)
 * - role: 'cashier'|'kitchen'|'owner'|'staff'|'courier' (when courier, prefer emitToCourier)
 * - event: string
 * - payload: any
 */
function emitToRole(role, event, payload = {}) {
  try {
    const io = getIO();
    const roomDef = rooms[role] || `role:${role}`;
    const room = resolveRoom(roomDef);
    io.to(room).emit(event, payload);
    return true;
  } catch (e) {
    // don't crash caller, but surface debug info
    console.error(
      '[socketBus][emitToRole] failed',
      role,
      event,
      e?.message || e
    );
    return false;
  }
}

/**
 * Emit to courier personal room
 * - userId: string
 */
function emitToCourier(userId, event, payload = {}) {
  try {
    const io = getIO();
    const room = resolveRoom(rooms.courier, userId);
    io.to(room).emit(event, payload);
    return true;
  } catch (e) {
    console.error(
      '[socketBus][emitToCourier] failed',
      userId,
      event,
      e?.message || e
    );
    return false;
  }
}

/**
 * Emit to a member (logged-in) room
 */
function emitToMember(memberId, event, payload = {}) {
  try {
    const io = getIO();
    const room = resolveRoom(rooms.member, memberId);
    io.to(room).emit(event, payload);
    return true;
  } catch (e) {
    console.error(
      '[socketBus][emitToMember] failed',
      memberId,
      event,
      e?.message || e
    );
    return false;
  }
}

/**
 * Emit to guest room (by guest token)
 */
function emitToGuest(guestToken, event, payload = {}) {
  try {
    const io = getIO();
    const room = resolveRoom(rooms.guest, guestToken);
    io.to(room).emit(event, payload);
    return true;
  } catch (e) {
    console.error(
      '[socketBus][emitToGuest] failed',
      guestToken,
      event,
      e?.message || e
    );
    return false;
  }
}

/* ---------------------------
   Orders stream helper
   - untuk page list realtime: emit action: 'insert'|'update'|'remove' ke role room
   - action: string, item: object (summary)
   --------------------------- */
function emitOrdersStream({
  target = 'cashier',
  action = 'insert',
  item = null,
  meta = {}
} = {}) {
  try {
    const io = getIO();
    const room = resolveRoom(rooms[target] || `role:${target}`);
    io.to(room).emit('orders:stream', { action, item, meta });
    return true;
  } catch (e) {
    console.error(
      '[socketBus][emitOrdersStream] failed',
      target,
      action,
      e?.message || e
    );
    return false;
  }
}

/* ---------------------------
   Convenience aliases
   --------------------------- */
function emitToCashier(event, payload) {
  return emitToRole('cashier', event, payload);
}
function emitToKitchen(event, payload) {
  return emitToRole('kitchen', event, payload);
}
function emitToStaff(event, payload) {
  return emitToRole('staff', event, payload);
}
function emitToOwner(event, payload) {
  return emitToRole('owner', event, payload);
}

/* ---------------------------
   Utility: safeEmit (when io might be missing)
   - returns boolean success
   --------------------------- */
function safeEmit(room, event, payload = {}) {
  try {
    const io = getIO();
    io.to(room).emit(event, payload);
    return true;
  } catch (e) {
    console.warn(
      '[socketBus][safeEmit] io not ready or emit failed',
      room,
      event
    );
    return false;
  }
}

/* ---------------------------
   Exports
   --------------------------- */
module.exports = {
  // lifecycle
  setIO,
  getIO,

  // rooms (export reference so other modules can use)
  rooms,

  // basic emits
  emitToRole,
  emitToCourier,
  emitToMember,
  emitToGuest,

  // orders stream
  emitOrdersStream,

  // convenience
  emitToCashier,
  emitToKitchen,
  emitToStaff,
  emitToOwner,

  // safe emit
  safeEmit
};
