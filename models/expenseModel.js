const mongoose = require('mongoose');

const ExpenseSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, default: () => new Date() },
    type: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExpenseType',
      required: true
    },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, required: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  { timestamps: true }
);

ExpenseSchema.index({ date: -1 });
ExpenseSchema.index({ type: 1, date: -1 });
ExpenseSchema.index({ note: 'text' });

module.exports =
  mongoose.models.Expense || mongoose.model('Expense', ExpenseSchema);
