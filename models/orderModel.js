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
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
      },
      name: { type: String, trim: true, default: '' }
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

/* ================= Subdoc: Addon & Item ================= */
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

/* ================= Subdoc: Voucher Discount Breakdown ================= */
const discountBreakdownSchema = new mongoose.Schema(
  {
    claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoucherClaim' },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher' },
    name: { type: String, trim: true }, // nama/label voucher saat rilis
    itemsDiscount: { type: Number, default: 0, set: int, get: int }, // potongan ke barang
    shippingDiscount: { type: Number, default: 0, set: int, get: int }, // potongan ongkir
    note: { type: String, trim: true, default: '' }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

/* ================= Main: Order ================= */
const orderSchema = new mongoose.Schema(
  {
    transaction_code: { type: String, trim: true },

    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      default: null
    },

    customer_name: { type: String, trim: true, default: '' },
    customer_phone: { type: String, trim: true, default: '' },
    loyalty_awarded_at: { type: Date, default: null },

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

    // Items
    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Order harus memiliki item.'
      }
    },
    total_quantity: { type: Number, min: 1, required: true },

    // ======= Totals with Voucher Engine =======
    // subtotal barang sebelum diskon
    items_subtotal: {
      type: Number,
      min: 0,
      required: true,
      set: int,
      get: int
    },

    // total diskon ke barang (gabungan semua voucher non-ongkir)
    items_discount: { type: Number, min: 0, default: 0, set: int, get: int },

    // ongkir (mirror dari delivery.delivery_fee supaya gampang dihitung)
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },

    // total diskon ongkir (free/discount shipping)
    shipping_discount: { type: Number, min: 0, default: 0, set: int, get: int },

    // rincian per voucher yang dipakai
    discounts: { type: [discountBreakdownSchema], default: [] },

    // grand total akhir = items_subtotal - items_discount + delivery_fee - shipping_discount
    grand_total: { type: Number, min: 0, required: true, set: int, get: int },

    // Pembayaran
    payment_method: {
      type: String,
      enum: ['qr', 'manual', 'cash'],
      default: function () {
        return this.source === 'online' ? 'qr' : 'manual';
      }
    },
    payment_proof_url: { type: String, trim: true }, // ONLINE wajib (divalidasi di hook)
    payment_status: {
      type: String,
      enum: ['paid', 'verified', 'refunded', 'void'],
      index: true
    },
    // Status utama
    status: {
      type: String,
      enum: ['created', 'accepted', 'completed', 'cancelled'],
      default: 'created',
      index: true
    },
    verified_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    verified_at: { type: Date },

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

/* =============== Derived & Back-compat =============== */
// Backward compatibility: expose items_total seperti sebelumnya (alias ke items_subtotal)
orderSchema.virtual('items_total').get(function () {
  return this.items_subtotal;
});

/* =============== Hooks =============== */
orderSchema.pre('validate', function (next) {
  const items = this.items || [];
  let totalQty = 0;
  let itemsSubtotal = 0;

  for (const it of items) {
    const addonsSum = (it.addons || []).reduce(
      (a, x) => a + int(x.price) * (x.qty || 1),
      0
    );
    const line = (int(it.base_price) + addonsSum) * int(it.quantity || 1);
    it.line_subtotal = int(line);
    totalQty += int(it.quantity || 0);
    itemsSubtotal += int(line);
  }

  this.total_quantity = totalQty;
  this.items_subtotal = int(itemsSubtotal);

  // mirror delivery_fee dari block delivery (kalau ada)
  const deliveryFee = this.delivery?.delivery_fee
    ? int(this.delivery.delivery_fee)
    : 0;
  this.delivery_fee = int(deliveryFee);

  // pastikan diskon non-negatif
  this.items_discount = int(Math.max(0, this.items_discount || 0));
  this.shipping_discount = int(Math.max(0, this.shipping_discount || 0));

  // grand total = items_subtotal - items_discount + delivery_fee - shipping_discount
  const gt =
    this.items_subtotal -
    this.items_discount +
    this.delivery_fee -
    this.shipping_discount;
  this.grand_total = int(Math.max(0, gt));

  // aturan table_number
  if (this.fulfillment_type === 'dine_in' && this.source === 'online') {
    this.table_number = null;
  }

  // aturan source online: wajib payment proof + method qr
  if (this.source === 'online') {
    if (!this.payment_proof_url || !String(this.payment_proof_url).trim()) {
      return next(new Error('Bukti pembayaran wajib untuk order online.'));
    }
    this.payment_method = 'qr';
  }

  // aturan delivery: data wajib
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

  if (!this.member) {
    const hasGuest =
      (this.customer_name && this.customer_name.trim().length > 0) ||
      (this.customer_phone && this.customer_phone.trim().length > 0);
    if (!hasGuest) {
      return next(
        new Error('Order butuh identitas: member atau customer_name/phone.')
      );
    }
  }

  next();
});

/* =============== Methods =============== */
orderSchema.methods.canMoveToKitchen = function () {
  return this.payment_status === 'paid';
};

orderSchema.methods.canAssignCourier = function () {
  return this.payment_status === 'paid' && this.fulfillment_type === 'delivery';
};

/* =============== Indexes =============== */
orderSchema.index({ member: 1, createdAt: -1 });
orderSchema.index({ source: 1, fulfillment_type: 1, createdAt: -1 });
orderSchema.index({ payment_status: 1, createdAt: -1 });
orderSchema.index({ transaction_code: 1 }, { unique: true, sparse: true });
orderSchema.index({ 'delivery.status': 1, createdAt: -1 });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
