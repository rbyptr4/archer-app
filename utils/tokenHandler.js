const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');

const validateToken = asyncHandler(async (req, res, next) => {
  const bearer = req.headers.authorization;
  const token =
    req.cookies?.accessToken ||
    (bearer && bearer.startsWith('Bearer ') ? bearer.split(' ')[1] : null);

  if (!token) {
    console.log('[validateToken] NO TOKEN', {
      url: req.originalUrl,
      hasCookieHeader: !!req.headers.cookie,
      cookieKeys: Object.keys(req.cookies || {}),
      hasAccessCookie: !!req.cookies?.accessToken,
      hasAuthHeader: !!req.headers.authorization,
      origin: req.get('origin') || null,
      referer: req.get('referer') || null,
      secFetchSite: req.get('sec-fetch-site') || null,
      COOKIE_SAMESITE: process.env.COOKIE_SAMESITE,
      COOKIE_SECURE: process.env.COOKIE_SECURE
    });

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
    req.user = { id: decoded.sub, role: decoded.role, name: decoded.name };
    return next();
  } catch (e) {
    console.log('[validateToken] JWT ERROR', e?.message);
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
