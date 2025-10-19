// models/cartModel.js
const mongoose = require('mongoose');

const addonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    qty: { type: Number, default: 1, min: 1 }
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  {
    menu: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
    menu_code: { type: String, trim: true },
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

const cartSchema = new mongoose.Schema(
  {
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      default: null
    },
    session_id: { type: String, default: null },
    table_number: { type: Number, default: null, min: 1 },

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

    source: { type: String, enum: ['qr', 'pos'], default: 'qr' }
  },
  { timestamps: true }
);

cartSchema.index(
  { member: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { member: { $type: 'objectId' }, status: 'active' }
  }
);

cartSchema.index(
  { session_id: 1, table_number: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      session_id: { $type: 'string' },
      table_number: { $type: 'int' },
      status: 'active'
    }
  }
);

cartSchema.index({ checked_out_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
module.exports = mongoose.model('Cart', cartSchema);
