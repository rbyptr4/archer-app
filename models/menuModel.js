const mongoose = require('mongoose');

const AddonSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    price: { type: Number, min: 0, default: 0 }
  },
  { _id: false }
);

const MenuSchema = new mongoose.Schema(
  {
    menu_code: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      unique: true
    }, // kode unik
    name: { type: String, trim: true, required: true },
    price: { type: Number, min: 0, required: true },
    description: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, required: true }, // simpan URL; upload bisa nyusul
    addons: { type: [AddonSchema], default: [] },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Pencarian by name cepat
MenuSchema.index({ name: 1 });

module.exports = mongoose.models.Menu || mongoose.model('Menu', MenuSchema);
