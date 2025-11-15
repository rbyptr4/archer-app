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
function buildOrderProofFileName(transaction_code, originalname, mimeType) {
  if (!transaction_code) transaction_code = 'UNKNOWN';

  const code = safe(String(transaction_code).toUpperCase());
  const ext = getExt(originalname, mimeType);

  return `INVOICE_${code}_${ts()}.${ext}`;
}

// ===============================
// Build filename bukti pengeluaran
// ===============================
// expenseType = misal: "operasional", "bahan_baku", "listrik"
// tanggal = string "YYYYMMDD" atau object Date (fleksibel)
function buildExpenseProofFileName(
  expenseType,
  dateCreated,
  originalname,
  mimeType
) {
  const typeSafe = safe(expenseType || 'expense');

  let dateSafe = '';
  if (dateCreated instanceof Date) {
    const d = dateCreated;
    const pad = (n) => String(n).padStart(2, '0');
    dateSafe = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  } else {
    // diasumsikan string sudah diisi format: "20250101"
    dateSafe = safe(String(dateCreated || ''));
  }

  const ext = getExt(originalname, mimeType);

  return `${typeSafe}_${dateSafe}_${ts()}.${ext}`;
}

module.exports = {
  buildMenuFileName,
  buildOrderProofFileName,
  buildExpenseProofFileName
};
