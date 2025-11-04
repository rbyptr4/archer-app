const crypto = require('crypto');

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN || 5);

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digit
}
function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}
function expiresAtFromNow(min = OTP_TTL_MIN) {
  return new Date(Date.now() + min * 60 * 1000);
}

module.exports = { generateOtp, hashOtp, expiresAtFromNow, OTP_TTL_MIN };
