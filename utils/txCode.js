const Counter = require('../models/counterModel');

const pad = (n, len = 4) => String(n).padStart(len, '0');

exports.nextDailyTxCode = async (prefix = 'ARCH') => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dayKey = `TX:${y}${m}${d}`;

  const doc = await Counter.findOneAndUpdate(
    { key: dayKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );

  return `${prefix}-${y}${m}${d}-${pad(doc.seq)}`;
};
