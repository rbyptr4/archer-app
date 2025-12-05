const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Member = require('../../models/memberModel');
const MemberOtp = require('../../models/memberOtpModel');
const throwError = require('../../utils/throwError');
const MemberSession = require('../../models/memberSessionModel'); // add if belum ada
const {
  signAccessToken,
  generateOpaqueToken,
  hashToken,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  REFRESH_TTL_MS
} = require('../../utils/memberToken');

const { sendOtpText } = require('../../utils/wablas');
const { generateOtp, hashOtp, expiresAtFromNow } = require('../../utils/otp');

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
    phone: member.phone,
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
    phone: phone,
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

// ------------------- Forgot username: request OTP -------------------
exports.requestForgotUsername = asyncHandler(async (req, res) => {
  // body: { phone }
  const { phone } = req.body || {};
  if (!phone) throwError('Nomor telepon wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);
  if (!normalized) throwError('Nomor tidak valid', 400);

  // find member by phone (must exist)
  const member = await Member.findOne({ phone: normalized });
  if (!member) throwError('Member dengan nomor ini tidak ditemukan', 404);

  // check cooldown for existing forgot_username OTP
  const last = await MemberOtp.findOne({
    phone: normalized,
    purpose: 'forgot_username'
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
    purpose: 'forgot_username',
    meta: { memberId: member._id.toString() }
  });

  // kirim WA/SMS
  await sendOtpText(toWa62Local(normalized), code);

  res.json({
    success: true,
    message: 'OTP dikirim ke nomor terdaftar. Masukkan OTP untuk melanjutkan.',
    otp_id: doc._id,
    phone: normalized
  });
});

// ------------------- Forgot username: verify OTP -------------------
exports.verifyForgotUsername = asyncHandler(async (req, res) => {
  // body: { phone, otp }
  const { phone, otp } = req.body || {};
  if (!phone || !otp) throwError('Phone & OTP wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);
  const rec = await MemberOtp.findOne({
    phone: normalized,
    purpose: 'forgot_username'
  }).sort('-createdAt');

  if (!rec) throwError('OTP tidak ditemukan', 400);
  if (rec.used_at) throwError('OTP sudah digunakan', 400);
  if (new Date(rec.expires_at).getTime() < Date.now())
    throwError('OTP kedaluwarsa', 400);
  if (rec.attempt_count >= 5) throwError('Percobaan OTP melebihi batas', 429);

  // timingSafeEqual compare hashes
  const ok = crypto.timingSafeEqual(
    Buffer.from(rec.code_hash),
    Buffer.from(hashOtp(otp))
  );
  if (!ok) {
    await MemberOtp.updateOne({ _id: rec._id }, { $inc: { attempt_count: 1 } });
    throwError('OTP salah', 400);
  }

  // mark used (we keep meta.memberId)
  rec.used_at = new Date();
  await rec.save();

  // Return success + otp_id so FE can continue to set new username
  res.json({
    success: true,
    message: 'OTP terverifikasi. Silakan kirim username baru.',
    otp_id: rec._id
  });
});

// ------------------- Forgot username: set new username + auto-login -------------------
exports.setNewUsername = asyncHandler(async (req, res) => {
  // body: { phone, otp_id, newName }
  const { phone, otp_id, newName } = req.body || {};
  if (!phone || !otp_id || !newName)
    throwError('phone, otp_id, dan newName wajib diisi', 400);

  const normalized = normalizePhoneLocal(phone);

  // ambil record OTP
  const rec = await MemberOtp.findOne({
    _id: otp_id,
    phone: normalized,
    purpose: 'forgot_username'
  });
  if (!rec) throwError('OTP tidak ditemukan', 400);

  // require that OTP sudah diverifikasi (used_at set) dan masih "fresh" (misalnya 15 menit)
  if (!rec.used_at) throwError('OTP belum diverifikasi', 400);
  const MAX_AFTER_VERIFY_MS = Number(
    process.env.FORGOT_USERNAME_VERIFY_WINDOW_MS || 15 * 60 * 1000
  ); // default 15 menit
  if (Date.now() - rec.used_at.getTime() > MAX_AFTER_VERIFY_MS)
    throwError(
      'Token verifikasi sudah kedaluwarsa. Mohon request ulang OTP.',
      400
    );

  const { memberId } = rec.meta || {};
  if (!memberId) throwError('Metadata OTP tidak lengkap', 500);

  const member = await Member.findById(memberId);
  if (!member) throwError('Member tidak ditemukan', 404);

  // update name (username)
  member.name = String(newName).trim();
  await member.save();

  // create member session & cookies (auto-login) — mirror logic di utils/memberToken / orderController.ensureMemberForCheckout
  const sessionDevice =
    req.cookies?.[DEVICE_COOKIE] ||
    req.get('x-online-session') ||
    req.get('x-device-id') ||
    crypto.randomUUID();

  const accessToken = signAccessToken(member);
  const refreshToken = generateOpaqueToken();
  const refreshHash = hashToken(refreshToken);

  // upsert MemberSession
  const now = Date.now();
  const existing = await MemberSession.findOne({
    member: member._id,
    device_id: sessionDevice,
    revoked_at: null,
    expires_at: { $gt: new Date(now) }
  });

  if (existing) {
    existing.refresh_hash = refreshHash;
    existing.expires_at = new Date(now + REFRESH_TTL_MS);
    existing.user_agent = req.get('user-agent') || existing.user_agent || '';
    existing.ip = req.ip || existing.ip || '';
    await existing.save();
  } else {
    await MemberSession.create({
      member: member._id,
      device_id: sessionDevice,
      refresh_hash: refreshHash,
      user_agent: req.get('user-agent') || '',
      ip: req.ip,
      expires_at: new Date(now + REFRESH_TTL_MS)
    });
  }

  // set cookies (sesuaikan flags sesuai env kamu)
  const cookieAccess = {
    httpOnly: true,
    maxAge: 15 * 60 * 1000,
    sameSite: 'Lax'
  };
  const cookieRefresh = {
    httpOnly: true,
    maxAge: REFRESH_TTL_MS,
    sameSite: 'Lax'
  };
  const cookieDevice = {
    httpOnly: false,
    maxAge: REFRESH_TTL_MS,
    sameSite: 'Lax'
  };

  res.cookie(ACCESS_COOKIE, accessToken, cookieAccess);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieRefresh);
  res.cookie(DEVICE_COOKIE, sessionDevice, cookieDevice);

  // mark OTP record final (optional: add meta note)
  rec.meta = rec.meta || {};
  rec.meta.username_set_at = new Date();
  await rec.save();

  res.json({
    success: true,
    message: 'Username diperbarui dan Anda telah login.',
    member: { id: member._id, name: member.name, phone: member.phone }
  });
});

// ------------------- X) Resend OTP (generic) -------------------
exports.resendOtp = asyncHandler(async (req, res) => {
  // body: { phone, purpose }  purpose in: 'login' | 'register' | 'change_phone' | 'change_name'
  const { phone, purpose } = req.body || {};
  if (!phone || !purpose) throwError('Phone & purpose wajib diisi', 400);

  const PURPOSES = new Set([
    'login',
    'register',
    'change_phone',
    'change_name',
    'forgot_username'
  ]);
  if (!PURPOSES.has(purpose)) throwError('purpose tidak valid', 400);

  // Normalisasi phone sesuai pola lokal yang kamu pakai
  const normalized = normalizePhoneLocal(phone);

  // Ambil OTP paling baru untuk kombinasi phone+purpose
  const last = await MemberOtp.findOne({ phone: normalized, purpose }).sort(
    '-createdAt'
  );
  if (!last) {
    // sengaja error agar flow FE suruh panggil "request" sesuai konteks
    const hint =
      purpose === 'register'
        ? 'Silakan request OTP registrasi terlebih dahulu.'
        : purpose === 'login'
        ? 'Silakan request OTP login terlebih dahulu.'
        : purpose === 'change_phone'
        ? 'Silakan mulai dari requestChangePhone terlebih dahulu.'
        : purpose === 'change_name'
        ? 'Silakan mulai dari requestChangeName terlebih dahulu.'
        : 'Silakan request OTP lupa username terlebih dahulu.';
    throwError(`Belum ada permintaan OTP untuk purpose ini. ${hint}`, 404);
  }

  if (
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
  const newDoc = await MemberOtp.create({
    phone: normalized,
    code_hash: hashOtp(code),
    expires_at: expiresAtFromNow(),
    last_sent_at: new Date(),
    purpose,
    meta: last.meta || {}
  });

  // Kirim WA
  await sendOtpText(toWa62(normalized), code);

  res.json({
    success: true,
    message: `OTP dikirim ulang (${OTP_TTL_MIN} menit berlaku).`,
    otp_id: newDoc._id,
    purpose,
    phone: normalized
  });
});
