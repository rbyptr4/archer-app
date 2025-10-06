const mongoose = require('mongoose');

const AddonSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    price: {
      type: Number,
      min: 0,
      default: 0,
      set: (v) => Math.round(Number(v || 0)),
      get: (v) => Math.round(Number(v || 0))
    }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

const MenuSchema = new mongoose.Schema(
  {
    menu_code: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      unique: true
    },
    name: { type: String, trim: true, required: true },
    price: {
      type: Number,
      min: 0,
      required: true,
      set: (v) => Math.round(Number(v || 0)),
      get: (v) => Math.round(Number(v || 0))
    },
    description: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, required: true },
    addons: { type: [AddonSchema], default: [] },
    isActive: { type: Boolean, default: true }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

MenuSchema.index({ name: 1 });
MenuSchema.index({ isActive: 1, name: 1 });
MenuSchema.index({ name: 'text', description: 'text' });

MenuSchema.path('addons').validate(function (arr) {
  if (!Array.isArray(arr)) return true;
  const names = arr
    .map((a) =>
      String(a.name || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  return names.length === new Set(names).size;
}, 'Duplikat nama addon pada menu ini');

module.exports = mongoose.models.Menu || mongoose.model('Menu', MenuSchema);
