// utils/memberService.js
const Member = require('../models/memberModel');
const throwError = require('./throwError');
const normalizePhone = (p = '') =>
  String(p || '')
    .replace(/[^\d+]/g, '')
    .trim(); // sesuaikan util normalizePhone jika ada

/**
 * createMember(payload)
 * - payload: { name, phone, gender, birthday?, address? , join_channel? }
 * - akan validasi: name, phone, gender wajib
 */
async function createMember(payload = {}) {
  const name = String(payload.name || '').trim();
  const phoneRaw = String(payload.phone || '').trim();
  const gender = String(payload.gender || '')
    .trim()
    .toLowerCase();
  const join_channel = payload.join_channel || 'online';

  if (!name) throwError('name wajib', 400);
  if (!phoneRaw) throwError('phone wajib', 400);
  const phone = normalizePhone(phoneRaw);
  if (!phone) throwError('phone tidak valid', 400);

  if (!['male', 'female', 'other'].includes(gender)) {
    throwError('gender wajib diisi (male|female|other)', 400);
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
    // optional fields
    birthday: payload.birthday || null,
    address: payload.address || {}
  };

  const created = await Member.create(doc);
  return created.toObject ? created.toObject() : created;
}

module.exports = {
  createMember
};
