// models/orderModel.js
const mongoose = require('mongoose');

const {
  int,
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money'); // atau pakai fungsi lokal

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
    mode: {
      type: String,
      enum: ['delivery', 'pickup', 'none'],
      default: 'none',
      index: true
    },
    pickup_window: {
      from: { type: Date, default: null, index: true },
      to: { type: Date, default: null, index: true }
    },
    slot_label: { type: String, trim: true, default: null },
    scheduled_at: { type: Date, default: null, index: true },
    courier: {
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
      },
      name: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' }
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'delivered', 'failed'],
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

/* orderItemSchema: simplified — no per-item tax/service stored */
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

    // keep line_subtotal (menu+addons * qty) for clarity
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
    amountTotal: { type: Number, default: 0, set: int, get: int }, // items + shipping
    appliedAt: { type: Date, default: Date.now },
    meta: { type: Object, default: {} },
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
    guestToken: { type: String, index: true, default: null },

    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Order harus memiliki item.'
      }
    },
    total_quantity: { type: Number, min: 1, required: true },

    // base
    items_subtotal: {
      type: Number,
      min: 0,
      required: true,
      set: int,
      get: int
    },
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },

    // service fee: simplified aggregate (2% dari items_subtotal)
    service_fee: { type: Number, min: 0, default: 0, set: int, get: int },

    // diskon voucher
    items_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    shipping_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    discounts: { type: [discountBreakdownSchema], default: [] },

    // pajak aggregate (dihitung dari items_subtotal)
    tax_rate_percent: { type: Number, min: 0, max: 100, default: 0 },
    tax_amount: { type: Number, min: 0, default: 0, set: int, get: int },

    // grand total (sudah DIPBULATKAN pake aturan custom)
    grand_total: { type: Number, min: 0, required: true, set: int, get: int },
    rounding_delta: {
      type: Number,
      default: 0,
      set: int,
      get: int
    },

    // Payment
    payment_provider: { type: String, trim: true, default: null },
    payment_invoice_id: { type: String, trim: true, default: '' },
    payment_invoice_external_id: { type: String, trim: true, default: '' },
    payment_invoice_url: { type: String, trim: true, default: '' },
    payment_expires_at: { type: Date, default: null },
    payment_raw_webhook: { type: mongoose.Schema.Types.Mixed, default: null },

    payment_method: {
      type: String,
      enum: ['transfer', 'qris', 'card', 'cash'],
      required: true
    },
    payment_proof_url: { type: String, trim: true, default: '' },
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
    ownerVerified: { type: Boolean, default: false, index: true },
    ownerVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    ownerVerifiedAt: { type: Date },

    placed_at: { type: Date, default: Date.now, required: true },
    paid_at: { type: Date },
    cancelled_at: { type: Date },
    cancellation_reason: { type: String, trim: true, default: '' },

    delivery: { type: DeliverySchema, default: undefined }, // snippets: orderModel.js (mongoose)
    appliedPromo: {
      promoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Promo',
        default: null
      },
      promoSnapshot: { type: Object, default: {} } // simpan nama, type, impact, note
    },
    appliedVouchers: [
      {
        claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoucherClaim' },
        voucherSnapshot: { type: Object, default: {} } // simpan voucherId, name, amount
      }
    ],
    promoRewards: [
      {
        // jika promo menambahkan free items / reward metadata
        type: { type: String },
        data: { type: Object }
      }
    ],
    orderPriceSnapshot: { type: Object, default: {} } // mirror ui_totals / breakdown for audit
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { getters: true, virtuals: true },
    toObject: { getters: true, virtuals: true }
  }
);

orderSchema.virtual('items_total').get(function () {
  return this.items_subtotal;
});

/* ===== Pre-validate: enforce price order (simplified aggregate tax/service) =====
 * Base (items+ongkir) -> service fee -> voucher -> pajak -> pembulatan
 */
orderSchema.pre('validate', function (next) {
  const items = this.items || [];
  let totalQty = 0;
  let itemsSubtotal = 0;

  for (const it of items) {
    const addonsSumPerUnit = (it.addons || []).reduce(
      (a, x) => a + int(x.price) * (x.qty || 1),
      0
    );

    const unitBefore = int(it.base_price) + int(addonsSumPerUnit);
    const qty = int(it.quantity || 1);

    // recalc line_subtotal (menu+addons) * qty
    const line = unitBefore * qty;
    it.line_subtotal = int(line);

    totalQty += qty;
    itemsSubtotal += int(line);
  }

  this.total_quantity = totalQty;
  this.items_subtotal = int(itemsSubtotal);

  // delivery fee (either in delivery subdoc or top-level)
  const deliveryFee = this.delivery?.delivery_fee
    ? int(this.delivery.delivery_fee)
    : int(this.delivery_fee || 0);
  this.delivery_fee = deliveryFee;

  // Normalisasi diskon (tidak boleh negatif)
  this.items_discount = int(Math.max(0, this.items_discount || 0));
  this.shipping_discount = int(Math.max(0, this.shipping_discount || 0));

  // TAX & SERVICE: kedua-duanya dihitung dari items setelah diskon
  const taxableItems = Math.max(0, this.items_subtotal - this.items_discount);

  // SERVICE FEE: aggregate from taxable items (2% dari items setelah diskon)
  const sfRate = SERVICE_FEE_RATE;
  this.service_fee = int(Math.round(taxableItems * sfRate));

  // TAX: aggregate from taxable items
  const rate = parsePpnRate();
  this.tax_rate_percent = Math.round(rate * 100 * 100) / 100;
  this.tax_amount = int(Math.round(taxableItems * rate));

  // Raw total sebelum rounding:
  // - gunakan taxableItems (items after discount) + service + delivery - shipping_discount + tax
  const rawTotal =
    taxableItems +
    this.service_fee +
    this.delivery_fee -
    this.shipping_discount +
    this.tax_amount;

  // Pembulatan custom
  const rounded = roundRupiahCustom(rawTotal);
  this.grand_total = int(rounded);
  this.rounding_delta = int(rounded - rawTotal);

  // delivery validation same as before...
  if (
    this.fulfillment_type === 'delivery' &&
    this.delivery?.mode === 'delivery'
  ) {
    const ok =
      this.delivery &&
      typeof this.delivery?.location?.lat === 'number' &&
      typeof this.delivery?.location?.lng === 'number' &&
      typeof this.delivery?.distance_km === 'number';
    if (!ok) return next(new Error('Data delivery tidak lengkap.'));
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

/* Methods untuk cek */
orderSchema.methods.canMoveToKitchen = function () {
  return this.payment_status === 'paid' || this.payment_status === 'verified';
};

orderSchema.methods.canAssignCourier = function () {
  return (
    (this.payment_status === 'paid' || this.payment_status === 'verified') &&
    this.fulfillment_type === 'delivery'
  );
};

orderSchema.index({ member: 1, createdAt: -1 });
orderSchema.index({ source: 1, fulfillment_type: 1, createdAt: -1 });
orderSchema.index({ payment_status: 1, createdAt: -1 });
orderSchema.index({ transaction_code: 1 }, { unique: true, sparse: true });
orderSchema.index({ 'delivery.status': 1, createdAt: -1 });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
