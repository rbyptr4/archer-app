const mongoose = require('mongoose');

const AppSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: String, required: true } // simpan hash/binary string, dsb
  },
  { timestamps: true, versionKey: false }
);

AppSettingSchema.statics.get = async function (key) {
  const doc = await this.findOne({ key }).lean();
  return doc?.value || null;
};

AppSettingSchema.statics.set = async function (key, value) {
  await this.findOneAndUpdate(
    { key },
    { $set: { value } },
    { upsert: true, new: true }
  );
};

module.exports =
  mongoose.models.AppSetting || mongoose.model('AppSetting', AppSettingSchema);
