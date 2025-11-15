// controllers/socket/emitHelpers.js
const {
  emitToCashier,
  emitToKitchen,
  emitToCourier,
  emitToMember,
  emitToGuest
} = require('./socketBus');

/**
 * Buat ringkasan order yang mirror shape listOrders (supaya FE bisa auto-merge)
 */
function makeOrderSummary(orderDoc) {
  if (!orderDoc) return null;
  // note: orderDoc mungkin Mongoose doc / plain object
  const o = orderDoc;
  const member =
    (o.member && (typeof o.member === 'object' ? o.member : null)) || null;

  return {
    id: String(o._id),
    transaction_code: o.transaction_code || '',
    delivery_mode:
      (o.delivery && o.delivery.mode) ||
      o.delivery?.mode ||
      (o.fulfillment_type === 'dine_in' ? 'none' : 'delivery'),
    grand_total: Number(o.grand_total || 0),
    fulfillment_type: o.fulfillment_type || null,
    customer_name: (member && member.name) || o.customer_name || '',
    customer_phone: (member && member.phone) || o.customer_phone || '',
    placed_at: o.placed_at || o.createdAt || new Date().toISOString(),
    table_number:
      o.fulfillment_type === 'dine_in' ? o.table_number || null : null,
    payment_status: o.payment_status || null,
    status: o.status || null,
    total_quantity: Number(o.total_quantity || 0),
    pickup_window:
      o.delivery && o.delivery.pickup_window
        ? {
            from: o.delivery.pickup_window.from || null,
            to: o.delivery.pickup_window.to || null
          }
        : null,
    delivery_slot_label: o.delivery ? o.delivery.slot_label || null : null,
    member_id: member ? String(member._id) : o.member ? String(o.member) : null
  };
}

/**
 * Dipanggil setelah order dibuat (checkout / POS / webhook)
 * Perubahan: order:new hanya ke cashier (kasir), kitchen/kurir punya event masing2 nanti.
 */
async function afterCreateOrderEmit(orderDoc) {
  try {
    const payload = makeOrderSummary(orderDoc);

    // Hanya kasir yang dapat 'order:new'
    emitToCashier('order:new', payload);

    // Jika delivery dengan courier yang sudah assigned -> emit ke courier assignment event
    if (
      orderDoc.fulfillment_type === 'delivery' &&
      orderDoc.delivery &&
      orderDoc.delivery.courier &&
      (orderDoc.delivery.courier.user || orderDoc.delivery.courier.id)
    ) {
      const courierId = String(
        orderDoc.delivery.courier.user || orderDoc.delivery.courier.id
      );
      emitToCourier(courierId, 'order:assign:courier', payload);
    }

    // Emit ke member/guest agar UI mereka dapat notifikasi 'order:created'
    if (orderDoc.member)
      emitToMember(String(orderDoc.member), 'order:created', payload);
    if (orderDoc.guestToken)
      emitToGuest(orderDoc.guestToken, 'order:created', payload);
  } catch (err) {
    // jangan throw — hanya log
    console.error('[afterCreateOrderEmit] failed', err?.message || err);
  }
}

module.exports = { afterCreateOrderEmit, makeOrderSummary };
