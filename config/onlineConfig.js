const DAYJS = require('dayjs');

const raw = process.env.DELIVERY_SLOTS || '12:00,16:00,21:00';
const DELIVERY_SLOTS = raw
  .split(',')
  .map((s) => String(s || '').trim())
  .filter(Boolean); // ['12:00','16:00','21:00']

module.exports = {
  FULFILLMENT_TYPES: ['dine_in', 'delivery'],
  DELIVERY_FLAT_FEE: Number(process.env.DELIVERY_FLAT_FEE ?? 5000),
  DELIVERY_MAX_RADIUS_KM: Number(process.env.DELIVERY_MAX_RADIUS_KM || 8),
  CAFE_COORD: {
    lat: Number(process.env.CAFE_LAT || -7.024093728490666),
    lng: Number(process.env.CAFE_LNG || 107.53734260542981)
  },
  DELIVERY_SLOTS
};
