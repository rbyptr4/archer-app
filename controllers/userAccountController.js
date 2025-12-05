// controllers/userAccountController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const User = require('../models/userModel');
const UserOtp = require('../models/userOtpModel');
const throwError = require('../utils/throwError');
const { generateOtp, hashOtp, expiresAtFromNow } = require('../utils/otp');
const { sendOtpText } = require('../utils/wablas');
const generateTokens = require('../utils/generateToken');
const { baseCookie } = require('../utils/authCookies');

const OTP_PURPOSE_FORGOT_PW = 'forgot_password';
const OTP_PURPOSE_CHANGE_PHONE = 'change_phone';
const OTP_RESEND_COOLDOWN_SEC = Number(
  process.env.OTP_RESEND_COOLDOWN_SEC || 45
);
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN || 5);
const VERIFY_WINDOW_AFTER_OTP_MS = Number(
  process.env.OTP_VERIFY_WINDOW_MS || 15 * 60 * 1000
);

function normalizePhoneLocal(phone) {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let digits = s.replace(/\D+/g, '');
  if (digits.startsWith('+62')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('62')) digits = '0' + digits.slice(2);
  else if (!digits.startsWith('0')) digits = '0' + digits;
  return digits;
}
function toWa62Local(phone) {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let digits = s.replace(/\D+/g, '');
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('+62')) return '62' + digits.slice(3);
  return digits;
}

/* ========================= AUTHENTICATED ACTIONS ========================= */

/**
 * changeEmailOwner
 * - hanya untuk owner (cek di router dengan middleware requireOwner)
 * - body: { password, newEmail }
 */
exports.changeEmailOwner = asyncHandler(async (req, res) => {
  const { password, newEmail } = req.body || {};
  if (!password || !newEmail)
    throwError('Password & email baru wajib diisi', 400);

  const user = await User.findById(req.user.id).select(
    '+password +email +role'
  );
  if (!user) throwError('User tidak ditemukan', 404);
  if (user.role !== 'owner')
    throwError('Hanya owner yang boleh mengganti email ini', 403);

  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) throwError('Password salah', 401);

  const conflict = await User.findOne({ email: newEmail });
  if (conflict && String(conflict._id) !== String(user._id))
    throwError('Email sudah dipakai oleh user lain', 409);

  user.email = String(newEmail).trim();
  await user.save();

  res.json({ message: 'Email berhasil diperbarui', email: user.email });
});

/**
 * changePasswordAuthenticated
 * - untuk semua user yang sudah login (owner/karyawan)
 * - body: { oldPassword, newPassword }
 */
exports.changePasswordAuthenticated = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword)
    throwError('Password lama & baru wajib diisi', 400);
  if (String(newPassword).length < 6)
    throwError('Password baru minimal 6 karakter', 400);

  const user = await User.findById(req.user.id).select('+password');
  if (!user) throwError('User tidak ditemukan', 404);

  const ok = await bcrypt.compare(String(oldPassword), user.password);
  if (!ok) throwError('Password lama salah', 401);

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(String(newPassword), salt);

  user.refreshToken = null;
  user.prevRefreshToken = null;

  await user.save();
  res.json({ message: 'Password berhasil diubah' });
});

/**
 * changeProfileAuthenticated
 * - owner can change name and phone; employee can change phone only
 * - body: { password, name?, phone? }
 */
exports.changeProfileAuthenticated = asyncHandler(async (req, res) => {
  const { password, name, phone } = req.body || {};
  if (!password) throwError('Password wajib diisi untuk otentikasi', 400);
  if (!name && !phone) throwError('Tidak ada data baru untuk diubah', 400);

  const user = await User.findById(req.user.id).select('+password +role');
  if (!user) throwError('User tidak ditemukan', 404);

  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) throwError('Password salah', 401);

  // role-based allowed fields
  if (name) {
    if (user.role !== 'owner') {
      throwError('Hanya owner yang dapat mengubah nama', 403);
    }
    user.name = String(name).trim();
  }

  if (phone) {
    const normalized = normalizePhoneLocal(phone);
    if (!normalized) throwError('Nomor telepon baru tidak valid', 400);

    // check uniqueness
    const conflict = await User.findOne({ phone: normalized });
    if (conflict && String(conflict._id) !== String(user._id))
      throwError('Nomor telepon sudah dipakai oleh user lain', 409);

    user.phone = normalized;
  }

  await user.save();
  res.json({
    message: 'Profil berhasil diperbarui',
    user: { id: user._id, name: user.name, phone: user.phone }
  });
});

/* ========================= FORGOT PASSWORD (OTP) ========================= */

/**
 * requestForgotPassword
 * - body: { phone }
 * - works for owner and employees (find user by phone)
 */
