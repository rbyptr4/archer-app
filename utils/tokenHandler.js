// utils/tokenHandler.js
const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

const TTL_MS = 60 * 1000; // 60s cache ringan
const userCache = new Map(); // key: userId, val: { data, exp }

function normalizePagesOut(pages) {
  if (!pages) return {};
  return pages instanceof Map ? Object.fromEntries(pages) : pages;
}

async function loadUserFresh(userId) {
  const doc = await User.findById(userId).select('name role pages').lean();
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: doc.name,
    role: doc.role,
    pages: normalizePagesOut(doc.pages)
  };
}

async function getUserWithCache(userId) {
  const hit = userCache.get(userId);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.data;
  const fresh = await loadUserFresh(userId);
  if (fresh) userCache.set(userId, { data: fresh, exp: now + TTL_MS });
  return fresh;
}

const validateToken = asyncHandler(async (req, res, next) => {
  const bearer = req.headers.authorization;
  const token =
    req.cookies?.accessToken ||
    (bearer && bearer.startsWith('Bearer ') ? bearer.split(' ')[1] : null);

  if (!token) {
    return res.status(401).json({
      success: false,
      title: 'Unauthorized',
      message: 'Token tidak ditemukan',
      hint: {
        hasCookieHeader: Boolean(req.headers.cookie),
        hasAccessCookie: Boolean(req.cookies?.accessToken),
        hasAuthHeader: Boolean(req.headers.authorization)
      }
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    // kompatibel: sub atau id
    const userId = String(decoded.sub || decoded.id || '');
    if (!userId) {
      return res.status(401).json({
        success: false,
        title: 'Unauthorized',
        message: 'Payload token tidak valid (tanpa sub/id)'
      });
    }

    // ambil role & pages dari DB (source of truth)
    const user = await getUserWithCache(userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        title: 'Unauthorized',
        message: 'User tidak ditemukan'
      });
    }

    req.user = {
      id: user.id,
      role: user.role,
      name: user.name,
      pages: user.pages // { kitchen: true, orders: false, ... }
    };
    return next();
  } catch (e) {
    return res.status(401).json({
      success: false,
      title: 'Unauthorized',
      message: 'Token tidak valid atau expired',
      code: 'ACCESS_MISSING',
      hint: {
        hasAccessCookie: false,
        hasRefreshCookie: !!req.cookies?.refreshToken
      }
    });
  }
});

module.exports = validateToken;
