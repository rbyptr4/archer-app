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

// ------------------- 1) Request OTP (general) -------------------
exports.requestWaOtp = asyncHandler(async (req, res) => {
  // Accepts { name?, phone } — if name omitted and member exists, treat as forgot-name/login
  const { name, phone } = req.body || {};
  if (!phone) throwError('Nomor WA wajib diisi', 400);

  const normalizedPhone = normalizePhoneLocal(phone);
  if (!normalizedPhone) throwError('Nomor WA tidak valid', 400);

  // find member by phone
  let member = await Member.findOne({ phone: normalizedPhone });

  // if member not found and name provided -> create (normal register flow)
  if (!member && name) {
    member = await Member.create({
      name,
      phone: normalizedPhone,
      join_channel: 'self_order',
      visit_count: 1,
      last_visit_at: new Date(),
      is_active: true
    });
  } else if (!member && !name) {
    // no member and no name: still allow OTP to be sent? typically deny
    // We'll allow OTP to be sent to unknown phone but won't issue token until register
    // For privacy you may return generic message
    // For now, create a temporary placeholder (optional). Simpler: error.
    throwError(
      'Nomor belum terdaftar. Silakan daftarkan nama terlebih dahulu.',
      404
    );
  } else {
    // member exists: update visit_count etc
    member.visit_count = (member.visit_count || 0) + 1;
    member.last_visit_at = new Date();
    if (!member.is_active) member.is_active = true;
    if (name && member.name !== name) member.name = name;
    await member.save();
  }

  // throttle resend
  const last = await MemberOtp.findOne({ phone: normalizedPhone }).sort(
    '-createdAt'
  );
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
    phone: normalizedPhone,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose: 'login',
    meta: {}
  });

  await sendOtpText(toWa62Local(normalizedPhone), code);

  return res.json({
    success: true,
    message: `OTP dikirim ke WhatsApp (${OTP_TTL_MIN} menit berlaku).`,
    otp_id: doc._id
  });
});

// ------------------- 2) Verify OTP (general login) -------------------
exports.verifyWaOtp = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);

  const normalizedPhone = normalizePhoneLocal(phone);
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
  if (!member || !member.is_active)
    throwError('Member tidak aktif / tidak ditemukan', 401);

  // mark phone verified
  if (!member.phone_verified_at) {
    member.phone_verified_at = new Date();
    await member.save();
  }

  // issue tokens + session (same logic seperti loginMember)
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
      message: 'Verifikasi berhasil & login',
      member: {
        id: member._id,
        name: member.name,
        phone: member.phone,
        total_spend: member.total_spend,
        visit_count: member.visit_count,
        phone_verified_at: member.phone_verified_at || null
      },
      access_expires: ACCESS_TTL,
      refresh_expires_ms: oneYearMs
    });
});

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
