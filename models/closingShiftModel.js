const mongoose = require('mongoose');

const StaffRefSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    position: { type: String, default: '' }
  },
  { _id: false }
);

const CashierShift1Schema = new mongoose.Schema(
  {
    previousTurnover: { type: Number, default: 0 },
    openingBreakdown: {
      cash: { type: Number, default: 0 },
      qris: { type: Number, default: 0 },
      transfer: { type: Number, default: 0 },
      card: { type: Number, default: 0 }
    }
  },
  { _id: false }
);

const CashierShift2Schema = new mongoose.Schema(
  {
    diffFromShift1: { type: Number, default: 0 },
    closingBreakdown: {
      cash: { type: Number, default: 0 },
      qris: { type: Number, default: 0 },
      card: { type: Number, default: 0 },
      transfer: { type: Number, default: 0 }
    }
  },
  { _id: false }
);

// Satu baris stok manual (tanpa perhitungan)
const ManualStockRowSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // Beras, Gas, Air, Cup, dll
    qty: { type: String, required: true } // "5 KG", "1 Galon", "3000 pcs", dll
  },
  { _id: true }
);

const Shift1Schema = new mongoose.Schema(
  {
    staff: { type: StaffRefSchema, required: true },
    // Kasir only
    cashier: { type: CashierShift1Schema, default: undefined },
    // Bar/Kitchen only (opname awal)
    stockItemsStart: { type: [ManualStockRowSchema], default: [] }
  },
  { _id: false }
);

const Shift2Schema = new mongoose.Schema(
  {
    staff: { type: StaffRefSchema, required: true },
    // Kasir only
    cashier: { type: CashierShift2Schema, default: undefined },
    // Bar/Kitchen only (opname akhir)
    stockItemsEnd: { type: [ManualStockRowSchema], default: [] },
    // Umum untuk semua tipe
    note: { type: String, default: '' }, // catatan tampil hanya di Shift-2
    requestPurchase: { type: Boolean, default: false } // toggle Ya/Tidak
  },
  { _id: false }
);

const ClosingShiftSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['bar', 'kitchen', 'cashier'], required: true },
    date: { type: Date, required: true }, // startOfDay Asia/Jakarta
    status: {
      type: String,
      enum: ['step1', 'step2', 'locked'],
      default: 'step1'
    },
    s1Submitted: { type: Boolean, default: false }, // trigger FE render Shift-2

    shift1: { type: Shift1Schema, required: true },
    shift2: { type: Shift2Schema, default: null },

    lockAt: { type: Date, default: null },

    // TTL aktif setelah locked
    expiresAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// TTL (auto-delete) hanya kalau status locked
ClosingShiftSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: 'locked' } }
);

// Cegah duplikasi laporan aktif per (date+type)
ClosingShiftSchema.index({ date: 1, type: 1, status: 1 });

module.exports = mongoose.model('ClosingShift', ClosingShiftSchema);
