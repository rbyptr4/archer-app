// utils/makeFileName.js
const path = require('path');

const safe = (s = '') =>
  String(s)
    .normalize('NFKD') // buang aksen
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_') // selain alnum -> _
    .replace(/^_+|_+$/g, '')
    .slice(0, 80); // batasi biar gak kepanjangan

const getExt = (originalname = '', mime = '') => {
  const byName = path.extname(originalname).replace('.', '').toLowerCase();
  if (byName) return byName;
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp'
  };
  return map[mime] || 'bin';
};

const ts = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

function buildMenuFileName(menuCode, menuName, originalname, mimeType) {
  const code = safe(String(menuCode).toUpperCase());
  const name = safe(menuName);
  const ext = getExt(originalname, mimeType);
  return `${code}_${name}_${ts()}.${ext}`;
}

module.exports = { buildMenuFileName };
