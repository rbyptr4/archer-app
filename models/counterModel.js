const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  seq: { type: Number, default: 0 }
});
module.exports =
  mongoose.models.Counter || mongoose.model('Counter', CounterSchema);
