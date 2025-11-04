const axios = require('axios');

const BASE = process.env.WABLAS_BASE || 'https://tegal.wablas.com/api';
const BASE_V2 = process.env.WABLAS_BASE_V2 || 'https://tegal.wablas.com/api/v2';
const AUTH = `${process.env.WABLAS_TOKEN}.${process.env.WABLAS_SECRET}`;

async function sendOtpText(phone, code) {
  const message = `
  🔐 Kode OTP Archers : *${code}*

_Jangan bagikan kode ini ke siapa pun._
_Berlaku 5 menit._

`;
  const res = await axios.get(`${BASE}/send-message`, {
    params: { phone, message, token: AUTH },
    timeout: 10000
  });
  return res.data;
}

module.exports = { sendOtpText };
