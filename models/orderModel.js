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
    line_subtotal: { type: Number, min: 0, required: true, set: int, get: int }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

/* ================= Subdoc: Voucher Discount Breakdown ================= */
const discountBreakdownSchema = new mongoose.Schema(
  {
    claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoucherClaim' },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher' },
    name: { type: String, trim: true },
    itemsDiscount: { type: Number, default: 0, set: int, get: int },
    shippingDiscount: { type: Number, default: 0, set: int, get: int },
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

    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Order harus memiliki item.'
      }
    },
    total_quantity: { type: Number, min: 1, required: true },

    items_subtotal: {
      type: Number,
      min: 0,
      required: true,
      set: int,
      get: int
    },
    items_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    shipping_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    discounts: { type: [discountBreakdownSchema], default: [] },
    grand_total: { type: Number, min: 0, required: true, set: int, get: int },

    // ===== Payment (refactor: qris | transfer | cash) =====
    // ===== Pajak (PPN) =====
    tax_rate_percent: { type: Number, min: 0, max: 100, default: 0 }, // contoh: 11
    tax_amount: { type: Number, min: 0, default: 0, set: int, get: int },

    // ===== Payment via gateway (in-app) =====
    payment_provider: { type: String, trim: true, default: null }, // 'xendit' | null
    payment_invoice_id: { type: String, trim: true, default: '' }, // id sesi/invoice di gateway
    payment_invoice_external_id: { type: String, trim: true, default: '' },
    payment_invoice_url: { type: String, trim: true, default: '' }, // kalau channel butuh URL
    payment_expires_at: { type: Date, default: null },
    payment_raw_webhook: { type: mongoose.Schema.Types.Mixed, default: null },

    payment_method: {
      type: String,
      enum: ['qris', 'transfer', 'cash'],
      default: function () {
        // default aman: non-cash untuk non-POS, cash sering dipakai di POS
        return this.source === 'pos' ? 'cash' : 'qris';
      }
    },
    payment_proof_url: { type: String, trim: true },
    payment_status: {
      type: String,
      enum: ['unpaid', 'paid', 'verified', 'expired', 'failed', 'void'],
      index: true
    },

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

    placed_at: { type: Date, default: Date.now, required: true },
    paid_at: { type: Date },
    cancelled_at: { type: Date },
    cancellation_reason: { type: String, trim: true, default: '' },

    delivery: { type: DeliverySchema, default: undefined }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { getters: true, virtuals: true },
    toObject: { getters: true, virtuals: true }
  }
);

/* =============== Derived (back-compat) =============== */
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

  const deliveryFee = this.delivery?.delivery_fee
    ? int(this.delivery.delivery_fee)
    : 0;
  this.delivery_fee = int(deliveryFee);

  this.items_discount = int(Math.max(0, this.items_discount || 0));
  this.shipping_discount = int(Math.max(0, this.shipping_discount || 0));

  const taxBase =
    this.items_subtotal -
    this.items_discount +
    this.delivery_fee -
    this.shipping_discount;

  const rate = parsePpnRate();
  this.tax_rate_percent = Math.round(rate * 100 * 100) / 100; 
  this.tax_amount = int(Math.max(0, taxBase * rate));

  // Grand total = base + pajak
  const gt = taxBase + this.tax_amount;
  this.grand_total = int(Math.max(0, gt));

  // Dine-in via online => hapus table_number
  if (this.fulfillment_type === 'dine_in' && this.source === 'online') {
    this.table_number = null;
  }

  // ===== Payment rules (baru) =====
  // 1) Delivery tidak boleh cash
  if (this.fulfillment_type === 'delivery' && this.payment_method === 'cash') {
    return next(new Error('Delivery tidak mendukung metode pembayaran cash.'));
  }

  // 2) Bukti pembayaran TIDAK wajib (in-app pakai gateway + webhook)
  if (this.payment_method === 'cash') {
    this.payment_proof_url = ''; // cash tidak perlu bukti
  }

  // 3) Delivery data wajib
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

  // 4) Identitas: member ATAU minimal nama/telp
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
