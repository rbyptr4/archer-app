const Joi = require('joi');

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

  phones: Joi.string()
    .pattern(/^[0-9]+$/)
    .min(10)
    .max(15)
    .messages({
      'string.pattern.base': 'Nomor HP hanya boleh berisi angka',
      'string.min': 'Nomor HP minimal {#limit} digit',
      'string.max': 'Nomor HP maksimal {#limit} digit'
    })
});

module.exports = {
  registerSchema
};
