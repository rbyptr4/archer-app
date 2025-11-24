// controllers/member/authMemberController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Member = require('../../models/memberModel');
const MemberSession = require('../../models/memberSessionModel');
const MemberOtp = require('../../models/memberOtpModel'); // pastikan ada model ini
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

const {
  generateOtp,
  hashOtp,
  expiresAtFromNow,
  OTP_TTL_MIN
} = require('../../utils/otp');
const { sendOtpText } = require('../../utils/wablas');

const { createMember } = require('../../utils/memberService');

const oneYearMs = REFRESH_TTL_MS;
const cookieAccess = { ...baseCookie, httpOnly: true, maxAge: 15 * 60 * 1000 };
const cookieRefresh = { ...baseCookie, httpOnly: true, maxAge: oneYearMs };
const cookieDevice = { ...baseCookie, httpOnly: false, maxAge: oneYearMs };

const RESEND_COOLDOWN_SEC = Number(process.env.OTP_RESEND_COOLDOWN_SEC || 45);

/* ============ Helpers ============ */
const normalizePhone = (phone) => {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let d = s.replace(/\D+/g, '');
  if (d.startsWith('+62')) d = '0' + d.slice(3);
  else if (d.startsWith('62')) d = '0' + d.slice(2);
  else if (!d.startsWith('0')) d = '0' + d;
  return d;
};
const toWa62 = (phone) => {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let d = s.replace(/\D+/g, '');
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (d.startsWith('+62')) return '62' + d.slice(3);
  return d;
};
const sameName = (a = '', b = '') =>
  String(a).trim().replace(/\s+/g, ' ').toLowerCase() ===
  String(b).trim().replace(/\s+/g, ' ').toLowerCase();

/* ============ LOGIN (kirim OTP) ============ */
exports.loginMember = asyncHandler(async (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || !phone) throwError('Nama dan nomor WA wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  if (!/^0\d{9,13}$/.test(normalizedPhone)) {
    throwError('Format nomor tidak valid (gunakan 08xxxxxxxx)', 400);
  }

  const member = await Member.findOne({ phone: normalizedPhone });
  if (!member)
    throwError(
      'Nomor belum terdaftar. Silakan registrasi terlebih dahulu.',
      404
    );
  if (!member.is_active) throwError('Akun member tidak aktif.', 403);

  if (!sameName(member.name, name)) {
    throwError('Nama tidak cocok dengan nomor ini. Periksa ejaan nama.', 400);
  }

  const last = await MemberOtp.findOne({
    phone: normalizedPhone,
    purpose: 'login'
  }).sort('-createdAt');
  if (
    last &&
    last.last_sent_at &&
    Date.now() - last.last_sent_at.getTime() < RESEND_COOLDOWN_SEC * 1000
  ) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_SEC * 1000 -
        (Date.now() - last.last_sent_at.getTime())) /
        1000
    );
    throwError(`Tunggu ${wait} detik untuk kirim ulang OTP`, 429);
  }

  const code = generateOtp();
  await MemberOtp.create({
    phone: normalizedPhone,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose: 'login',
    meta: { nameInput: name }
  });

  await sendOtpText(toWa62(normalizedPhone), code);

  res.status(202).json({
    phone: phone,
    success: true,
    message: `OTP dikirim ke WhatsApp (${OTP_TTL_MIN} menit berlaku).`
  });
});

