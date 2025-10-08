// models/voucherModel.js
const mongoose = require('mongoose');

const VoucherSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // percent | amount | free_item | bundling | shipping
    type: {
      type: String,
      enum: ['percent', 'amount', 'free_item', 'bundling', 'shipping'],
      required: true
    },

    // ---- konfigurasi nilai ----
    percent: { type: Number, min: 0, max: 100 }, // untuk type=percent
    amount: { type: Number, min: 0 }, // untuk type=amount/ongkir flat
    // gratis ongkir: pakai type='shipping'. amount optional (bisa cap). percent optional juga (misal 100% ongkir)
    shipping: {
      percent: { type: Number, min: 0, max: 100, default: 100 }, // 100% = free ongkir
      maxAmount: { type: Number, min: 0, default: 0 } // 0 = no cap
    },

    // ---- scope menu yang kena voucher ----
    appliesTo: {
      mode: {
        type: String,
        enum: ['all', 'menus', 'category'],
        default: 'all'
      },
      menuIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Menu' }],
      categories: [{ type: String }], // kalau kamu punya field category di Menu
      // untuk bundling: beli X item dari set ini => diskon Y (atau free_item)
      bundling: {
        buyQty: { type: Number, min: 1, default: 0 },
        getPercent: { type: Number, min: 0, max: 100, default: 0 }, // contoh "beli X, diskon Y%"
        targetMenuIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Menu' }] // menu yang kena diskon
      }
    },

    // ---- periode & stok ----
    visibility: {
      // global_stock: stok voucher habis = tak bisa diklaim lagi
      // periodic: klaim dibatasi rentang tanggal (stok opsional), owner bisa set perMemberLimit
      mode: {
        type: String,
        enum: ['global_stock', 'periodic'],
        default: 'periodic'
      },
      startAt: { type: Date },
      endAt: { type: Date },
      globalStock: { type: Number, min: 0, default: 0 }, // untuk global_stock
      perMemberLimit: { type: Number, min: 0, default: 1 } // 0 = unlimited claim per member
    },

    usage: {
      // penggunaan per claim = biasanya 1x. Bisa dibuat >1 kalau mau.
      maxUsePerClaim: { type: Number, min: 1, default: 1 },
      // masa pakai setelah diklaim (opsional). Kalau null, pakai endAt global saja.
      useValidDaysAfterClaim: { type: Number, min: 0, default: 0 },
      // apakah perlu claim dulu atau bisa auto-applied (kita set default: perlu claim)
      claimRequired: { type: Boolean, default: true },
      // stacking rule
      stackableWithShipping: { type: Boolean, default: true }, // ongkir boleh nempel voucher lain
      stackableWithOthers: { type: Boolean, default: false } // non-ongkir default: tidak stack
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
      requiredPoints: { type: Number, min: 0, default: 0 }, // point untuk claim (redeem)
      oneTimePerPeriod: { type: Boolean, default: false } // “Per-member 1x pakai” selama period
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
