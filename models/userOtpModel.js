// models/userOtpModel.js
const mongoose = require('mongoose');

const UserOtpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    code_hash: { type: String, required: true },
    purpose: { type: String, required: true, index: true }, // example: 'forgot_password', 'change_phone'
    meta: { type: mongoose.Schema.Types.Mixed }, // { userId, extra... }
    last_sent_at: { type: Date, default: Date.now },
    used_at: { type: Date, default: null },
    attempt_count: { type: Number, default: 0 },
    expires_at: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

// TTL index untuk auto-delete dokumen setelah 1 hari dari createdAt
// expireAfterSeconds bekerja on the indexed field's value relative to now.
// Karena kita ingin auto-delete ~1 hari setelah dibuat, set expireAfterSeconds=86400 on createdAt.
UserOtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

// Optional convenience index
UserOtpSchema.index({ phone: 1, purpose: 1, createdAt: -1 });

module.exports = mongoose.model('UserOtp', UserOtpSchema);
