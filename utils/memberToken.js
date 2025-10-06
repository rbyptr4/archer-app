const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TTL = process.env.MEMBER_ACCESS_TTL || '15m'; // akses pendek
const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 tahun

const ACCESS_COOKIE = 'memberToken'; // httpOnly
const REFRESH_COOKIE = 'mrt'; // httpOnly
const DEVICE_COOKIE = 'dev_id'; // non-HttpOnly (bind device)

const signAccessToken = (member) =>
  jwt.sign(
    { id: member._id.toString(), phone: member.phone, name: member.name },
    process.env.MEMBER_TOKEN_SECRET,
    { expiresIn: ACCESS_TTL }
  );

const generateOpaqueToken = (bytes = 48) =>
  crypto.randomBytes(bytes).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

module.exports = {
  ACCESS_TTL,
  REFRESH_TTL_MS,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  signAccessToken,
  generateOpaqueToken,
  hashToken
};
