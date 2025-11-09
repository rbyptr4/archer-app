const mongoose = require('mongoose');
const { Schema } = mongoose;
const { int } = require('../utils/money'); // pastikan path sesuai

// ===================== SUBSCHEMAS =====================

// Diskon breakdown (sama seperti di Order)
const discountBreakdownSchema = new Schema(
  {
    kind: { type: String, trim: true },
    label: { type: String, trim: true },
    amount: { type: Number, default: 0 },
    ref: { type: String, trim: true }
  },
  { _id: false }
);

// Item ringkasan
const HistoryItemSchema = new Schema(
  {
    menu: { type: Schema.Types.ObjectId, ref: 'Menu' },
    name: { type: String, trim: true },
    menu_code: { type: String, trim: true },
    quantity: { type: Number, default: 1 },
    base_price: { type: Number, default: 0 },
    addons_total: { type: Number, default: 0 },
    line_subtotal: { type: Number, default: 0 },
    category: {
      big: { type: String },
      subId: { type: Schema.Types.ObjectId, ref: 'MenuSubcategory' },
      subName: { type: String, trim: true, default: '' }
    },
    imageUrl: { type: String, trim: true },
    notes: { type: String, trim: true },
    addons: [
      {
        name: { type: String, trim: true },
        price: { type: Number, default: 0 },
        qty: { type: Number, default: 1 }
      }
    ],
    line_key: { type: String, trim: true }
  },
  { _id: false }
);

// Delivery snapshot
const HistoryDeliverySchema = new Schema(
  {
    address_text: { type: String, trim: true },
    distance_km: { type: Number, default: null },
    delivery_fee: { type: Number, default: 0 },
    status: { type: String, trim: true },
    courier: {
      id: { type: String, trim: true },
      name: { type: String, trim: true },
      phone: { type: String, trim: true }
    }
  },
  { _id: false }
);

// Entry timeline kecil (untuk perubahan status, note, dll)
const ChangeEntrySchema = new Schema(
  {
    type: { type: String, required: true }, // 'order_status', 'delivery_status', etc.
    from: { type: String, default: null },
    to: { type: String, default: null },
    by: {
      id: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      name: { type: String, trim: true, default: null },
      role: { type: String, trim: true, default: null }
    },
    note: { type: String, trim: true, default: null },
    at: { type: Date, default: Date.now }
  },
  { _id: false }
);

// ===================== MAIN SCHEMA =====================

const OrderHistorySchema = new Schema(
  {
    // --- Referensi utama ---
    order: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true
    },
    transaction_code: { type: String, required: true, index: true },

    // --- Identitas dasar ---
    source: { type: String, trim: true, index: true }, // qr | online | pos
    fulfillment_type: { type: String, trim: true, index: true },
    table_number: { type: Number, default: null, index: true },

    // --- Status order dan pembayaran ---
    status: { type: String, trim: true, index: true },
    payment_status: { type: String, trim: true, index: true },
    payment_method: { type: String, trim: true, index: true },

    // --- Waktu penting ---
    placed_at: { type: Date, index: true },
    paid_at: { type: Date, index: true },
    verified_at: { type: Date, index: true },
    completed_at: { type: Date, index: true },
    cancelled_at: { type: Date, index: true },

    verified_by: {
      id: { type: Schema.Types.ObjectId, ref: 'User' },
      name: { type: String, trim: true }
    },

    member: {
      id: { type: Schema.Types.ObjectId, ref: 'Member', index: true },
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      is_member: { type: Boolean, default: false, index: true }
    },
    customer: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true }
    },

    // --- Price fields (mirroring model Order) ---
    items_subtotal: {
      type: Number,
      min: 0,
      required: true,
      set: int,
      get: int
    },
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    service_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    items_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    shipping_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    discounts: { type: [discountBreakdownSchema], default: [] },
    tax_rate_percent: { type: Number, min: 0, max: 100, default: 0 },
    tax_amount: { type: Number, min: 0, default: 0, set: int, get: int },
    grand_total: { type: Number, min: 0, required: true, set: int, get: int },
    rounding_delta: { type: Number, default: 0, set: int, get: int },

    // --- Ringkasan item & lain-lain ---
    total_quantity: { type: Number, default: 0 },
    line_count: { type: Number, default: 0 },
    items: { type: [HistoryItemSchema], default: [] },
    delivery: { type: HistoryDeliverySchema, default: undefined },
    points_awarded: { type: Number, default: 0 },
    is_refund: { type: Boolean, default: false, index: true },
    is_cancelled: { type: Boolean, default: false, index: true },

    // --- Timeline event kecil ---
    timeline: { type: [ChangeEntrySchema], default: [] },

    // --- Time keys (for fast filtering) ---
    dayKey: { type: String, index: true },
    weekKey: { type: String, index: true },
    monthKey: { type: String, index: true },
    year: { type: Number, index: true }
  },
  { timestamps: true }
);