/* ============ DEV LOGIN (no OTP) ============ */
exports.devLoginMember = asyncHandler(async (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || !phone) throwError('Nama dan nomor WA wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  if (!/^0\d{9,13}$/.test(normalizedPhone)) {
    throwError('Format nomor tidak valid (gunakan 08xxxxxxxx)', 400);
  }

  const member = await Member.findOne({ phone: normalizedPhone });
  if (!member)
    throwError(
      'Nomor belum terdaftar. Silakan registrasi terlebih dahulu.',
      404
    );
  if (!member.is_active) throwError('Akun member tidak aktif.', 403);

  // optional: cek nama kalau mau
  if (!sameName(member.name, name)) {
    throwError('Nama tidak cocok dengan nomor ini.', 400);
  }

  // update minimal metadata sama seperti verifyLoginOtp
  if (!member.phone_verified_at) member.phone_verified_at = new Date();
  member.visit_count = (member.visit_count || 0) + 1;
  member.last_visit_at = new Date();
  await member.save();

  // device id: prioritas cookie, lalu header, bila tidak ada generate baru
  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

  // Token handling: access JWT + opaque refresh
  const accessToken = signAccessToken(member);
  const refreshToken = generateOpaqueToken();
  const refreshHash = hashToken(refreshToken);

  // Simpan session member (mirip alur verifyLoginOtp)
  await MemberSession.create({
    member: member._id,
    device_id,
    refresh_hash: refreshHash,
    user_agent: req.get('user-agent') || '',
    ip: req.ip,
    // gunakan TTL yang sama dengan mekanisme lain (REFRESH_TTL_MS)
    expires_at: new Date(Date.now() + REFRESH_TTL_MS)
  });

  // set cookie (akses HTTP-only untuk access & refresh, device non-httpOnly)
  res
    .cookie(ACCESS_COOKIE, accessToken, cookieAccess)
    .cookie(REFRESH_COOKIE, refreshToken, cookieRefresh)
    .cookie(DEVICE_COOKIE, device_id, cookieDevice)
    .status(200)
    .json({
      message: 'Login tanpa OTP (dev mode)',
      member: {
        id: member._id,
        name: member.name,
        phone: member.phone,
        gender: member.gender || null,
        address: member.address || '',
        points: member.points,
        total_spend: member.total_spend,
        visit_count: member.visit_count,
        phone_verified_at: member.phone_verified_at || null,
        is_active: member.is_active
      },
      access_expires: ACCESS_TTL,
      refresh_expires_ms: REFRESH_TTL_MS
    });
});

/* ============ VERIFY LOGIN OTP ============ */
exports.verifyLoginOtp = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  const rec = await MemberOtp.findOne({
    phone: normalizedPhone,
    purpose: 'login'
  }).sort('-createdAt');
  if (!rec) throwError('OTP tidak ditemukan', 400);
  if (rec.used_at) throwError('OTP sudah digunakan', 400);
  if (new Date(rec.expires_at).getTime() < Date.now())
    throwError('OTP kedaluwarsa', 400);
  if (rec.attempt_count >= 5) throwError('Percobaan OTP melebihi batas', 429);

  const ok = crypto.timingSafeEqual(
    Buffer.from(rec.code_hash),
    Buffer.from(hashOtp(otp))
  );
  if (!ok) {
    await MemberOtp.updateOne({ _id: rec._id }, { $inc: { attempt_count: 1 } });
    throwError('OTP salah', 400);
  }

  rec.used_at = new Date();
  await rec.save();

  const member = await Member.findOne({ phone: normalizedPhone });
  if (!member) throwError('Member tidak ditemukan', 404);
  if (!member.is_active) throwError('Akun member tidak aktif.', 403);

  if (!member.phone_verified_at) member.phone_verified_at = new Date();
  member.visit_count = (member.visit_count || 0) + 1;
  member.last_visit_at = new Date();
  await member.save();

  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

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
      message: 'Login berhasil (OTP terverifikasi)',
      member: {
        id: member._id,
        name: member.name,
        phone: member.phone,
        gender: member.gender || null,
        address: member.address || '',
        points: member.points,
        total_spend: member.total_spend,
        visit_count: member.visit_count,
        phone_verified_at: member.phone_verified_at || null
      },
      access_expires: ACCESS_TTL,
      refresh_expires_ms: oneYearMs
    });
});

