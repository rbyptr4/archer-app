const mongoose = require('mongoose');

const MemberSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    phone: { type: String, trim: true, required: true },
    join_channel: {
      type: String,
      enum: ['cashier', 'self_order'],
      default: 'self_order'
    },
    total_spend: { type: Number, default: 0 },
    visit_count: { type: Number, default: 0 },
    last_visit_at: { type: Date },
    is_active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

MemberSchema.index({ phone: 1 });

module.exports =
  mongoose.models.Member || mongoose.model('Member', MemberSchema);