// ===================== HELPERS =====================

function buildTimeKeys(date) {
  const d = new Date(date || Date.now());
  const y = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dayKey = `${y}-${month}-${day}`;
  const monthKey = `${y}-${month}`;

  // ISO week
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((tmp - firstThursday) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    );
  const weekStr = String(week).padStart(2, '0');
  const weekKey = `${tmp.getUTCFullYear()}-W${weekStr}`;
  return { dayKey, monthKey, weekKey, year: y };
}

// ===================== STATICS =====================

// snapshot penuh (dipanggil oleh controller)
OrderHistorySchema.statics.createFromOrder = async function (
  orderDoc,
  opts = {}
) {
  const o = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const paidAt = o.paid_at || o.verified_at || o.placed_at || new Date();
  const timeKeys = buildTimeKeys(paidAt);

  const doc = {
    order: o._id,
    transaction_code: o.transaction_code,
    source: o.source,
    fulfillment_type: o.fulfillment_type,
    table_number: o.table_number ?? null,
    status: o.status,
    payment_status: o.payment_status,
    payment_method: o.payment_method,
    placed_at: o.placed_at,
    paid_at: o.paid_at,
    verified_at: o.verified_at,
    completed_at: o.completed_at,
    cancelled_at: o.cancelled_at,
    verified_by: o.verified_by
      ? { id: o.verified_by, name: opts.verified_by_name }
      : undefined,
    member: o.member
      ? {
          id: o.member,
          name: o.member_name || o.member?.name,
          phone: o.member_phone || o.member?.phone,
          is_member: true
        }
      : { is_member: false },
    customer: o.member
      ? undefined
      : { name: o.customer_name || '', phone: o.customer_phone || '' },

    items_subtotal: o.items_subtotal,
    delivery_fee: o.delivery_fee,
    service_fee: o.service_fee,
    items_discount: o.items_discount,
    shipping_discount: o.shipping_discount,
    discounts: o.discounts,
    tax_rate_percent: o.tax_rate_percent,
    tax_amount: o.tax_amount,
    grand_total: o.grand_total,
    rounding_delta: o.rounding_delta,

    total_quantity: o.total_quantity,
    line_count: Array.isArray(o.items) ? o.items.length : 0,
    items: o.items || [],
    delivery: o.delivery,
    points_awarded: o.points_awarded || 0,
    is_refund: o.payment_status === 'refunded',
    is_cancelled: o.status === 'cancelled',
    ...timeKeys
  };

  return this.create(doc);
};

// event kecil (timeline)
OrderHistorySchema.statics.createChangeEntry = async function (orderId, entry) {
  const updated = await this.findOneAndUpdate(
    { order: orderId },
    { $push: { timeline: entry } },
    { sort: { createdAt: -1 }, new: true }
  );
  if (updated) return updated;

  const now = new Date();
  const timeKeys = buildTimeKeys(now);
  return this.create({
    order: orderId,
    transaction_code: entry.transaction_code || 'unknown',
    source: entry.source || 'unknown',
    fulfillment_type: entry.fulfillment_type || 'unknown',
    status: entry.status,
    payment_status: entry.payment_status,
    timeline: [entry],
    ...timeKeys
  });
};

module.exports =
  mongoose.models.OrderHistory ||
  mongoose.model('OrderHistory', OrderHistorySchema);