exports.registerMember = asyncHandler(async (req, res) => {
  const { name, phone, gender, birthday, address, join_channel } =
    req.body || {};
  if (!name || !phone || !gender)
    throwError('Nama, nomor telepon, dan gender wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  if (!/^0\d{9,13}$/.test(normalizedPhone)) {
    throwError('Format nomor tidak valid (gunakan 08xxxxxxxx)', 400);
  }

  // validasi gender enum sederhana
  const g = String(gender).toLowerCase();
  if (!['male', 'female', 'other'].includes(g)) {
    throwError('Gender harus salah satu dari: male|female|other', 400);
  }

  const existing = await Member.findOne({ phone: normalizedPhone });
  if (existing) {
    throwError('Nomor sudah terdaftar. Silakan login pakai OTP.', 409);
  }

  const last = await MemberOtp.findOne({
    phone: normalizedPhone,
    purpose: 'register'
  }).sort('-createdAt');
  if (
    last &&
    last.last_sent_at &&
    Date.now() - last.last_sent_at.getTime() < RESEND_COOLDOWN_SEC * 1000
  ) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_SEC * 1000 -
        (Date.now() - last.last_sent_at.getTime())) /
        1000
    );
    throwError(`Tunggu ${wait} detik untuk kirim ulang OTP`, 429);
  }

  const code = generateOtp();
  await MemberOtp.create({
    phone: normalizedPhone,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose: 'register',
    meta: {
      name,
      gender: g,
      birthday: birthday || null,
      address: address || '',
      join_channel: join_channel || 'cashier'
    }
  });

  await sendOtpText(toWa62(normalizedPhone), code);

  return res.status(202).json({
    phone: phone,
    success: true,
    message: `OTP registrasi dikirim (${OTP_TTL_MIN} menit berlaku).`
  });
});

exports.verifyRegisterOtp = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  const rec = await MemberOtp.findOne({
    phone: normalizedPhone,
    purpose: 'register'
  }).sort('-createdAt');
  if (!rec) throwError('OTP tidak ditemukan', 400);
  if (rec.used_at) throwError('OTP sudah digunakan', 400);
  if (new Date(rec.expires_at).getTime() < Date.now())
    throwError('OTP kedaluwarsa', 400);
  if (rec.attempt_count >= 5) throwError('Percobaan OTP melebihi batas', 429);

  const ok = crypto.timingSafeEqual(
    Buffer.from(rec.code_hash),
    Buffer.from(hashOtp(otp))
  );
  if (!ok) {
    await MemberOtp.updateOne({ _id: rec._id }, { $inc: { attempt_count: 1 } });
    throwError('OTP salah', 400);
  }

  // Ambil data meta dari request register
  const {
    name,
    gender,
    birthday = null,
    address = '',
    join_channel = 'cashier'
  } = rec.meta || {};
  if (!name || !gender)
    throwError('Data registrasi tidak lengkap (name/gender).', 400);

  // Buat member kalau belum ada (handle race condition) via createMember
  let member = await Member.findOne({ phone: normalizedPhone });
  if (!member) {
    // createMember akan melempar error jika tidak valid (mis. gender)
    member = await createMember({
      name,
      phone: normalizedPhone,
      gender,
      birthday,
      address,
      join_channel
    });
    // createMember bisa return plain object atau mongoose doc tergantung implementasi
    // pastikan kita punya mongoose doc untuk session/token => fetch ulang jika perlu
    if (!member._id) {
      // jika returned plain object, ambil kembali dari DB
      member = await Member.findOne({ phone: normalizedPhone });
    } else {
      // jika createMember mengembalikan object plain, convert to mongoose doc by requery
      // but safe path above already handles.
    }
  } else {
    // Jika sudah ada (race), update name/gender/address bila perlu
    let changed = false;
    if (name && String(member.name || '') !== String(name)) {
      member.name = name;
      changed = true;
    }
    if (gender && String(member.gender || '') !== String(gender)) {
      member.gender = gender;
      changed = true;
    }
    if (typeof address !== 'undefined' && member.address !== address) {
      member.address = address || '';
      changed = true;
    }
    if (!member.is_active) {
      member.is_active = true;
      changed = true;
    }
    if (changed) await member.save();
  }

  // Mark verified + increment visit
  member.phone_verified_at = member.phone_verified_at || new Date();
  member.visit_count = (member.visit_count || 0) + 1;
  member.last_visit_at = new Date();
  await member.save();

  // Tandai OTP terpakai
  rec.used_at = new Date();
  await rec.save();

  // === AUTO-LOGIN (issue tokens + cookies) ===
  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

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

  return res
    .cookie(ACCESS_COOKIE, accessToken, cookieAccess)
    .cookie(REFRESH_COOKIE, refreshToken, cookieRefresh)
    .cookie(DEVICE_COOKIE, device_id, cookieDevice)
    .status(200)
    .json({
      message: 'Registrasi berhasil & login (OTP terverifikasi)',
      member: {
        id: member._id,
        name: member.name,
        phone: member.phone,
        gender: member.gender || null,
        address: member.address || '',
        points: member.points,
        total_spend: member.total_spend,
        visit_count: member.visit_count,
        phone_verified_at: member.phone_verified_at || null
      },
      access_expires: ACCESS_TTL,
      refresh_expires_ms: oneYearMs
    });
});

