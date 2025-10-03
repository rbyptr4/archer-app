// utils/parseRemember.js
module.exports = function parseRemember(req) {
  const b = req.body || {};
  const q = req.query || {};
  const raw =
    b.remember ??
    b.rememberMe ??
    b.remember_me ??
    q.remember ??
    q.rememberMe ??
    q.remember_me;

  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;

  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes' || s === 'y';
};
