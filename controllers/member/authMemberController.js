const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Member = require('../../models/memberModel');
const MemberSession = require('../../models/memberSessionModel');
const throwError = require('../../utils/throwError');
const { baseCookie } = require('../../utils/authCookies');

const {
  ACCESS_TTL,
  REFRESH_TTL_MS,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  signAccessToken,
  generateOpaqueToken,
  hashToken
} = require('../../utils/memberToken');

const normalizePhone = (phone = '') =>
  phone.replace(/\s+/g, '').replace(/^(\+62|62|0)/, '0');

const oneYearMs = REFRESH_TTL_MS;

// cookie helpers
const cookieAccess = { ...baseCookie, httpOnly: true, maxAge: 15 * 60 * 1000 }; // 15m
const cookieRefresh = { ...baseCookie, httpOnly: true, maxAge: oneYearMs };
const cookieDevice = { ...baseCookie, httpOnly: false, maxAge: oneYearMs };

// ===== LOGIN (tanpa OTP dulu, bind ke device) =====
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

  // device id (ambil dari header/cookie; kalau tak ada, buat baru)
  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

  // issue tokens
  const accessToken = signAccessToken(member);
  const refreshToken = generateOpaqueToken();
  const refreshHash = hashToken(refreshToken);

  await MemberSession.create({
    member: member._id,
    device_id,
    refresh_hash: refreshHash,
    user_agent: req.get('user-agent') || '',
    ip: req.ip,
    expires_at: new Date(Date.now() + oneYearMs)
  });

  res
    .cookie(ACCESS_COOKIE, accessToken, cookieAccess)
    .cookie(REFRESH_COOKIE, refreshToken, cookieRefresh)
    .cookie(DEVICE_COOKIE, device_id, cookieDevice)
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
      access_expires: ACCESS_TTL,
      refresh_expires_ms: oneYearMs
    });
});

// ===== REFRESH (rotasi + device binding) =====
exports.refreshMember = asyncHandler(async (req, res) => {
  const rawRt = req.cookies?.[REFRESH_COOKIE];
  const dev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  if (!rawRt || !dev) throwError('Refresh tidak tersedia', 401);

  const rtHash = hashToken(rawRt);
  const sess = await MemberSession.findOne({ refresh_hash: rtHash }).lean();
  if (!sess) throwError('Sesi tidak valid', 401);
  if (sess.revoked_at) throwError('Sesi telah dicabut', 401);
  if (new Date(sess.expires_at).getTime() <= Date.now())
    throwError('Sesi kadaluarsa', 401);
  if (String(sess.device_id) !== String(dev))
    throwError('Perangkat tidak dikenal', 401);

  const member = await Member.findById(sess.member);
  if (!member || !member.is_active) throwError('Member tidak aktif', 401);

  // ROTATE
  const newRt = generateOpaqueToken();
  const newHash = hashToken(newRt);
  await MemberSession.updateOne(
    { _id: sess._id },
    {
      $set: {
        refresh_hash: newHash,
        rotated_from: rtHash,
        rotated_to: null,
        expires_at: new Date(Date.now() + oneYearMs),
        user_agent: req.get('user-agent') || '',
        ip: req.ip
      }
    }
  );

  const newAt = signAccessToken(member);

  res
    .cookie(ACCESS_COOKIE, newAt, cookieAccess)
    .cookie(REFRESH_COOKIE, newRt, cookieRefresh)
    .status(200)
    .json({
      message: 'refreshed',
      access_expires: ACCESS_TTL,
      refresh_expires_ms: oneYearMs
    });
});

// ===== LOGOUT (cabut sesi device saat ini) =====
exports.logoutMember = asyncHandler(async (req, res) => {
  const rawRt = req.cookies?.[REFRESH_COOKIE];
  if (rawRt) {
    const rtHash = hashToken(rawRt);
    await MemberSession.updateOne(
      { refresh_hash: rtHash },
      { $set: { revoked_at: new Date() } }
    );
  }
  res
    .clearCookie(ACCESS_COOKIE, { ...cookieAccess, maxAge: undefined })
    .clearCookie(REFRESH_COOKIE, { ...cookieRefresh, maxAge: undefined })
    .status(200)
    .json({ message: 'Logout member berhasil' });
});

// ===== ME =====
exports.member = asyncHandler(async (req, res) => {
  const m = await Member.findById(req.member.id).select(
    'name phone total_spend visit_count last_visit_at join_channel is_active updatedAt points'
  );
  if (!m) throwError('Member tidak ditemukan!', 404);
  res.status(200).json({
    id: m._id,
    name: m.name,
    phone: m.phone,
    points: m.points,
    total_spend: m.total_spend,
    visit_count: m.visit_count,
    last_visit_at: m.last_visit_at,
    join_channel: m.join_channel,
    is_active: m.is_active,
    updatedAt: m.updatedAt
  });
});

// ===== REGISTER (biarkan seperti sekarang, tidak terbitkan token) =====
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

  return res
    .status(201)
    .json({ message: 'Member baru berhasil didaftarkan', member, isNew: true });
});
