const Joi = require('joi');

const ALLOWED_PAGES = ['menu', 'employees', 'members'];

// schema untuk pages (opsional di register)
const pagesSchema = Joi.object()
  .pattern(
    Joi.string().valid(...ALLOWED_PAGES),
    Joi.boolean().messages({
      'boolean.base': 'Nilai akses halaman harus berupa true/false'
    })
  )
  .messages({
    'object.base': 'Pages harus berupa object',
    'object.pattern.match': 'Nama halaman tidak diizinkan'
  });

/* ========== Register Employee Schema ========== */
const registerSchema = Joi.object({
  name: Joi.string().min(3).max(100).required().messages({
    'string.base': 'Nama harus berupa teks',
    'string.empty': 'Nama tidak boleh kosong',
    'string.min': 'Nama minimal {#limit} karakter',
    'string.max': 'Nama maksimal {#limit} karakter',
    'any.required': 'Nama wajib diisi'
  }),

  email: Joi.string().email().required().messages({
    'string.email': 'Format email tidak valid',
    'string.empty': 'Email tidak boleh kosong',
    'any.required': 'Email wajib diisi'
  }),

  password: Joi.string().min(6).max(50).required().messages({
    'string.base': 'Password harus berupa teks',
    'string.empty': 'Password tidak boleh kosong',
    'string.min': 'Password minimal {#limit} karakter',
    'string.max': 'Password maksimal {#limit} karakter',
    'any.required': 'Password wajib diisi'
  }),

  phone: Joi.string()
    .pattern(/^[0-9]+$/)
    .min(10)
    .max(15)
    .messages({
      'string.pattern.base': 'Nomor HP hanya boleh berisi angka',
      'string.min': 'Nomor HP minimal {#limit} digit',
      'string.max': 'Nomor HP maksimal {#limit} digit'
    }),

  // opsional: set pages saat create employee
  pages: pagesSchema.optional()
});

/* ========== Update Employee Schema ========== */
const updateEmployeeSchema = Joi.object({
  name: Joi.string().min(3).max(100).optional().messages({
    'string.base': 'Nama harus berupa teks',
    'string.empty': 'Nama tidak boleh kosong',
    'string.min': 'Nama minimal {#limit} karakter',
    'string.max': 'Nama maksimal {#limit} karakter'
  }),

  email: Joi.string().email().optional().messages({
    'string.email': 'Format email tidak valid',
    'string.empty': 'Email tidak boleh kosong'
  }),

  phone: Joi.string()
    .allow('', null)
    .pattern(/^[0-9]+$/)
    .min(10)
    .max(15)
    .optional()
    .messages({
      'string.pattern.base': 'Nomor HP hanya boleh berisi angka',
      'string.min': 'Nomor HP minimal {#limit} digit',
      'string.max': 'Nomor HP maksimal {#limit} digit'
    }),

  // password baru opsional
  newPassword: Joi.string().min(6).max(50).optional().messages({
    'string.base': 'Password harus berupa teks',
    'string.empty': 'Password tidak boleh kosong',
    'string.min': 'Password minimal {#limit} karakter',
    'string.max': 'Password maksimal {#limit} karakter'
  })
});

module.exports = {
  registerSchema,
  updateEmployeeSchema
};
