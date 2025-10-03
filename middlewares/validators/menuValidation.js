const Joi = require('joi');

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

const createMenuSchema = Joi.object({
  menu_code: Joi.string()
    .trim()
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
    'string.base': 'Nama menu harus berupa teks',
    'string.empty': 'Nama menu tidak boleh kosong',
    'string.min': 'Nama menu minimal {#limit} karakter',
    'string.max': 'Nama menu maksimal {#limit} karakter',
    'any.required': 'Nama menu wajib diisi'
  }),
  price: Joi.number().min(0).required().messages({
    'number.base': 'Harga harus berupa angka',
    'number.min': 'Harga minimal {#limit}',
    'any.required': 'Harga wajib diisi'
  }),
  description: Joi.string().allow('').max(1000).messages({
    'string.base': 'Deskripsi harus berupa teks',
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),
  addons: Joi.array().items(addonSchema).default([]).messages({
    'array.base': 'Add-ons harus berupa array'
  }),
  isActive: Joi.boolean().default(true)
});

const updateMenuSchema = Joi.object({
  menu_code: Joi.string()
    .trim()
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
  price: Joi.number().min(0).messages({
    'number.base': 'Harga harus berupa angka',
    'number.min': 'Harga minimal {#limit}'
  }),
  description: Joi.string().allow('').max(1000).messages({
    'string.max': 'Deskripsi maksimal {#limit} karakter'
  }),
  addons: Joi.array().items(addonSchema).messages({
    'array.base': 'Add-ons harus berupa array'
  }),
  isActive: Joi.boolean()
})
  .min(1)
  .messages({
    'object.min': 'Isi setidaknya satu field untuk diperbarui'
  });

module.exports = { createMenuSchema, updateMenuSchema };
