const mongoose = require('mongoose');

function int(v) {
  return Math.round(Number(v || 0));
}

/* ================= Subdoc: Delivery ================= */
const DeliverySchema = new mongoose.Schema(
  {
    address_text: { type: String, trim: true },
    location: {
      lat: { type: Number },
      lng: { type: Number }
    },
    distance_km: { type: Number, min: 0 },
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    note_to_rider: { type: String, trim: true, default: '' },
    assignee: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: { type: String, trim: true }
    },
    status: {
      type: String,
      enum: [
        'pending',
        'assigned',
        'picked_up',
        'on_the_way',
        'delivered',
        'failed'
      ],
      default: 'pending',
      index: true
    },
    timestamps: {
      assigned_at: Date,
      picked_up_at: Date,
      delivered_at: Date,
      failed_at: Date
    }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

const addonSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    price: { type: Number, min: 0, default: 0, set: int, get: int },
    qty: { type: Number, min: 1, default: 1 }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

const orderItemSchema = new mongoose.Schema(
  {
    menu: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
    menu_code: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, required: true },
    imageUrl: { type: String, trim: true, default: '' },
    base_price: { type: Number, min: 0, required: true, set: int, get: int },
    quantity: { type: Number, min: 1, max: 999, required: true },
    addons: { type: [addonSchema], default: [] },
    notes: { type: String, trim: true, default: '' },
    // subtotal = (base_price + sum(addons)) * quantity
    line_subtotal: { type: Number, min: 0, required: true, set: int, get: int }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

/* ================= Main: Order ================= */
const orderSchema = new mongoose.Schema(
  {
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      required: true
    },

    source: {
      type: String,
      enum: ['qr', 'pos', 'online'],
      default: 'qr',
      index: true
    },

    fulfillment_type: {
      type: String,
      enum: ['dine_in', 'delivery'],
      required: true,
      index: true
    },

    table_number: {
      type: Number,
      min: 1,
      default: null,
      validate: {
        validator: function (v) {
          if (this.fulfillment_type === 'dine_in' && this.source !== 'online') {
            return Number.isFinite(v) && v >= 1;
          }
          return v == null || Number.isFinite(v);
        },
        message: 'table_number wajib untuk dine-in QR/POS.'
      }
    },

    // Barang
    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Order harus memiliki item.'
      }
    },

    total_quantity: { type: Number, min: 1, required: true },
    items_total: { type: Number, min: 0, required: true, set: int, get: int }, // total dari semua line_subtotal
    grand_total: { type: Number, min: 0, required: true, set: int, get: int }, // items_total + (delivery_fee kalau ada)

    // Pembayaran
    payment_method: {
      type: String,
      enum: ['qr', 'manual', 'cash'],
      default: function () {
        return this.source === 'online' ? 'qr' : 'manual';
      }
    },
    payment_proof_url: { type: String, trim: true, default: '' }, // ONLINE wajib (divalidasi di hook)
    payment_status: {
      type: String,
      enum: ['unpaid', 'paid', 'refunded', 'void'],
      default: 'unpaid',
      index: true
    },
    verified_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    verified_at: { type: Date },

    // Status utama
    status: {
      type: String,
      enum: [
        'created',
        'accepted',
        'preparing',
        'served',
        'completed',
        'cancelled'
      ],
      default: 'created',
      index: true
    },

    // Tanggal penting
    placed_at: { type: Date, default: Date.now, required: true },
    paid_at: { type: Date },
    cancelled_at: { type: Date },
    cancellation_reason: { type: String, trim: true, default: '' },

    // Delivery block (hanya terisi bila fulfillment = delivery)
    delivery: { type: DeliverySchema, default: undefined }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { getters: true, virtuals: true },
    toObject: { getters: true, virtuals: true }
  }
);

orderSchema.pre('validate', function (next) {
  const items = this.items || [];
  let totalQty = 0;
  let itemsTotal = 0;

  for (const it of items) {
    const addonsSum = (it.addons || []).reduce(
      (a, x) => a + int(x.price) * (x.qty || 1),
      0
    );
    const line = (int(it.base_price) + addonsSum) * int(it.quantity || 1);
    it.line_subtotal = int(line);
    totalQty += int(it.quantity || 0);
    itemsTotal += int(line);
  }

  this.total_quantity = totalQty;
  this.items_total = int(itemsTotal);

  const deliveryFee = this.delivery?.delivery_fee
    ? int(this.delivery.delivery_fee)
    : 0;
  this.grand_total = int(this.items_total + deliveryFee);

  if (this.fulfillment_type === 'dine_in' && this.source === 'online') {
    this.table_number = null;
  }

  if (this.source === 'online') {
    if (!this.payment_proof_url || !String(this.payment_proof_url).trim()) {
      return next(new Error('Bukti pembayaran wajib untuk order online.'));
    }
    this.payment_method = 'qr';
  }

  if (this.fulfillment_type === 'delivery') {
    const ok =
      this.delivery &&
      typeof this.delivery?.location?.lat === 'number' &&
      typeof this.delivery?.location?.lng === 'number' &&
      typeof this.delivery?.distance_km === 'number';
    if (!ok) {
      return next(
        new Error('Data delivery tidak lengkap (lat, lng, distance_km wajib).')
      );
    }
  }

  next();
});

orderSchema.methods.canMoveToKitchen = function () {
  return this.payment_status === 'paid';
};

orderSchema.methods.canAssignCourier = function () {
  return this.payment_status === 'paid' && this.fulfillment_type === 'delivery';
};

orderSchema.index({ member: 1, createdAt: -1 });
orderSchema.index({ source: 1, fulfillment_type: 1, createdAt: -1 });
orderSchema.index({ payment_status: 1, createdAt: -1 });
orderSchema.index({ 'delivery.status': 1, createdAt: -1 });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
