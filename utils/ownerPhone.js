function getOwnerPhone() {
  const raw = (process.env.OWNER_WA || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
module.exports = { getOwnerPhone };
