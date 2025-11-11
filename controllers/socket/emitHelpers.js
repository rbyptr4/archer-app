const {
  emitToCashier,
  emitToKitchen,
  emitToCourier,
  emitToMember,
  emitToGuest
} = require('./socketBus');

function makeOrderSummary(orderDoc) {
  return {
    id: String(orderDoc._id),
    transaction_code: orderDoc.transaction_code || '',
    fulfillment_type: orderDoc.fulfillment_type || 'dine_in',
    table_number: orderDoc.table_number || null,
    placed_at: orderDoc.createdAt
      ? orderDoc.createdAt.toISOString()
      : new Date().toISOString(),
    items_preview: (orderDoc.items || [])
      .slice(0, 3)
      .map((it) => ({ name: it.name, qty: it.quantity })),
    total_quantity: (orderDoc.items || []).reduce(
      (s, it) => s + (it.quantity || 0),
      0
    ),
    items_total: orderDoc.items_subtotal || 0,
    grand_total: orderDoc.grand_total || 0,
    payment_status: orderDoc.payment_status || 'pending',
    status: orderDoc.status || 'created',
    delivery: orderDoc.delivery
      ? {
          courier: orderDoc.delivery.courier || null,
          address_text: orderDoc.delivery.address_text || ''
        }
      : null
  };
}

async function afterCreateOrderEmit(orderDoc) {
  const payload = makeOrderSummary(orderDoc);

  // notif ke kasir
  emitToCashier('order:new', payload);

  // notif ke kitchen (optional, read-only di kitchen)
  emitToKitchen('order:new', payload);

  // notif kurir jika delivery dan courier assigned
  if (
    orderDoc.fulfillment_type === 'delivery' &&
    orderDoc.delivery &&
    orderDoc.delivery.courier &&
    orderDoc.delivery.courier.id
  ) {
    emitToCourier(
      String(orderDoc.delivery.courier.id),
      'order:assign:courier',
      payload
    );
  }

  // notif ke member atau guest
  if (orderDoc.member)
    emitToMember(String(orderDoc.member), 'order:created', payload);
  if (orderDoc.guestToken)
    emitToGuest(orderDoc.guestToken, 'order:created', payload);
}

module.exports = { afterCreateOrderEmit, makeOrderSummary };
