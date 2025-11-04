// models/memberOtpModel.js
const mongoose = require('mongoose');

const MemberOtpSchema = new mongoose.Schema(
  {
    phone: { type: String, index: true }, // nomor yang menerima OTP (format local 08... )
    code_hash: { type: String, required: true },
    expires_at: { type: Date, required: true },
    last_sent_at: { type: Date, required: true },
    attempt_count: { type: Number, default: 0 },
    used_at: { type: Date, default: null },

    // tambahan:
    purpose: { type: String, default: 'login' }, // 'login' | 'change_phone' | 'change_name' | 'forgot_name'
    meta: { type: mongoose.Schema.Types.Mixed, default: {} } // mis: { newPhone: '08...', newName: 'Fatan' }
  },
  { timestamps: true }
);

// index TTL agar otomatis terhapus jika expires_at lewat (optional)
MemberOtpSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.MemberOtp || mongoose.model('MemberOtp', MemberOtpSchema);
