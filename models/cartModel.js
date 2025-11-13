// models/cartModel.js
const mongoose = require('mongoose');

/* ================= Subdoc: Addon & Item ================= */
const addonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    qty: { type: Number, default: 1, min: 1 }
  },
  { _id: false }
);

const dineInCacheSchema = new mongoose.Schema(
  {
    last_table_number: { type: Number, min: 1, default: null }
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  {
    menu: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
    menu_code: { type: String, trim: true, default: '' },
    name: { type: String, required: true, trim: true },
    imageUrl: { type: String, default: '' },
    base_price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 999 },
    addons: { type: [addonSchema], default: [] },
    notes: { type: String, trim: true, default: '' },
    line_key: { type: String, required: true },
    line_subtotal: { type: Number, required: true, min: 0 }
  },
  { _id: true, timestamps: false }
);

/* ================= Subdoc: Draft Delivery ================= */
const deliveryDraftSchema = new mongoose.Schema(
  {
    address_text: { type: String, trim: true, default: '' },
    location: {
      lat: { type: Number },
      lng: { type: Number }
    },
    note_to_rider: { type: String, trim: true, default: '' },
    delivery_fee: {
      type: Number,
      min: 0,
      default: undefined
    },

    mode: {
      type: String,
      enum: ['delivery', 'pickup', 'none'],
      default: undefined
    }
  },
  { _id: false }
);

/* ================= Main: Cart ================= */
const cartSchema = new mongoose.Schema(
  {
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      default: null
    },
    session_id: { type: String, default: null },

    // HANYA sebagai metadata kanal terakhir (tidak memecah cart)
    source: {
      type: String,
      enum: ['qr', 'online'],
      default: 'online',
      index: true
    },

    table_number: { type: Number, default: null, min: 1 },
    dine_in_cache: { type: dineInCacheSchema, default: undefined },
    items: { type: [itemSchema], default: [] },

    total_items: { type: Number, default: 0, min: 0 },
    total_quantity: { type: Number, default: 0, min: 0 },
    total_price: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ['active', 'checked_out', 'abandoned'],
      default: 'active',
      index: true
    },

    last_idempotency_key: { type: String, default: null },
    checked_out_at: { type: Date, default: null },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null
    },

    fulfillment_type: {
      type: String,
      enum: ['dine_in', 'delivery'],
      default: undefined
    },

    delivery_draft: { type: deliveryDraftSchema, default: undefined },

    // opsional: cache UI totals
    ui_cache: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

/* ====== UNIQUE: Satu cart aktif per identitas (tanpa source) ====== */
cartSchema.index(
  { status: 1, member: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active', member: { $type: 'objectId' } }
  }
);
cartSchema.index(
  { status: 1, session_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'active',
      session_id: { $type: 'string' }
    }
  }
);

cartSchema.index(
  { status: 1, member: 1, updatedAt: -1 },
  {
    partialFilterExpression: { status: 'active', member: { $type: 'objectId' } }
  }
);
cartSchema.index(
  { status: 1, session_id: 1, updatedAt: -1 },
  {
    partialFilterExpression: {
      status: 'active',
      session_id: { $type: 'string' }
    }
  }
);

cartSchema.index({ checked_out_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

module.exports = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
