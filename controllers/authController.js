const asyncHandler = require('express-async-handler');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const User = require('../models/userModel');

const throwError = require('../utils/throwError');
const generateTokens = require('../utils/generateToken');
const parseRemember = require('../utils/parseRemember');
const { baseCookie } = require('../utils/authCookies');

const gateTtlMin = Math.max(
  1,
  parseInt(process.env.INTERNAL_GATE_TTL_MIN || '10', 10)
);

function signGateToken() {
  return jwt.sign(
    { kind: 'internal_gate' }, // minimal payload
    process.env.INTERNAL_GATE_SECRET,
    { expiresIn: `${gateTtlMin}m` }
  );
}

function verifyGateToken(token) {
  const p = jwt.verify(token, process.env.INTERNAL_GATE_SECRET);
  if (p?.kind !== 'internal_gate') throw new Error('Invalid gate kind');
  return p;
}

function requireInternalGate(req, res, next) {
  const tok = req.cookies?.internalGate;
  if (!tok) {
    return res.status(403).json({ message: 'Access gate required' });
  }
  try {
    verifyGateToken(tok);
    return next();
  } catch (_) {
    return res
      .clearCookie('internalGate', { ...baseCookie })
      .status(403)
      .json({ message: 'Access gate invalid/expired' });
  }
}

/* =============== Shared login executor (reusable) =============== */
async function performLogin(req, res) {
  const { email, password } = req.body || {};
  const remember = parseRemember(req);

  if (!email || !password) throwError('email & password wajib diisi', 400);

  const user = await User.findOne({ email }).select('+password');
  if (!user) throwError('Email tidak ditemukan', 401);

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throwError('Password invalid', 401);

  const { accessToken, refreshToken } = await generateTokens(user, {
    remember
  });

  const refreshCookieOpts = remember
    ? { ...baseCookie, maxAge: 7 * 24 * 60 * 60 * 1000 } // persistent 7d
    : { ...baseCookie }; // session cookie

  return res
    .cookie('accessToken', accessToken, {
      ...baseCookie,
      maxAge: 30 * 60 * 1000
    })
    .cookie('refreshToken', refreshToken, refreshCookieOpts)
    .json({
      message: 'Login berhasil',
      role: user.role,
      accessExpiresInSec: 1800
    });
}

/* ================= Access Gate Endpoints ================= */

// POST /auth/internal/access/verify
// body: { code: string }
exports.verifyInternalAccess = asyncHandler(async (req, res) => {
  const code = String(req.body?.code || '');
  if (!code) throwError('Kode akses wajib diisi', 400);

  const expected = String(process.env.INTERNAL_ACCESS_CODE || '');
  if (!expected) throwError('Server belum dikonfigurasi', 500);

  if (code !== expected) throwError('Kode akses salah', 401);

  const gateToken = signGateToken();

  return res
    .cookie('internalGate', gateToken, {
      ...baseCookie,
      maxAge: gateTtlMin * 60 * 1000 // ms
    })
    .json({ message: 'Access granted', ttlMin: gateTtlMin });
});

// GET /auth/internal/access/check
exports.checkInternalAccess = asyncHandler(async (req, res) => {
  const tok = req.cookies?.internalGate;
  if (!tok) return res.status(403).json({ ok: false, message: 'No gate' });
  try {
    verifyGateToken(tok);
    return res.json({ ok: true });
  } catch (_) {
    return res
      .clearCookie('internalGate', { ...baseCookie })
      .status(403)
      .json({ ok: false, message: 'Gate invalid/expired' });
  }
});

// POST /auth/internal/access/revoke
exports.revokeInternalAccess = asyncHandler(async (req, res) => {
  return res
    .clearCookie('internalGate', { ...baseCookie })
    .json({ message: 'Access gate revoked' });
});

// POST /auth/internal/login   (protected by gate)
exports.loginInternal = [
  requireInternalGate,
  asyncHandler(async (req, res) => {
    // Reuse performLogin
    return performLogin(req, res);
  })
];

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const remember = parseRemember(req);

  if (!email || !password) throwError('email & password wajib diisi', 400);

  const user = await User.findOne({ email }).select('+password');
  if (!user) throwError('Email tidak ditemukan', 401);

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throwError('Password invalid', 401);

  const { accessToken, refreshToken } = await generateTokens(user, {
    remember
  });

  const refreshCookieOpts = remember
    ? { ...baseCookie, maxAge: 7 * 24 * 60 * 60 * 1000 } // persistent 7d
    : { ...baseCookie }; // session cookie (tanpa maxAge)

  res
    .cookie('accessToken', accessToken, {
      ...baseCookie,
      maxAge: 30 * 60 * 1000
    })
    .cookie('refreshToken', refreshToken, refreshCookieOpts)
    .json({
      message: 'Login berhasil',
      role: user.role,
      accessExpiresInSec: 1800
    });
});

