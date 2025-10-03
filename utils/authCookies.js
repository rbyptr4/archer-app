const isProd = process.env.NODE_ENV === 'production';

const sameSite = process.env.COOKIE_SAMESITE || 'none';
const secure =
  process.env.COOKIE_SECURE?.toLowerCase() === 'true'
    ? true
    : process.env.COOKIE_SECURE?.toLowerCase() === 'false'
    ? false
    : isProd; // default ikuti production

const baseCookie = {
  httpOnly: true,
  secure, // https-only kalau true
  sameSite, // 'none' untuk cross-site
  path: '/' // global
};

module.exports = { baseCookie, isProd };
