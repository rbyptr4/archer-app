const mongoose = require('mongoose');

const MemberSessionSchema = new mongoose.Schema(
  {
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      required: true,
      index: true
    },
    device_id: { type: String, required: true, index: true },
    refresh_hash: { type: String, required: true, unique: true },
    user_agent: { type: String },
    ip: { type: String },
    expires_at: { type: Date, required: true, index: true },
    revoked_at: { type: Date, default: null },
    rotated_from: { type: String, default: null },
    rotated_to: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.MemberSession ||
  mongoose.model('MemberSession', MemberSessionSchema);
