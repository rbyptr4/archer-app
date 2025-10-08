// validators/menu.validation.js
const Joi = require('joi');

// ===== Utils =====
const objectId = () =>
  Joi.string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/)
    .message('ID tidak valid');

// ===== Subschemas =====
const addonSchema = Joi.object({
  name: Joi.string().min(1).max(100).required().messages({
    'string.base': 'Nama add-on harus berupa teks',
    'string.empty': 'Nama add-on tidak boleh kosong',
    'string.min': 'Nama add-on minimal {#limit} karakter',
    'string.max': 'Nama add-on maksimal {#limit} karakter',
    'any.required': 'Nama add-on wajib diisi'
  }),
  price: Joi.number().min(0).default(0).messages({
    'number.base': 'Harga add-on harus berupa angka',
    'number.min': 'Harga add-on minimal {#limit}'
  })
});

const packageItemSchema = Joi.object({
  menu: objectId().required().messages({
    'any.required': 'Menu item paket wajib diisi'
  }),
  qty: Joi.number().integer().min(1).default(1).messages({
    'number.base': 'Qty harus berupa angka',
    'number.min': 'Qty minimal {#limit}'
  }),
  nameSnapshot: Joi.string().trim().min(1).max(200).required().messages({
    'any.required': 'Snapshot nama item paket wajib diisi'
  }),
  priceSnapshot: Joi.number().min(0).required().messages({
    'number.min': 'Harga snapshot minimal {#limit}',
    'any.required': 'Snapshot harga item paket wajib diisi'
  })
});

const priceSchema = Joi.object({
  original: Joi.number().min(0).messages({
    'number.base': 'Harga asli harus berupa angka',
    'number.min': 'Harga asli minimal {#limit}'
  }),
  discountMode: Joi.string()
    .valid('none', 'percent', 'manual')
    .default('none')
    .messages({
      'any.only': 'Mode diskon harus salah satu dari: none, percent, manual'
    }),
  discountPercent: Joi.number()
    .min(0)
    .max(100)
    .when('discountMode', {
      is: 'percent',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    })
    .messages({
      'number.min': 'Persentase diskon minimal {#limit}',
      'number.max': 'Persentase diskon maksimal {#limit}',
      'any.required': 'Persentase diskon wajib diisi saat mode percent'
    }),
  manualPromoPrice: Joi.number()
    .min(0)
    .when('discountMode', {
      is: 'manual',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    })
    .messages({
      'number.min': 'Harga promo minimal {#limit}',
      'any.required': 'Harga promo wajib diisi saat mode manual'
    })
})
  // Guard: manualPromoPrice <= original saat mode manual
  .custom((value, helpers) => {
    const { discountMode, manualPromoPrice, original } = value || {};
    if (discountMode === 'manual') {
      if (typeof original !== 'number') {
        return helpers.error('any.custom', {
          message: 'Harga asli wajib ada saat mode manual'
        });
      }
      if (manualPromoPrice > original) {
        return helpers.error('any.custom', {
          message: 'Harga promo (manual) tidak boleh melebihi harga asli'
        });
      }
    }
    return value;
  }, 'Guard diskon');

// ===== Enums =====
const CATEGORY_ENUM = [
  'food',
  'drink',
  'dessert',
  'package',
  'special',
  'snack',
  'merchandise'
];

