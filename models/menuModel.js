// models/menuModel.js
const mongoose = require('mongoose');

/* ========= SubSchemas ========= */
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

/**
 * Item di dalam paket. Disimpan sebagai SNAPSHOT agar histori aman.
 * Tidak ada addons untuk package (custom via notes di cart/order).
 */
const PackageItemSchema = new mongoose.Schema(
  {
    menu: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
    qty: {
      type: Number,
      min: 1,
      default: 1,
      set: (v) => Math.max(1, Math.round(Number(v || 1))),
      get: (v) => Math.round(Number(v || 1))
    },
    nameSnapshot: { type: String, trim: true, required: true },
    priceSnapshot: {
      type: Number,
      min: 0,
      required: true,
      set: (v) => Math.round(Number(v || 0)),
      get: (v) => Math.round(Number(v || 0))
    }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

const PriceSchema = new mongoose.Schema(
  {
    original: {
      type: Number,
      min: 0,
      required: true,
      set: (v) => Math.round(Number(v || 0)),
      get: (v) => Math.round(Number(v || 0))
    },
    // 'none' | 'percent' | 'manual'
    discountMode: {
      type: String,
      enum: ['none', 'percent', 'manual'],
      default: 'none'
    },
    discountPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
      set: (v) => Math.round(Number(v || 0)),
      get: (v) => Math.round(Number(v || 0))
    },
    manualPromoPrice: {
      type: Number,
      min: 0,
      default: 0,
      set: (v) => Math.round(Number(v || 0)),
      get: (v) => Math.round(Number(v || 0))
    }
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } }
);

/* ========= Main Schema ========= */
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

    category: {
      type: String,
      enum: [
        'food',
        'drink',
        'dessert',
        'package',
        'special',
        'snack',
        'merchandise'
      ],
      required: true,
      index: true
    },

    description: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, required: true },

    price: { type: PriceSchema, required: true },

    // Addon HANYA untuk non-package
    addons: { type: [AddonSchema], default: [] },

    // Isi paket (snapshot). Tidak ada addons untuk paket.
    packageItems: { type: [PackageItemSchema], default: [] },

    isActive: { type: Boolean, default: true }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { getters: true, virtuals: true },
    toObject: { getters: true, virtuals: true }
  }
);

/* ========= Index ========= */
MenuSchema.index({ name: 1 });
MenuSchema.index({ isActive: 1, name: 1 });
MenuSchema.index({ category: 1, isActive: 1 });
MenuSchema.index({ name: 'text', description: 'text' });

/* ========= Validators & Guards ========= */
// Unik nama addon per menu
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

// Guard addons vs packageItems + auto original utk package
MenuSchema.pre('validate', function () {
  const isPackage = this.category === 'package';

  // addons hanya untuk non-package
  if (isPackage && this.addons && this.addons.length > 0) {
    this.invalidate(
      'addons',
      'Menu kategori package tidak boleh memiliki addons'
    );
  }

  // packageItems hanya untuk package
  if (!isPackage && this.packageItems && this.packageItems.length > 0) {
    this.invalidate(
      'packageItems',
      'Hanya menu kategori package yang boleh memiliki isi paket'
    );
  }

  // aturan diskon
  const { discountMode, discountPercent, manualPromoPrice, original } =
    this.price || {};
  if (
    discountMode === 'percent' &&
    (discountPercent < 0 || discountPercent > 100)
  ) {
    this.invalidate('price.discountPercent', 'Persentase diskon harus 0–100');
  }
  if (discountMode === 'manual' && manualPromoPrice > original) {
    this.invalidate(
      'price.manualPromoPrice',
      'Harga promo (manual) tidak boleh melebihi harga asli'
    );
  }

  // jika package & original belum diisi → auto dari sum snapshot
  if (isPackage) {
    const sum = (this.packageItems || []).reduce(
      (acc, it) => acc + Number(it.priceSnapshot || 0) * Number(it.qty || 0),
      0
    );
    if (!this.price || !Number(this.price.original)) {
      this.price = this.price || {};
      this.price.original = Math.round(sum);
    }
  }
});

/* ========= Virtual final price ========= */
MenuSchema.virtual('price.final').get(function () {
  if (!this.price) return 0;
  const { original, discountMode, discountPercent, manualPromoPrice } =
    this.price;
  if (discountMode === 'manual')
    return Math.round(Number(manualPromoPrice || 0));
  if (discountMode === 'percent') {
    const p = Math.max(0, Math.min(100, Number(discountPercent || 0)));
    return Math.round(Number(original || 0) * (1 - p / 100));
  }
  return Math.round(Number(this.price.original || 0));
});

/* ========= Helper static: bikin snapshot item paket ========= */
MenuSchema.statics.makePackageItemFromMenu = function (menuDoc, qty = 1) {
  // ambil final price saat ini sebagai snapshot (boleh diganti original kalau mau)
  const finalPrice =
    (menuDoc.price &&
      (menuDoc.price.discountMode === 'manual'
        ? Number(menuDoc.price.manualPromoPrice || 0)
        : menuDoc.price.discountMode === 'percent'
        ? Math.round(
            Number(menuDoc.price.original || 0) *
              (1 - Number(menuDoc.price.discountPercent || 0) / 100)
          )
        : Number(menuDoc.price.original || 0))) ||
    0;

  return {
    menu: menuDoc._id,
    qty: Math.max(1, Math.round(Number(qty || 1))),
    nameSnapshot: menuDoc.name,
    priceSnapshot: Math.round(finalPrice)
  };
};

module.exports = mongoose.models.Menu || mongoose.model('Menu', MenuSchema);