exports.requestForgotPassword = asyncHandler(async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) throwError('Nomor telepon wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);
  if (!normalized) throwError('Nomor tidak valid', 400);

  const user = await User.findOne({ phone: normalized }).select('role _id');
  if (!user) throwError('Akun dengan nomor ini tidak ditemukan', 404);

  // cooldown check
  const last = await UserOtp.findOne({
    phone: normalized,
    purpose: OTP_PURPOSE_FORGOT_PW
  }).sort('-createdAt');
  if (
    last &&
    last.last_sent_at &&
    Date.now() - last.last_sent_at.getTime() < OTP_RESEND_COOLDOWN_SEC * 1000
  ) {
    const wait = Math.ceil(
      (OTP_RESEND_COOLDOWN_SEC * 1000 -
        (Date.now() - last.last_sent_at.getTime())) /
        1000
    );
    throwError(`Tunggu ${wait} detik untuk kirim ulang OTP`, 429);
  }

  // generate code & doc
  const code = generateOtp(); // util: 6-digit
  const doc = await UserOtp.create({
    phone: normalized,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(), // util uses OTP_TTL_MIN consistent
    last_sent_at: new Date(),
    purpose: OTP_PURPOSE_FORGOT_PW,
    meta: { userId: user._id.toString(), role: user.role }
  });

  await sendOtpText(toWa62Local(normalized), code);

  res.json({
    success: true,
    message: 'OTP dikirim ke nomor terdaftar',
    otp_id: doc._id,
    phone: normalized
  });
});

/**
 * verifyForgotPasswordOtp
 * - body: { phone, otp }
 * - marks used_at, returns otp_id
 */
exports.verifyForgotPasswordOtp = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);
  const rec = await UserOtp.findOne({
    phone: normalized,
    purpose: OTP_PURPOSE_FORGOT_PW
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
    await UserOtp.updateOne({ _id: rec._id }, { $inc: { attempt_count: 1 } });
    throwError('OTP salah', 400);
  }

  rec.used_at = new Date();
  await rec.save();

  res.json({ success: true, message: 'OTP terverifikasi', otp_id: rec._id });
});

/**
 * setNewPasswordAfterOtp
 * - body: { phone, otp_id, newPassword }
 * - checks rec.used_at and within VERIFY_WINDOW_AFTER_OTP_MS, then set password, revoke sessions, auto-login
 */
exports.setNewPasswordAfterOtp = asyncHandler(async (req, res) => {
  const { phone, otp_id, newPassword } = req.body || {};
  if (!phone || !otp_id || !newPassword)
    throwError('phone, otp_id, dan newPassword wajib diisi', 400);
  if (String(newPassword).length < 6)
    throwError('Password minimal 6 karakter', 400);

  const normalized = normalizePhoneLocal(phone);
  const rec = await UserOtp.findOne({
    _id: otp_id,
    phone: normalized,
    purpose: OTP_PURPOSE_FORGOT_PW
  });
  if (!rec) throwError('OTP tidak ditemukan', 400);
  if (!rec.used_at) throwError('OTP belum diverifikasi', 400);
  if (Date.now() - rec.used_at.getTime() > VERIFY_WINDOW_AFTER_OTP_MS)
    throwError('Token verifikasi sudah kedaluwarsa. Minta OTP ulang', 400);

  const { userId } = rec.meta || {};
  if (!userId) throwError('Metadata OTP tidak lengkap', 500);

  const user = await User.findById(userId).select('+password');
  if (!user) throwError('User tidak ditemukan', 404);

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(String(newPassword), salt);
  // revoke refresh tokens
  user.refreshToken = null;
  user.prevRefreshToken = null;
  await user.save();

  // auto-login (generate tokens & set cookies)
  const remember = false; // default false for forgot-password login
  const { accessToken, refreshToken } = await generateTokens(user, {
    remember
  });
  const refreshCookieOpts = remember
    ? { ...baseCookie, maxAge: 7 * 24 * 60 * 60 * 1000 }
    : { ...baseCookie };

  res
    .cookie('accessToken', accessToken, {
      ...baseCookie,
      maxAge: 30 * 60 * 1000
    })
    .cookie('refreshToken', refreshToken, refreshCookieOpts)
    .json({
      message: 'Password diperbarui dan login otomatis',
      role: user.role,
      accessExpiresInSec: 1800
    });
});

/* ========================= RESEND OTP for this model ========================= */

/**
 * resendUserOtp
 * - body: { phone, purpose } purpose: 'forgot_password'
 */
exports.resendUserOtp = asyncHandler(async (req, res) => {
  const { phone, purpose } = req.body || {};
  if (!phone || !purpose) throwError('Phone & purpose wajib diisi', 400);

  const PURPOSES = new Set([OTP_PURPOSE_FORGOT_PW]);
  if (!PURPOSES.has(purpose)) throwError('purpose tidak valid', 400);

  const normalized = normalizePhoneLocal(phone);
  const last = await UserOtp.findOne({ phone: normalized, purpose }).sort(
    '-createdAt'
  );
  if (!last) {
    throwError(
      'Belum ada permintaan OTP untuk purpose ini. Silakan request terlebih dahulu.',
      404
    );
  }

  if (
    last.last_sent_at &&
    Date.now() - last.last_sent_at.getTime() < OTP_RESEND_COOLDOWN_SEC * 1000
  ) {
    const wait = Math.ceil(
      (OTP_RESEND_COOLDOWN_SEC * 1000 -
        (Date.now() - last.last_sent_at.getTime())) /
        1000
    );
    throwError(`Tunggu ${wait} detik untuk kirim ulang OTP`, 429);
  }

  const code = generateOtp();
  const newDoc = await UserOtp.create({
    phone: normalized,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose,
    meta: last.meta || {}
  });

  await sendOtpText(toWa62Local(normalized), code);

  res.json({
    success: true,
    message: `OTP dikirim ulang (berlaku ${OTP_TTL_MIN} menit).`,
    otp_id: newDoc._id,
    phone: normalized
  });
});
