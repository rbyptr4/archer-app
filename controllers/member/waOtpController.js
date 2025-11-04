// controllers/member/waOtpController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Member = require('../../models/memberModel');
const MemberOtp = require('../../models/memberOtpModel');
const MemberSession = require('../../models/memberSessionModel');
const throwError = require('../../utils/throwError');

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

const { sendOtpText } = require('../../utils/wablas');
const {
  generateOtp,
  hashOtp,
  expiresAtFromNow,
  OTP_TTL_MIN
} = require('../../utils/otp');

const oneYearMs = REFRESH_TTL_MS;
const cookieAccess = { httpOnly: true, maxAge: 15 * 60 * 1000 }; // adjust if you have baseCookie use that
const cookieRefresh = { httpOnly: true, maxAge: oneYearMs };
const cookieDevice = { httpOnly: false, maxAge: oneYearMs };

const RESEND_COOLDOWN_SEC = Number(process.env.OTP_RESEND_COOLDOWN_SEC || 45);

// --- helpers lokal (paste dari sebelumnya) ---
const normalizePhoneLocal = (phone) => {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let digits = s.replace(/\D+/g, '');
  if (digits.startsWith('+62')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('62')) digits = '0' + digits.slice(2);
  else if (!digits.startsWith('0')) digits = '0' + digits;
  return digits;
};
const toWa62Local = (phone) => {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  let digits = s.replace(/\D+/g, '');
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('+62')) return '62' + digits.slice(3);
  return digits;
};

// ------------------- 3) Request change phone -------------------
exports.requestChangePhone = asyncHandler(async (req, res) => {
  // body: { name, newPhone }
  const { name, newPhone } = req.body || {};
  if (!name || !newPhone) throwError('Name & nomor baru wajib diisi', 400);

  // find member by name (case-insensitive)
  const member = await Member.findOne({ name: new RegExp(`^${name}$`, 'i') });
  if (!member) throwError('Member tidak ditemukan dengan nama tersebut', 404);

  const normalizedNew = normalizePhoneLocal(newPhone);
  if (!normalizedNew) throwError('Nomor baru tidak valid', 400);

  // ensure new phone isn't already used
  const existing = await Member.findOne({ phone: normalizedNew });
  if (existing && String(existing._id) !== String(member._id))
    throwError('Nomor baru sudah dipakai oleh member lain', 409);

  // send OTP to old phone (member.phone)
  const normalizedOld = member.phone;
  const last = await MemberOtp.findOne({
    phone: normalizedOld,
    purpose: 'change_phone'
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
  const doc = await MemberOtp.create({
    phone: normalizedOld,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose: 'change_phone',
    meta: { memberId: member._id.toString(), newPhone: normalizedNew }
  });

  await sendOtpText(toWa62Local(normalizedOld), code);

  res.json({
    success: true,
    message:
      'OTP dikirim ke nomor lama. Verifikasi untuk menyelesaikan perubahan nomor.',
    otp_id: doc._id
  });
});

// ------------------- 4) Verify change phone -------------------
exports.verifyChangePhone = asyncHandler(async (req, res) => {
  // body: { phone (old), otp }
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);
  const normalized = normalizePhoneLocal(phone);

  const rec = await MemberOtp.findOne({
    phone: normalized,
    purpose: 'change_phone'
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

  // perform phone update
  const { memberId, newPhone } = rec.meta || {};
  if (!memberId || !newPhone) throwError('Metadata OTP tidak lengkap', 500);

  const member = await Member.findById(memberId);
  if (!member) throwError('Member tidak ditemukan', 404);

  // check uniqueness again
  const conflict = await Member.findOne({ phone: newPhone });
  if (conflict && String(conflict._id) !== String(member._id))
    throwError('Nomor baru sudah dipakai', 409);

  // update
  member.phone = newPhone;
  member.phone_verified_at = new Date();
  await member.save();

  rec.used_at = new Date();
  await rec.save();

  return res.json({
    success: true,
    message: 'Nomor berhasil diubah',
    member: { id: member._id, name: member.name, phone: member.phone }
  });
});

// ------------------- 5) Request change name -------------------
exports.requestChangeName = asyncHandler(async (req, res) => {
  // body: { phone, newName }
  const { phone, newName } = req.body || {};
  if (!phone || !newName) throwError('Phone & newName wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);
  const member = await Member.findOne({ phone: normalized });
  if (!member) throwError('Member tidak ditemukan', 404);

  const last = await MemberOtp.findOne({
    phone: normalized,
    purpose: 'change_name'
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
  const doc = await MemberOtp.create({
    phone: normalized,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose: 'change_name',
    meta: { memberId: member._id.toString(), newName }
  });

  await sendOtpText(toWa62Local(normalized), code);

  res.json({
    success: true,
    message: 'OTP dikirim ke nomor member. Verifikasi untuk mengganti nama.',
    otp_id: doc._id
  });
});

// ------------------- 6) Verify change name -------------------
exports.verifyChangeName = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);
  const rec = await MemberOtp.findOne({
    phone: normalized,
    purpose: 'change_name'
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

  const { memberId, newName } = rec.meta || {};
  if (!memberId || !newName) throwError('Metadata OTP tidak lengkap', 500);

  const member = await Member.findById(memberId);
  if (!member) throwError('Member tidak ditemukan', 404);

  member.name = newName;
  await member.save();

  rec.used_at = new Date();
  await rec.save();

  return res.json({
    success: true,
    message: 'Nama berhasil diubah',
    member: { id: member._id, name: member.name, phone: member.phone }
  });
});
