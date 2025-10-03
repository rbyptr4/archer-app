const asyncHandler = require('express-async-handler');
const User = require('../../models/userModel');
const throwError = require('../../utils/throwError');

exports.getMembers = asyncHandler(async (req, res) => {
  let { page = 1, limit = 10, search = '' } = req.query;

  page = parseInt(page) || 1;
  limit = parseInt(limit) || 10;

  const filter = { role: 'member' };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
    ];
  }
  const total = await User.countDocuments(filter);

  const members = await User.find(filter)
    .select('-password -refreshToken -prevRefreshToken')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  res.status(200).json({
    message: 'Daftar member',
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    data: members
  });
});

exports.deleteMember = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const member = await User.findOne({ _id: id, role: 'member' });
  if (!member) throwError('Member tidak ditemukan', 404);

  await User.deleteOne({ _id: id });

  res.status(200).json({ message: 'Member berhasil dihapus' });
});
