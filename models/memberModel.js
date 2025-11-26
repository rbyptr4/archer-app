// models/memberModel.js
const mongoose = require('mongoose');

const MemberSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    phone: { type: String, trim: true, required: true },
    level: { enum: ['bronze', 'silver', 'gold'] },
    gender: {
      type: String,
      enum: ['male', 'female'],
      required: true,
      index: true
    },

    join_channel: {
      type: String,
      enum: ['self_order', 'online', 'pos', 'cashier'],
      default: 'self_order'
    },

    // Loyalty
    points: { type: Number, default: 0 },

    // already exist: total_spend
    total_spend: { type: Number, default: 0 },

    // baru: spend point audit / total spend points untuk audit
    spend_point_total: { type: Number, default: 0 },

    visit_count: { type: Number, default: 0 },
    last_visit_at: { type: Date },
    phone_verified_at: { type: Date },

    birthday: { type: Date, default: null },
    birthday_editable: { type: Boolean, default: true },
    loyalty_card: { type: Boolean, default: false },
    loyalty_awarded_at: { type: Date, default: null },

    promoUsageHistory: [
      {
        promoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promo' },
        usedAt: Date,
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' }
      }
    ],

    address: { type: String, default: '' },
    is_active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

MemberSchema.index({ phone: 1 }, { unique: true, sparse: false });
MemberSchema.index({ name: 'text', phone: 'text' });

module.exports =
  mongoose.models.Member || mongoose.model('Member', MemberSchema);
