const mongoose = require('mongoose');

const ExpenseTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
    protected: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

ExpenseTypeSchema.index({ name: 1 });
module.exports =
  mongoose.models.ExpenseType ||
  mongoose.model('ExpenseType', ExpenseTypeSchema);
