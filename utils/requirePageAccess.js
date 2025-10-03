const User = require('../models/userModel');

function requirePageAccess(pageKey) {
  return async (req, res, next) => {
    const role = req.user?.role;
    if (!role) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (role === 'owner') {
      return next();
    }

    if (role === 'employee') {
      const user = await User.findById(req.user._id).lean();
      if (!user) return res.status(401).json({ message: 'User not found' });

      const pages =
        user.pages instanceof Map
          ? Object.fromEntries(user.pages)
          : user.pages || {};

      if (pages[pageKey]) return next();

      return res
        .status(403)
        .json({ message: `Forbidden: no access to ${pageKey}` });
    }

    return res.status(403).json({ message: 'Forbidden' });
  };
}

module.exports = requirePageAccess;
