// models/voucherClaimModel.js
const mongoose = require('mongoose');

const VoucherClaimSchema = new mongoose.Schema(
  {
    voucher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Voucher',
      required: true
    },
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      required: true
    },

    status: {
      type: String,
      enum: ['claimed', 'used', 'expired', 'revoked'],
      default: 'claimed',
      index: true // 🔎 membantu query wallet
    },
    remainingUse: { type: Number, min: 0, default: 1 },

    claimedAt: { type: Date, default: Date.now },
    validUntil: { type: Date, index: true },

    spentPoints: { type: Number, min: 0, default: 0 },
    history: [
      {
        at: { type: Date, default: Date.now },
        action: String, // "CLAIM", "USE", "REFUND", "EXPIRE", "REVOKE"
        ref: { type: String }, // orderId dsb
        note: String
      }
    ]
  },
  { timestamps: true }
);

// Jangan unique pada (member,voucher) kalau kamu mengizinkan claim > 1.
// Kalau mau cegah duplikat, baru pakai unique:true:
VoucherClaimSchema.index({ member: 1, voucher: 1 }); // non-unique

module.exports = mongoose.model('VoucherClaim', VoucherClaimSchema);
