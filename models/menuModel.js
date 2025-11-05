const mongoose = require('mongoose');
const { BIG_CATEGORIES } = require('./menuSubcategoryModel.js');

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
    },
    isActive: { type: Boolean, default: true }
  },
  { toJSON: { getters: true }, toObject: { getters: true } }
);

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

    // Kategori besar (fixed)
    bigCategory: {
      type: String,
      enum: BIG_CATEGORIES,
      required: true,
      index: true
    },

    // Kategori spesifik (CRUD) — opsional
    subcategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuSubcategory',
      default: null,
      index: true
    },

    // Rekomendasi (admin)
    isRecommended: { type: Boolean, default: false, index: true },

    description: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, required: true },

    price: { type: PriceSchema, required: true },

    // Addon hanya untuk non-package
    addons: { type: [AddonSchema], default: [] },

    // Isi paket (snapshot) — hanya untuk package
    packageItems: { type: [PackageItemSchema], default: [] },

    isActive: { type: Boolean, default: true, index: true }
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
MenuSchema.index({ bigCategory: 1, isActive: 1 });
MenuSchema.index({ name: 'text', description: 'text' });

/* ========= Validators & Guards ========= */
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

MenuSchema.pre('validate', function () {
  const isPackage = this.bigCategory === 'package';

  if (isPackage && Array.isArray(this.addons) && this.addons.length > 0) {
    this.invalidate(
      'addons',
      'Menu kategori package tidak boleh memiliki addons'
    );
  }
  if (
    !isPackage &&
    Array.isArray(this.packageItems) &&
    this.packageItems.length > 0
  ) {
    this.invalidate(
      'packageItems',
      'Hanya menu kategori package yang boleh memiliki isi paket'
    );
  }

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

/* ========= Virtual: price.final ========= */
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

/* ========= Helper: snapshot item paket ========= */
MenuSchema.statics.makePackageItemFromMenu = function (menuDoc, qty = 1) {
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