exports.me = asyncHandler(async (req, res) => {
  const u = await User.findById(req.user.id).select(
    'name email role phone pages updatedAt'
  );
  if (!u) throwError('User tidak ditemukan!', 404);

  let pages = u.pages;
  if (pages && pages instanceof Map) pages = Object.fromEntries(pages);

  res.status(200).json({
    id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    phone: u.phone,
    pages,
    updatedAt: u.updatedAt
  });
});

exports.refreshToken = asyncHandler(async (req, res) => {
  const hasCookieHeader = !!req.headers.cookie;
  const token = req.cookies?.refreshToken;

  if (!token) {
    return res.status(401).json({ message: 'No refresh token' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
  } catch (e) {
    return res
      .clearCookie('accessToken', { ...baseCookie })
      .clearCookie('refreshToken', { ...baseCookie })
      .status(401)
      .json({ message: 'Refresh token invalid/expired' });
  }

  const user = await User.findById(payload.sub).select(
    '+refreshToken +prevRefreshToken role name'
  );
  if (!user) {
    return res
      .clearCookie('accessToken', { ...baseCookie })
      .clearCookie('refreshToken', { ...baseCookie })
      .status(401)
      .json({ message: 'Refresh token invalid' });
  }

  const matchCurrent = user.refreshToken === token;
  const matchPrev = user.prevRefreshToken === token;

  const remember = !!payload.remember;
  const refreshCookieOpts = remember
    ? { ...baseCookie, maxAge: 7 * 24 * 60 * 60 * 1000 }
    : { ...baseCookie };

  if (matchPrev) {
    const newAccessToken = jwt.sign(
      { sub: user._id.toString(), role: user.role, name: user.name },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: '30m' }
    );

    return res
      .cookie('accessToken', newAccessToken, {
        ...baseCookie,
        maxAge: 30 * 60 * 1000
      })
      .cookie('refreshToken', user.refreshToken, refreshCookieOpts)
      .json({
        message: 'Access token refreshed (prev accepted, upgraded to current)'
      });
  }

  if (!matchCurrent) {
    return res
      .clearCookie('accessToken', { ...baseCookie })
      .clearCookie('refreshToken', { ...baseCookie })
      .status(401)
      .json({ message: 'Refresh token invalid' });
  }

  const newAccessToken = jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: '30m' }
  );

  const newRefreshToken = jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name, remember },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: '7d' }
  );

  const upd = await User.updateOne(
    { _id: user._id, refreshToken: token },
    { $set: { prevRefreshToken: token, refreshToken: newRefreshToken } }
  );

  if (upd.modifiedCount === 0) {
    const latest = await User.findById(user._id).select('refreshToken');
    return res
      .cookie('accessToken', newAccessToken, {
        ...baseCookie,
        maxAge: 30 * 60 * 1000
      })
      .cookie('refreshToken', latest.refreshToken || token, refreshCookieOpts)
      .json({ message: 'Access token refreshed (race-safe upgraded)' });
  }

  return res
    .cookie('accessToken', newAccessToken, {
      ...baseCookie,
      maxAge: 30 * 60 * 1000
    })
    .cookie('refreshToken', newRefreshToken, refreshCookieOpts)
    .json({ message: 'Access token berhasil di refresh' });
});

exports.logout = asyncHandler(async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
        await User.findByIdAndUpdate(payload.sub, {
          refreshToken: null,
          prevRefreshToken: null
        });
      } catch (_) {}
    }

    res
      .clearCookie('internalGate', { ...baseCookie })
      .clearCookie('accessToken', { ...baseCookie })
      .clearCookie('refreshToken', { ...baseCookie })
      .json({ message: 'Berhasil logout' });
  } catch (_) {
    res
      .clearCookie('internalGate', { ...baseCookie })
      .clearCookie('accessToken', { ...baseCookie })
      .clearCookie('refreshToken', { ...baseCookie })
      .status(200)
      .json({ message: 'Berhasil logout' });
  }
});
