// validators/menu.validation.js
const Joi = require('joi');

/* ====================== Utils ====================== */
const objectId = () =>
  Joi.string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/)
    .message('ID tidak valid');

const CATEGORY_ENUM = [
  'food',
  'drink',
  'dessert',
  'package',
  'special',
  'snack',
  'merchandise'
];

/* =================== Subschemas ==================== */
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

// Snapshot item paket (dipakai di level DB/response, BUKAN input create)
const packageItemSnapshotSchema = Joi.object({
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

// Input item paket saat CREATE/UPDATE paket (simple): menuId ATAU name + qty
const packageItemInputSchema = Joi.object({
  menu: objectId(), // opsional; kalau ada -> prioritas pakai ini
  name: Joi.string().trim().min(1).max(200), // fallback kalau tidak ada menu
  qty: Joi.number().integer().min(1).default(1).messages({
    'number.base': 'Qty harus berupa angka',
    'number.min': 'Qty minimal {#limit}'
  })
}).custom((v, h) => {
  if (!v.menu && !v.name) {
    return h.error('any.custom', {
      message: 'Item paket harus berisi "menu" (ObjectId) atau "name"'
    });
  }
  return v;
}, 'Guard item paket minimal menu atau name');

const priceSchemaBase = Joi.object({
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

/* ====================================================
   SKEMA MENU BIASA (NON-PACKAGE)
   Endpoint: /menus/create, /menus/update/:id
   ==================================================== */

// CREATE non-package
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

  bigCategory: Joi.string()
    .valid(...CATEGORY_ENUM.filter((c) => c !== 'package'))
    .required()
    .messages({
      'any.only': `Kategori harus salah satu dari: ${CATEGORY_ENUM.filter(
        (c) => c !== 'package'
      ).join(', ')}`,
      'any.required': 'Kategori wajib diisi'
    }),

  subcategoryId: objectId(), // opsional

  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),

  // imageUrl tidak diwajibkan karena biasanya upload via req.file
  imageUrl: Joi.string().uri().messages({
    'string.uri': 'imageUrl harus berupa URL yang valid'
  }),

  price: priceSchemaBase.keys({
    // untuk non-package original WAJIB
    original: priceSchemaBase.extract('original').required()
  }),

  addons: Joi.array().items(addonSchema).default([]),

  // larang packageItems pada non-package
  packageItems: Joi.forbidden().messages({
    'any.unknown':
      'Hanya menu kategori package yang boleh memiliki isi paket (packageItems)'
  }),

  isActive: Joi.boolean().default(true),
  isRecommended: Joi.boolean().default(false)
}).prefs({ abortEarly: false, stripUnknown: true });

// UPDATE non-package
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

  // tidak boleh ganti jadi 'package'
  bigCategory: Joi.string()
    .valid(...CATEGORY_ENUM.filter((c) => c !== 'package'))
    .messages({
      'any.only': `Kategori harus salah satu dari: ${CATEGORY_ENUM.filter(
        (c) => c !== 'package'
      ).join(', ')}`
    }),

  subcategoryId: objectId(), // opsional

  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),

  imageUrl: Joi.string().uri().messages({
    'string.uri': 'imageUrl harus berupa URL yang valid'
  }),

  price: priceSchemaBase, // partial OK

  addons: Joi.array().items(addonSchema),

  // tetap dilarang
  packageItems: Joi.forbidden().messages({
    'any.unknown':
      'Hanya menu kategori package yang boleh memiliki isi paket (packageItems)'
  }),

  isActive: Joi.boolean(),
  isRecommended: Joi.boolean()
})
  .min(1)
  .prefs({ abortEarly: false, stripUnknown: true })
  .messages({ 'object.min': 'Isi setidaknya satu field untuk diperbarui' });

const createPackageMenuSchema = Joi.object({
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

  // bigCategory dipaksa 'package' oleh controller; boleh diabaikan di payload
  bigCategory: Joi.string().valid('package').messages({
    'any.only': 'Kategori paket harus "package"'
  }),

  subcategoryId: objectId(), // opsional

  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),

  imageUrl: Joi.string().uri().messages({
    'string.uri': 'imageUrl harus berupa URL yang valid'
  }),

  // Untuk paket: original opsional (server bisa auto dari snapshot); diskon rules tetap berlaku
  price: priceSchemaBase.keys({
    original: priceSchemaBase.extract('original').optional()
  }),

  // input sederhana items (akan dinormalisasi server → packageItems snapshot)
  items: Joi.array().items(packageItemInputSchema).min(1).required().messages({
    'array.min': 'Menu package minimal memiliki 1 item',
    'any.required': 'Daftar items paket wajib diisi'
  }),

  // addons dilarang pada paket
  addons: Joi.forbidden().messages({
    'any.unknown': 'Menu kategori package tidak boleh memiliki addons'
  }),

  // packageItems snapshot TIDAK dikirim saat create
  packageItems: Joi.forbidden().messages({
    'any.unknown': 'Isi paket (snapshot) akan dibuat otomatis oleh server'
  }),

  isActive: Joi.boolean().default(true),
  isRecommended: Joi.boolean().default(false)
}).prefs({ abortEarly: false, stripUnknown: true });

// UPDATE package
const updatePackageMenuSchema = Joi.object({
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

  // tetap paket
  bigCategory: Joi.string().valid('package').messages({
    'any.only': 'Kategori paket harus "package"'
  }),

  subcategoryId: objectId(),

  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),

  imageUrl: Joi.string().uri().messages({
    'string.uri': 'imageUrl harus berupa URL yang valid'
  }),

  price: priceSchemaBase, // partial OK

  // update items sederhana → server akan re-build snapshot
  items: Joi.array().items(packageItemInputSchema),

  // tetap dilarang di payload update (dibuat server)
  packageItems: Joi.forbidden().messages({
    'any.unknown': 'Isi paket (snapshot) tidak boleh diedit langsung'
  }),

  // addons tetap dilarang
  addons: Joi.forbidden().messages({
    'any.unknown': 'Menu kategori package tidak boleh memiliki addons'
  }),

  isActive: Joi.boolean(),
  isRecommended: Joi.boolean()
})
  .min(1)
  .prefs({ abortEarly: false, stripUnknown: true })
  .messages({ 'object.min': 'Isi setidaknya satu field untuk diperbarui' });

module.exports = {
  createMenuSchema,
  updateMenuSchema,
  createPackageMenuSchema,
  updatePackageMenuSchema
};
