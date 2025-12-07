// models/voucherModel.js
const mongoose = require('mongoose');

const VoucherSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['percent', 'amount', 'shipping'],
      required: true
    },

    // ---- konfigurasi nilai ----
    percent: { type: Number, min: 0, max: 100 }, // untuk type=percent
    amount: { type: Number, min: 0 }, // untuk type=amount/ongkir flat
    maxDiscount: { type: Number, min: 0, default: null },

    shipping: {
      percent: {
        type: Number,
        min: 0,
        max: 100,
        required: function () {
          return this.type === 'shipping';
        }
      },
      maxAmount: {
        type: Number,
        min: 0,
        required: function () {
          return this.type === 'shipping';
        }
      }
    },

    // ---- periode & stok ----
    visibility: {
      mode: {
        type: String,
        enum: ['global_stock', 'periodic'],
        default: 'periodic'
      },
      startAt: { type: Date },
      endAt: { type: Date },
      globalStock: { type: Number, min: 0, default: null }, // untuk global_stock
      perMemberLimit: { type: Number, min: 1, default: 1 }
    },

    usage: {
      // penggunaan per claim = biasanya 1x. Bisa dibuat >1 kalau mau.
      maxUsePerClaim: { type: Number, min: 1, default: 1 },
      // masa pakai setelah diklaim (opsional). Kalau null, pakai endAt global saja.
      useValidDaysAfterClaim: { type: Number, min: 0, default: 0 },
      // apakah perlu claim dulu atau bisa auto-applied (kita set default: perlu claim)
      claimRequired: { type: Boolean, default: true },
      // stacking rule
      stackableWithShipping: { type: Boolean, default: false },
      stackableWithOthers: { type: Boolean, default: false }
    },

    // ---- target & syarat ----
    target: {
      audience: { type: String, enum: ['all', 'members'], default: 'all' },
      includeMemberIds: [
        { type: mongoose.Schema.Types.ObjectId, ref: 'Member' }
      ], // opsional whitelist
      excludeMemberIds: [
        { type: mongoose.Schema.Types.ObjectId, ref: 'Member' }
      ], // opsional blacklist
      minTransaction: { type: Number, min: 0, default: 0 },
      requiredPoints: { type: Number, min: 0, default: 0 } // point untuk claim (redeem)
    },

    // ---- status ----
    isActive: { type: Boolean, default: true }, // owner bisa on/off manual
    isDeleted: { type: Boolean, default: false },

    // meta
    notes: String
  },
  { timestamps: true }
);

VoucherSchema.index({ 'visibility.startAt': 1, 'visibility.endAt': 1 });
VoucherSchema.index({ isActive: 1, isDeleted: 1 });

module.exports = mongoose.model('Voucher', VoucherSchema);