exports.devRegister = asyncHandler(async (req, res) => {
  const {
    name,
    phone,
    gender,
    birthday = null,
    address = '',
    join_channel = 'online'
  } = req.body || {};
  if (!name || !phone || !gender)
    throwError('Nama, nomor telepon, dan gender wajib diisi', 400);

  const normalizedPhone = normalizePhone(phone);
  if (!/^0\d{9,13}$/.test(normalizedPhone)) {
    throwError('Format nomor tidak valid (gunakan 08xxxxxxxx)', 400);
  }

  await createMember({
    name,
    phone: normalizedPhone,
    gender,
    birthday,
    address,
    join_channel
  });

  const member = await Member.findOne({ phone: normalizedPhone });
  if (!member) throwError('Gagal membuat member', 500);

  if (!member.phone_verified_at) member.phone_verified_at = new Date();
  member.visit_count = (member.visit_count || 0) + 1;
  member.last_visit_at = new Date();
  await member.save();

  const incomingDev = req.cookies?.[DEVICE_COOKIE] || req.header('x-device-id');
  const device_id =
    incomingDev && String(incomingDev).trim()
      ? String(incomingDev).trim()
      : crypto.randomUUID();

  const accessToken = signAccessToken(member);
  const refreshToken = generateOpaqueToken();
  const refreshHash = hashToken(refreshToken);

  try {
    await MemberSession.create({
      member: member._id,
      device_id,
      refresh_hash: refreshHash,
      user_agent: req.get('user-agent') || '',
      ip: req.ip,
      expires_at: new Date(Date.now() + oneYearMs)
    });
  } catch (e) {
    console.warn('[devRegister] MemberSession.create failed', e?.message || e);
  }

  res
    .cookie(ACCESS_COOKIE, accessToken, cookieAccess)
    .cookie(REFRESH_COOKIE, refreshToken, cookieRefresh)
    .cookie(DEVICE_COOKIE, device_id, cookieDevice)
    .status(201)
    .json({
      message: 'Registrasi dev berhasil & login (no OTP)',
      member: {
        id: member._id,
        name: member.name,
        phone: member.phone,
        gender: member.gender || null,
        address: member.address || '',
        points: member.points,
        total_spend: member.total_spend,
        visit_count: member.visit_count,
        phone_verified_at: member.phone_verified_at || null
      },
      access_expires: ACCESS_TTL,
      refresh_expires_ms: oneYearMs
    });
});

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

exports.member = asyncHandler(async (req, res) => {
  const m = await Member.findById(req.member.id).select(
    'name phone gender address points total_spend last_visit_at updatedAt'
  );
  if (!m) throwError('Member tidak ditemukan!', 404);
  res.status(200).json({
    id: m._id,
    name: m.name,
    phone: m.phone,
    gender: m.gender || null,
    address: m.address || '',
    points: m.points,
    total_spend: m.total_spend,
    last_visit_at: m.last_visit_at,
    updatedAt: m.updatedAt
  });
});
