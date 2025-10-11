const mongoose = require('mongoose');

const BIG_CATEGORIES = [
  'food',
  'drink',
  'dessert',
  'package',
  'special',
  'snack',
  'merchandise',
  'other'
];

const MenuSubcategorySchema = new mongoose.Schema(
  {
    bigCategory: {
      type: String,
      enum: BIG_CATEGORIES,
      required: true,
      index: true
    },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true, trim: true, index: true },
    sortOrder: { type: Number, default: 0 }
  },
  { timestamps: true, versionKey: false }
);

// unik per (bigCategory, nameLower)
MenuSubcategorySchema.index({ bigCategory: 1, nameLower: 1 }, { unique: true });

MenuSubcategorySchema.pre('validate', function () {
  this.nameLower = String(this.name || '')
    .trim()
    .toLowerCase();
  if (!this.nameLower) {
    this.invalidate('name', 'Nama subcategory tidak boleh kosong');
  }
});

module.exports = {
  BIG_CATEGORIES,
  MenuSubcategory:
    mongoose.models.MenuSubcategory ||
    mongoose.model('MenuSubcategory', MenuSubcategorySchema)
};
