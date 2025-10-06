const asyncHandler = require('express-async-handler');
const Member = require('../../models/memberModel');
const throwError = require('../../utils/throwError');
const { baseCookie } = require('../../utils/authCookies');

const normalizePhone = (phone = '') =>
  phone.replace(/\s+/g, '').replace(/^(\+62|62|0)/, '0');

exports.loginMember = asyncHandler(async (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || !phone) throwError('Nama dan nomor HP wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);

  let member = await Member.findOne({
    phone: normalizedPhone,
    name: new RegExp(`^${name}$`, 'i')
  });

  if (!member) {
    member = await Member.create({
      name,
      phone: normalizedPhone,
      join_channel: 'self_order',
      visit_count: 1,
      last_visit_at: new Date(),
      is_active: true
    });
  } else {
    member.visit_count += 1;
    member.last_visit_at = new Date();
    if (!member.is_active) member.is_active = true;
    await member.save();
  }

  const memberToken = generateMemberToken(member);

  res
    .cookie('memberToken', memberToken, {
      ...baseCookie,
      httpOnly: true,
      maxAge: 360 * 60 * 1000 // 6 jam
    })
    .status(200)
    .json({
      message: 'Login member berhasil',
      member: {
        id: member._id,
        name: member.name,
        phone: member.phone,
        total_spend: member.total_spend,
        visit_count: member.visit_count
      },
      tokenExpiresInSec: 360000
    });
});

exports.member = asyncHandler(async (req, res) => {
  const member = await Member.findById(req.member.id).select(
    'name phone total_spend visit_count last_visit_at join_channel is_active updatedAt'
  );

  if (!member) throwError('Member tidak ditemukan!', 404);

  res.status(200).json({
    id: member._id,
    name: member.name,
    phone: member.phone,
    total_spend: member.total_spend,
    visit_count: member.visit_count,
    last_visit_at: member.last_visit_at,
    join_channel: member.join_channel,
    is_active: member.is_active,
    updatedAt: member.updatedAt
  });
});

exports.registerMember = asyncHandler(async (req, res) => {
  const { name, phone, join_channel = 'cashier' } = req.body || {};
  if (!name || !phone) throwError('Nama dan nomor telepon wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);

  let member = await Member.findOne({ phone: normalizedPhone });

  if (member) {
    member.visit_count += 1;
    member.last_visit_at = new Date();
    if (!member.is_active) member.is_active = true;
    await member.save();

    return res.status(200).json({
      message: 'Member sudah terdaftar, data diperbarui',
      member,
      isNew: false
    });
  }

  member = await Member.create({
    name,
    phone: normalizedPhone,
    join_channel,
    total_spend: 0,
    visit_count: 1,
    last_visit_at: new Date(),
    is_active: true
  });

  return res.status(201).json({
    message: 'Member baru berhasil didaftarkan',
    member,
    isNew: true
  });
});

exports.logoutMember = asyncHandler(async (req, res) => {
  try {
    res
      .clearCookie('memberToken', { ...baseCookie })
      .status(200)
      .json({ message: 'Logout member berhasil' });
  } catch (e) {
    res
      .clearCookie('memberToken', { ...baseCookie })
      .status(200)
      .json({ message: 'Logout member berhasil' });
  }
});