// ===== Create Schema =====
const createMenuSchema = Joi.object({
  menu_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9\-_.]+$/)
    .min(2)
    .max(32)
    .required()
    .messages({
      'string.empty': 'Kode menu tidak boleh kosong',
      'string.pattern.base':
        'Kode hanya boleh huruf besar, angka, titik, strip, atau underscore',
      'string.min': 'Kode minimal {#limit} karakter',
      'string.max': 'Kode maksimal {#limit} karakter',
      'any.required': 'Kode menu wajib diisi'
    }),

  name: Joi.string().trim().min(3).max(120).required().messages({
    'string.min': 'Nama menu minimal {#limit} karakter',
    'string.max': 'Nama menu maksimal {#limit} karakter',
    'any.required': 'Nama menu wajib diisi'
  }),

  category: Joi.string()
    .valid(...CATEGORY_ENUM)
    .required()
    .messages({
      'any.only': `Kategori harus salah satu dari: ${CATEGORY_ENUM.join(', ')}`,
      'any.required': 'Kategori wajib diisi'
    }),

  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),

  imageUrl: Joi.string().uri().required().messages({
    'string.uri': 'imageUrl harus berupa URL yang valid',
    'any.required': 'imageUrl wajib diisi'
  }),

  // price.original wajib untuk non-package; opsional untuk package (akan auto dari snapshot)
  price: priceSchema.when('category', {
    is: 'package',
    then: priceSchema.keys({
      original: priceSchema.extract('original').optional()
    }),
    otherwise: priceSchema.keys({
      original: priceSchema.extract('original').required()
    })
  }),

  // Addons hanya untuk non-package
  addons: Joi.alternatives().conditional('category', {
    is: 'package',
    then: Joi.forbidden().messages({
      'any.unknown': 'Menu kategori package tidak boleh memiliki addons'
    }),
    otherwise: Joi.array().items(addonSchema).default([])
  }),

  // packageItems hanya untuk package
  packageItems: Joi.alternatives().conditional('category', {
    is: 'package',
    then: Joi.array().items(packageItemSchema).min(1).messages({
      'array.min': 'Menu package minimal memiliki 1 item'
    }),
    otherwise: Joi.forbidden().messages({
      'any.unknown': 'Hanya menu kategori package yang boleh memiliki isi paket'
    })
  }),

  isActive: Joi.boolean().default(true)
})
  .prefs({ abortEarly: false, stripUnknown: true })
  .messages({
    'object.unknown': 'Field "{#label}" tidak dikenali'
  });

// ===== Update Schema =====
const updateMenuSchema = Joi.object({
  menu_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9\-_.]+$/)
    .min(2)
    .max(32)
    .messages({
      'string.pattern.base':
        'Kode hanya boleh huruf besar, angka, titik, strip, atau underscore',
      'string.min': 'Kode minimal {#limit} karakter',
      'string.max': 'Kode maksimal {#limit} karakter'
    }),

  name: Joi.string().trim().min(3).max(120).messages({
    'string.min': 'Nama menu minimal {#limit} karakter',
    'string.max': 'Nama menu maksimal {#limit} karakter'
  }),

  category: Joi.string()
    .valid(...CATEGORY_ENUM)
    .messages({
      'any.only': `Kategori harus salah satu dari: ${CATEGORY_ENUM.join(', ')}`
    }),

  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),

  imageUrl: Joi.string().uri().messages({
    'string.uri': 'imageUrl harus berupa URL yang valid'
  }),

  // Boleh mengubah struktur price parsial, tetap kena guard
  price: priceSchema,

  // Addons / packageItems mengikuti kategori (pakai when ke category atau context)
  addons: Joi.array().items(addonSchema),

  packageItems: Joi.array().items(packageItemSchema),

  isActive: Joi.boolean()
})
  .custom((value, helpers) => {
    // Evaluasi kondisi addons vs packageItems berdasarkan category "baru" (jika diubah) atau "lama" via context.
    // Pasang category di context saat validate (opts.context.categoryCurrent).
    const cat =
      value.category ||
      (helpers?.prefs?.context && helpers.prefs.context.categoryCurrent);

    if (cat === 'package') {
      if (Array.isArray(value.addons)) {
        return helpers.error('any.custom', {
          message: 'Menu kategori package tidak boleh memiliki addons'
        });
      }
      // package: packageItems boleh kosong (server bisa auto dari util), tapi tetap valid array jika dikirim
    } else if (cat && cat !== 'package') {
      if (Array.isArray(value.packageItems)) {
        return helpers.error('any.custom', {
          message:
            'Hanya menu kategori package yang boleh memiliki isi paket (packageItems)'
        });
      }
    }
    return value;
  }, 'Guard addons vs packageItems')
  .min(1)
  .prefs({ abortEarly: false, stripUnknown: true })
  .messages({
    'object.min': 'Isi setidaknya satu field untuk diperbarui'
  });

module.exports = {
  createMenuSchema,
  updateMenuSchema
};
