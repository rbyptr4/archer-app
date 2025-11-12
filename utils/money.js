// utils/money.js (opsional) / atau taruh di atas orderModel.js
function int(v) {
  return Math.round(Number(v || 0));
}

function parsePpnRate() {
  const raw = Number(process.env.PPN_RATE ?? 0.11);
  if (!Number.isFinite(raw)) return 0.11;
  return raw > 1 ? raw / 100 : raw;
}

// 2% service fee
const SERVICE_FEE_RATE = Number(process.env.SERVICE_FEE_RATE ?? 0.02);

// Rounding ke 0/500/1000
function roundRupiahCustom(amount) {
  const n = int(amount);
  const rem = n % 1000;

  if (rem === 0) return n;

  if (rem <= 250) {
    // 0-250 → turun
    return n - rem;
  }

  if (rem > 750) {
    // >750 → naik
    return n + (1000 - rem);
  }

  // 251-750 → 500
  return n - rem + 500;
}

module.exports = {
  int,
  parsePpnRate,
  SERVICE_FEE_RATE,
  roundRupiahCustom
};
