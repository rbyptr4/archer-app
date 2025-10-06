const jwt = require('jsonwebtoken');

module.exports = function authMemberOptional(req, _res, next) {
  try {
    const token = req.cookies?.memberToken || null;
    if (!token) return next();
    const payload = jwt.verify(token, process.env.MEMBER_TOKEN_SECRET);
    if (payload?.id)
      req.member = {
        id: String(payload.id),
        name: payload.name,
        phone: payload.phone
      };
  } catch (_) {}
  next();
};
