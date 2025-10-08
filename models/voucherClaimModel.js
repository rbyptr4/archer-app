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

    // status wallet user
    status: {
      type: String,
      enum: ['claimed', 'used', 'expired', 'revoked'],
      default: 'claimed'
    },
    remainingUse: { type: Number, min: 0, default: 1 },

    // stok penasihat (snapshot)
    claimedAt: { type: Date, default: Date.now },
    validUntil: { type: Date }, // kalau voucher.useValidDaysAfterClaim > 0, set di sini

    // audit
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

VoucherClaimSchema.index({ member: 1, voucher: 1 });
VoucherClaimSchema.index({ status: 1, validUntil: 1 });

module.exports = mongoose.model('VoucherClaim', VoucherClaimSchema);
