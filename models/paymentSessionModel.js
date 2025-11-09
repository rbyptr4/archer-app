const mongoose = require('mongoose');
const { int } = require('../utils/money'); // kalau tidak ada, pake helper int = v=>Math.round(v)

const paymentSessionSchema = new mongoose.Schema(
  {
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      default: null
    },
    // snapshot guest
    customer_name: { type: String, trim: true, default: '' },
    customer_phone: { type: String, trim: true, default: '' },

    // mode & fulfillment
    source: {
      type: String,
      enum: ['qr', 'online'],
      default: 'online'
    },
    fulfillment_type: {
      type: String,
      enum: ['dine_in', 'delivery'],
      required: true
    },
    table_number: { type: Number, min: 1, default: null },

    // snapshot cart items (bukan ref ke Cart biar aman kalau cart berubah)
    items: {
      type: Array,
      default: []
    },

    // pricing snapshot (sebelum rounding, sama kayak struktur buat Order)
    items_subtotal: { type: Number, min: 0, default: 0 },
    delivery_fee: { type: Number, min: 0, default: 0 },
    service_fee: { type: Number, min: 0, default: 0 },
    items_discount: { type: Number, min: 0, default: 0 },
    shipping_discount: { type: Number, min: 0, default: 0 },
    discounts: { type: Array, default: [] },

    // pickup / delivery snapshot
    delivery_snapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    // normalized pickup window (jika FE kirim range)
    pickup_window: {
      from: { type: Date, default: null, index: true },
      to: { type: Date, default: null, index: true }
    },

    // nilai yang diminta ke gateway
    requested_amount: { type: Number, min: 0, required: true },

    // gateway
    provider: { type: String, trim: true, default: 'xendit' },
    channel: { type: String, enum: ['qris'], default: 'qris' },

    external_id: { type: String, trim: true, index: true },
    qr_code_id: { type: String, trim: true },
    qr_string: { type: String, trim: true },
    expires_at: { type: Date },

    // link ke Order ketika sudah dibuat
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
      index: true
    },

    status: {
      type: String,
      enum: ['pending', 'paid', 'expired', 'failed'],
      default: 'pending',
      index: true
    },
    cart: { type: mongoose.Schema.Types.ObjectId, ref: 'Cart', default: null },
    session_id: { type: String, default: null }
    // duplicate expires_at removed (keep single)
  },
  {
    timestamps: true,
    versionKey: false
  }
);

paymentSessionSchema.index(
  { expires_at: 1 },
  { expireAfterSeconds: 3 * 24 * 60 * 60 }
);

module.exports =
  mongoose.models.PaymentSession ||
  mongoose.model('PaymentSession', paymentSessionSchema);
