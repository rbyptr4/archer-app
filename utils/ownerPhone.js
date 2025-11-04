function getOwnerPhone() {
  const v = (process.env.OWNER_WA || '').trim();
  return v || null;
}
module.exports = { getOwnerPhone };
