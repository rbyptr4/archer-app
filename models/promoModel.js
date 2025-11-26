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
    qty: { type: Number, default: 1 }
  },
  { _id: false }
);

const PromoConditionSchema = new mongoose.Schema(
  {
    minTotal: { type: Number, default: 0 },
    minQty: { type: Number, default: 0 },
    items: { type: [PromoItemCondSchema], default: [] },
    audience: { type: String, enum: ['all', 'members'], default: 'all' },
    memberLevels: {
      type: [String],
      enum: ['bronze', 'silver', 'gold'],
      default: undefined
    },
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

    // cart discounts
    percent: { type: Number, default: null }, // cart percent discount (0-100)
    amount: { type: Number, default: null }, // flat amount discount (Rp)
    maxDiscountAmount: { type: Number, default: null }, // cap for percent discount (Rp)

    // points (award / cashback as points)
    pointsFixed: { type: Number, default: null },
    pointsPercent: { type: Number, default: null }, // percent of cart converted to points

    // membership grant
    grantMembership: { type: Boolean, default: false },

    // scope: reward bisa diterapkan hanya ke kategori/menu tertentu
    appliesTo: {
      type: String,
      enum: ['all', 'category', 'menu'],
      default: 'all'
    },
    appliesToCategory: { type: String, default: null },
    appliesToMenuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu',
      default: null
    }
  },
  { _id: false }
);

const promoSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: [
        'free_item',
        'buy_x_get_y',
        'bundling',
        'cart_percent',
        'cart_amount',
        'price_override',
        'award_points',
        'grant_membership'
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

    // per-member and global counters
    perMemberLimit: { type: Number, default: 0 }, // 0 = unlimited (legacy; per member total lifetime)
    globalStock: { type: Number, default: null }, // optional decrement global usage (lifetime)

    // aktif / notes / author
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '' }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// indexes
promoSchema.index({ code: 1 }, { sparse: true });
promoSchema.index({
  isActive: 1,
  'conditions.startAt': 1,
  'conditions.endAt': 1,
  priority: -1
});

module.exports = mongoose.model('Promo', promoSchema);
