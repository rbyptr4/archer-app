// utils/memberService.js
const Member = require('../models/memberModel');
const throwError = require('./throwError');
const normalizePhone = (p = '') =>
  String(p || '')
    .replace(/[^\d+]/g, '')
    .trim(); // sesuaikan util normalizePhone jika ada

async function createMember(payload = {}) {
  const name = String(payload.name || '').trim();
  const phoneRaw = String(payload.phone || '').trim();
  const gender = String(payload.gender || '')
    .trim()
    .toLowerCase();
  const join_channel = payload.join_channel || 'online';

  if (!name) throwError('Nama wajib diisi', 400);
  if (!phoneRaw) throwError('No telp wajib', 400);
  const phone = normalizePhone(phoneRaw);
  if (!phone) throwError('No telp tidak valid', 400);

  if (!['male', 'female'].includes(gender)) {
    throwError('Gender wajib diisi Laki-laki/Perempuan', 400);
  }

  // kalau sudah ada member dengan phone -> return existing (atau Anda ingin error? saya return existing)
  let existing = await Member.findOne({ phone }).lean();
  if (existing) return existing;

  const doc = {
    name,
    phone,
    gender,
    join_channel,
    visit_count: 1,
    last_visit_at: new Date(),
    is_active: true,
    birthday: payload.birthday || null,
    address: payload.address || null
  };

  const created = await Member.create(doc);

  return created;
}

module.exports = {
  createMember
};
