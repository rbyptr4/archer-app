// models/guestSessionModel.js
const mongoose = require('mongoose');

const GuestSessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: () => new Date() },
  expiresAt: { type: Date, required: true, index: true },
  ip: { type: String, default: null },
  ua: { type: String, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
});

// TTL index: Mongo akan otomatis menghapus dokumen setelah expiresAt
GuestSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GuestSession', GuestSessionSchema);
