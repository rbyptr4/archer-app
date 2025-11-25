const mongoose = require('mongoose');

const BannerSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, required: true },
    imageUrl: { type: String, trim: true, required: true },
    isActive: { type: Boolean, default: true }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

module.exports = mongoose.model('Banner', BannerSchema);
