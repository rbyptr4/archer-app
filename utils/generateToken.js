const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

const generateTokens = async (user, { remember = false } = {}) => {
  const sub = user._id.toString();

  const accessToken = jwt.sign(
    { sub, role: user.role, name: user.name },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: '30m' }
  );

  const refreshToken = jwt.sign(
    { sub, role: user.role, name: user.name, remember: !!remember },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: '7d' }
  );

  const current = await User.findById(sub).select('refreshToken');
  await User.findByIdAndUpdate(sub, {
    prevRefreshToken: current?.refreshToken || null,
    refreshToken
  });

  return { accessToken, refreshToken };
};

module.exports = generateTokens;
