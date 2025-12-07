// models/orderModel.js
const mongoose = require('mongoose');

const {
  int,
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
} = require('../utils/money'); // asumsi util tersedia

/* -----------------------
   Sub-schemas (reusable)
   ----------------------*/
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

    // line subtotal = (base + addons per unit) * qty
    line_subtotal: { type: Number, min: 0, required: true, set: int, get: int },
    adjustments: {
      type: [
        {
          type: { type: String, trim: true, default: 'promo' }, // promo|voucher|manual
          amount: { type: Number, default: 0, set: int, get: int },
          reason: { type: String, trim: true, default: '' },
          promoId: { type: String, default: null },
          voucherClaimId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'VoucherClaim',
            default: null
          },
          qty: { type: Number, default: 0 }
        }
      ],
      default: []
    },
    line_total_after_adjustments: {
      type: Number,
      default: null,
      set: int,
      get: int
    }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

const deliverySchema = new mongoose.Schema(
  {
    address_text: { type: String, trim: true },
    location: { lat: Number, lng: Number },
    distance_km: { type: Number, min: 0 },
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    note_to_rider: { type: String, trim: true, default: '' },
    delivery_proof_url: { type: String, trim: true, default: '' },
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

const discountItemSchema = new mongoose.Schema(
  {
    menuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu',
      required: false
    },
    qty: { type: Number, default: 1 },
    amount: { type: Number, default: 0, set: int, get: int } // line discount amount (Rp)
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

const discountBreakdownSchema = new mongoose.Schema(
  {
    // backward-compatible refs
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VoucherClaim',
      default: null
    },
    voucherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Voucher',
      default: null
    },

    // new standardized fields for engine output
    id: { type: String, default: null }, // promoId | voucherClaimId | manual
    source: {
      type: String,
      enum: ['promo', 'voucher', 'manual', 'note'],
      default: 'promo'
    },
    orderIdx: { type: Number, default: 1 }, // execution order: promo=1, voucher=2
    type: {
      type: String,
      enum: ['percent', 'amount', 'free_item', 'points', 'membership', 'note'],
      default: 'amount'
    },
    label: { type: String, trim: true, default: '' },

    // amount fields
    amount: { type: Number, default: 0, set: int, get: int }, // total money amount (Rp) that this discount reduces
    items: { type: [discountItemSchema], default: [] }, // per-line distribution

    // legacy / convenience fields
    name: { type: String, trim: true }, // legacy alias
    itemsDiscount: { type: Number, default: 0, set: int, get: int },
    shippingDiscount: { type: Number, default: 0, set: int, get: int },
    amountTotal: { type: Number, default: 0, set: int, get: int },

    appliedAt: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    note: { type: String, trim: true, default: '' }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

/* -----------------------
   Main Order Schema
   ----------------------*/
const orderSchema = new mongoose.Schema(
  {
    // ----- identity / basic -----
    transaction_code: { type: String, trim: true },
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      default: null
    },
    customer_name: { type: String, trim: true, default: '' },
    customer_phone: { type: String, trim: true, default: '' },
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

    // ----- items ----- (required)
    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Order harus memiliki item.'
      }
    },
    total_quantity: { type: Number, min: 1, required: true },

    // ----- pricing snapshot (calculated) -----
    items_subtotal: {
      type: Number,
      min: 0,
      required: true,
      set: int,
      get: int
    },
    items_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    shipping_discount: { type: Number, min: 0, default: 0, set: int, get: int },
    delivery_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    service_fee: { type: Number, min: 0, default: 0, set: int, get: int },
    tax_rate_percent: { type: Number, min: 0, max: 100, default: 0 },
    tax_amount: { type: Number, min: 0, default: 0, set: int, get: int },
    rounding_delta: { type: Number, default: 0, set: int, get: int },
    grand_total: { type: Number, min: 0, required: true, set: int, get: int },

    // ----- discounts / vouchers / promo -----
    discounts: { type: [discountBreakdownSchema], default: [] },
    appliedPromo: {
      promoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Promo',
        default: null
      },
      promoSnapshot: { type: Object, default: {} }
    },
    appliedVouchers: [
      {
        claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoucherClaim' },
        voucherSnapshot: { type: Object, default: {} }
      }
    ],
    promoRewards: [{ type: Object }], // free items / award meta
    orderPriceSnapshot: { type: Object, default: {} }, // mirror engine totals for audit

    // ----- payment -----
    payment_method: {
      type: String,
      enum: ['transfer', 'qris', 'card', 'cash', 'points'], // added 'points'
      required: true
    },
    payment_provider: { type: String, trim: true, default: null },
    payment_invoice_id: { type: String, trim: true, default: '' },
    payment_invoice_external_id: { type: String, trim: true, default: '' },
    payment_invoice_url: { type: String, trim: true, default: '' },
    payment_expires_at: { type: Date, default: null },
    payment_raw_webhook: { type: mongoose.Schema.Types.Mixed, default: null },
    payment_proof_url: { type: String, trim: true, default: '' },

    payment_status: {
      type: String,
      enum: ['unpaid', 'paid', 'verified', 'expired', 'failed', 'void'],
      index: true
    },
    paid_at: { type: Date },

    // ----- loyalty / points snapshot (for rollback) -----
    // capture member state before/after checkout
    member_level_before: { type: String, trim: true, default: null },
    member_level_after: { type: String, trim: true, default: null },
    total_spend_before: { type: Number, default: 0, set: int, get: int },
    total_spend_delta: { type: Number, default: 0, set: int, get: int },

    // points consumed (by customer) and points awarded (by promo)
    points_used: { type: Number, default: 0, set: int, get: int },
    points_refunded: { type: Number, default: 0, set: int, get: int },
    points_awarded: { type: Number, default: 0, set: int, get: int },
    points_awarded_details: { type: Object, default: {} }, // promo ids, reason

    // ----- delivery & status -----
    delivery: { type: deliverySchema, default: undefined },

    status: {
      type: String,
      enum: ['created', 'accepted', 'completed'],
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
    verification: {
      tokenHash: { type: String, trim: true, default: null },
      expiresAt: { type: Date, default: null, index: true },
      usedAt: { type: Date, default: null },
      usedFromIp: { type: String, trim: true, default: '' },
      usedUserAgent: { type: String, trim: true, default: '' }
    },

    placed_at: { type: Date, default: Date.now, required: true }
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

orderSchema.index({ member: 1, createdAt: -1 });
orderSchema.index({ source: 1, fulfillment_type: 1, createdAt: -1 });
orderSchema.index({ payment_status: 1, createdAt: -1 });
orderSchema.index({ transaction_code: 1 }, { unique: true, sparse: true });
orderSchema.index({ 'delivery.status': 1, createdAt: -1 });

/* -----------------------
   Pricing computation (extractable)
   - computeOrderTotals(doc) : deterministic sync function
   - called in pre('validate')
   ----------------------*/
function computeOrderTotals(doc) {
  // normalize items, compute per-line subtotal, items_subtotal, total_quantity
  const items = Array.isArray(doc.items) ? doc.items : [];
  let totalQty = 0;
  let itemsSubtotal = 0;

  for (const it of items) {
    const addonsSumPerUnit = (it.addons || []).reduce(
      (a, x) => a + int(x.price) * (x.qty || 1),
      0
    );
    const unitBefore = int(it.base_price) + int(addonsSumPerUnit);
    const qty = int(it.quantity || 1);
    const line = unitBefore * qty;
    it.line_subtotal = int(line);
    totalQty += qty;
    itemsSubtotal += int(line);
  }

  doc.total_quantity = totalQty;
  doc.items_subtotal = int(itemsSubtotal);

  // delivery fee priority: delivery subdoc > top-level
  const deliveryFee = doc.delivery?.delivery_fee
    ? int(doc.delivery.delivery_fee)
    : int(doc.delivery_fee || 0);
  doc.delivery_fee = deliveryFee;

  // normalize discounts
  doc.items_discount = int(Math.max(0, doc.items_discount || 0));
  doc.shipping_discount = int(Math.max(0, doc.shipping_discount || 0));

  // taxable base
  const taxableItems = Math.max(0, doc.items_subtotal - doc.items_discount);

  // service fee (aggregate)
  doc.service_fee = int(Math.round(taxableItems * SERVICE_FEE_RATE));

  // tax
  const rate = parsePpnRate();
  doc.tax_rate_percent = Math.round(rate * 100 * 100) / 100;
  doc.tax_amount = int(Math.round(taxableItems * rate));

  const rawTotal =
    taxableItems +
    doc.service_fee +
    doc.delivery_fee -
    doc.shipping_discount +
    doc.tax_amount;

  const rounded = roundRupiahCustom(rawTotal);
  doc.grand_total = int(rounded);
  doc.rounding_delta = int(rounded - rawTotal);
}

/* -----------------------
   Pre-validate hook
   ----------------------*/
orderSchema.pre('validate', function (next) {
  try {
    // compute totals (deterministic, pure based on doc)
    computeOrderTotals(this);

    // delivery validation (keamanan)
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

    // minimal identity check
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
  } catch (err) {
    next(err);
  }
});

/* -----------------------
   Instance helpers (small)
   ----------------------*/
orderSchema.methods.canMoveToKitchen = function () {
  return this.payment_status === 'paid' || this.payment_status === 'verified';
};

orderSchema.methods.canAssignCourier = function () {
  return (
    (this.payment_status === 'paid' || this.payment_status === 'verified') &&
    this.fulfillment_type === 'delivery'
  );
};

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
