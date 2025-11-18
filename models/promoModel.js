// models/promoModel.js
const mongoose = require('mongoose');

const PromoItemCondSchema = new mongoose.Schema(
  {
    menuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu',
      default: null
    },
    category: { type: String, default: null },
    qty: { type: Number, default: 1 } // required quantity for this condition
  },
  { _id: false }
);

const PromoConditionSchema = new mongoose.Schema(
  {
    minTotal: { type: Number, default: 0 },
    minQty: { type: Number, default: 0 },
    items: { type: [PromoItemCondSchema], default: [] },
    audience: { type: String, enum: ['all', 'members'], default: 'all' },
    // relative birthday window (days after birthday inclusive)
    birthdayWindowDays: { type: Number, default: 0 },
    // period-specific absolute window (optional)
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null }
  },
  { _id: false }
);

const PromoRewardSchema = new mongoose.Schema(
  {
    freeMenuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu',
      default: null
    },
    freeQty: { type: Number, default: 1 },
    percent: { type: Number, default: null }, // cart percent discount
    amount: { type: Number, default: null }, // flat amount
    fixedPriceBundle: { type: Number, default: null },
    pointsFixed: { type: Number, default: null },
    pointsPercent: { type: Number, default: null },
    grantMembership: { type: Boolean, default: false }
  },
  { _id: false }
);

const promoSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: '' }, // optional, for admin reference
    type: {
      type: String,
      enum: [
        'free_item',
        'buy_x_get_y',
        'bundling',
        'cart_percent',
        'cart_amount',
        'fixed_price_bundle',
        'price_override',
        'award_points',
        'grant_membership',
        'composite' // for combo rewards like birthday free+percent
      ],
      required: true
    },
    conditions: { type: PromoConditionSchema, default: () => ({}) },
    reward: { type: PromoRewardSchema, default: () => ({}) },

    // controls
    autoApply: { type: Boolean, default: true }, // apakah auto-applied / FE harus pilih
    stackable: { type: Boolean, default: false }, // not used if policy one-promo-only
    blocksVoucher: { type: Boolean, default: false },
    priority: { type: Number, default: 0 }, // sorting/resolve
    perMemberLimit: { type: Number, default: 0 }, // 0 = unlimited
    globalStock: { type: Number, default: null }, // optional decrement
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model('Promo', promoSchema);
