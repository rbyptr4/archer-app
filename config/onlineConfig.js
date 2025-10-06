module.exports = {
  FULFILLMENT_TYPES: ['dine_in', 'delivery'],
  DELIVERY_PRICE_PER_KM: Number(process.env.DELIVERY_PRICE_PER_KM || 5000),
  DELIVERY_MAX_RADIUS_KM: Number(process.env.DELIVERY_MAX_RADIUS_KM || 10),
  CAFE_COORD: {
    lat: Number(process.env.CAFE_LAT || -7.024093728490666),
    lng: Number(process.env.CAFE_LNG || 107.53734260542981)
  }
};
