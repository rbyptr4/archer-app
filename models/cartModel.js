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
    line_key: { type: String, required: true }, // penentu “varian” unik di cart
    line_subtotal: { type: Number, required: true, min: 0 }
  },
  { _id: true, timestamps: false }
);

/* ================= Subdoc: Draft Delivery (opsional, untuk FE) ================= */
const deliveryDraftSchema = new mongoose.Schema(
  {
    address_text: { type: String, trim: true, default: '' },
    location: {
      lat: { type: Number },
      lng: { type: Number }
    },
    note_to_rider: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

/* ================= Main: Cart ================= */
const cartSchema = new mongoose.Schema(
  {
    // Identitas pemilik cart (member atau session)
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      default: null
    },
    session_id: { type: String, default: null },

    // Sumber/cart channel: 'qr' (self-order) atau 'online' (website publik)
    source: {
      type: String,
      enum: ['qr', 'online'],
      required: true,
      index: true
    },

    // Diperlukan untuk self-order (qr). Untuk online selalu null.
    table_number: { type: Number, default: null, min: 1 },

    // Item keranjang
    items: { type: [itemSchema], default: [] },

    // Ringkasan
    total_items: { type: Number, default: 0, min: 0 },
    total_quantity: { type: Number, default: 0, min: 0 },
    total_price: { type: Number, default: 0, min: 0 },

    // Status cart
    status: {
      type: String,
      enum: ['active', 'checked_out', 'abandoned'],
      default: 'active',
      index: true
    },

    // ====== Metadata checkout/idempotency ======
    last_idempotency_key: { type: String, default: null },
    checked_out_at: { type: Date, default: null },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null
    },

    // ====== Preferensi FE ======
    // Simpan pilihan tipe order terakhir agar FE bisa conditional render:
    // 'dine_in' | 'delivery' (tidak wajib; controller akan pakai kalau ada)
    fulfillment_type: {
      type: String,
      enum: ['dine_in', 'delivery'],
      default: undefined
    },

    // Draft alamat delivery (opsional, biar user gak ngetik ulang sebelum checkout)
    delivery_draft: { type: deliveryDraftSchema, default: undefined }
  },
  { timestamps: true }
);

cartSchema.index(
  { member: 1, source: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      member: { $exists: true, $ne: null },
      source: { $exists: true, $ne: null },
      status: 'active'
    }
  }
);

cartSchema.index(
  { session_id: 1, source: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      session_id: { $exists: true, $ne: null },
      source: { $exists: true, $ne: null },
      status: 'active'
    }
  }
);

// models/cartModel.js (tambahkan setelah schema)
cartSchema.index(
  { status: 1, source: 1, member: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active', member: { $type: 'objectId' } }
  }
);

cartSchema.index(
  { status: 1, source: 1, session_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'active',
      member: { $exists: false },
      session_id: { $type: 'string' }
    }
  }
);

cartSchema.index({ checked_out_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

// Agar require() ulang tidak bikin OverwriteModelError saat hot-reload
module.exports = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
