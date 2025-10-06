module.exports = function requirePageAccess(pageKey) {
  return (req, res, next) => {
    const u = req.user;
    if (!u) return res.status(401).json({ message: 'Unauthorized' });
    if (u.role === 'owner') return next(); // owner bypass
    if (u.pages && u.pages[pageKey] === true) return next();
    return res
      .status(403)
      .json({ message: `Tidak punya akses ke halaman ${pageKey}` });
  };
};
