// models/userModel.js
const mongoose = require('mongoose');

const ROLES = ['owner', 'employee', 'member'];

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },

    role: {
      type: String,
      enum: ROLES,
      required: true
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      unique: true
    },

    password: { type: String, required: true, select: false },
    phones: { type: Number },
    pages: {
      type: Map,
      of: Boolean,
      default: {}
    },
    refreshToken: { type: String, select: false, default: null },
    prevRefreshToken: { type: String, select: false, default: null }
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_, ret) => {
        delete ret.password;
        return ret;
      }
    }
  }
);

UserSchema.index(
  { role: 1 },
  { unique: true, partialFilterExpression: { role: 'owner' } }
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
