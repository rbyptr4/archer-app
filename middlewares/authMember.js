const jwt = require('jsonwebtoken');
module.exports = function authMemberRequired(req, res, next) {
  try {
    const token = req.cookies?.memberToken || null;
    if (!token)
      return res.status(401).json({ message: 'Harus login sebagai member' });
    const payload = jwt.verify(token, process.env.MEMBER_TOKEN_SECRET);
    if (!payload?.id)
      return res.status(401).json({ message: 'Token member tidak valid' });
    req.member = {
      id: String(payload.id),
      name: payload.name,
      phone: payload.phone
    };
    next();
  } catch (_) {
    return res
      .status(401)
      .json({ message: 'Sesi member kedaluwarsa atau tidak valid' });
  }
};
