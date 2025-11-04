// models/memberModel.js
const mongoose = require('mongoose');

const MemberSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    phone: { type: String, trim: true, required: true },

    join_channel: {
      type: String,
      enum: ['self_order', 'online', 'pos', 'cashier'],
      default: 'self_order'
    },

    // Loyalty
    points: { type: Number, default: 0 },

    total_spend: { type: Number, default: 0 },
    visit_count: { type: Number, default: 0 },
    last_visit_at: { type: Date },
    phone_verified_at: { type: Date },

    is_active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Index: phone unik (kalau sebelumnya belum unique, jalankan createIndex atau atur di migration)
MemberSchema.index({ phone: 1 }, { unique: true, sparse: false });

module.exports =
  mongoose.models.Member || mongoose.model('Member', MemberSchema);
