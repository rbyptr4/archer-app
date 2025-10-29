const mongoose = require('mongoose');

const ExpenseTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    protected: { type: Boolean, default: false }
  },
  { timestamps: true }
);

ExpenseTypeSchema.index({ name: 1 });
module.exports =
  mongoose.models.ExpenseType ||
  mongoose.model('ExpenseType', ExpenseTypeSchema);
