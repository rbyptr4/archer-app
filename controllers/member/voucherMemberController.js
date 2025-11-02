// controllers/member/voucherMemberController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Voucher = require('../../models/voucherModel');
const VoucherClaim = require('../../models/voucherClaimModel');
const Member = require('../../models/memberModel');
const throwError = require('../../utils/throwError');

const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));

function inWindow(v, now = new Date()) {
  const m = v.visibility?.mode || 'periodic';
  if (m === 'periodic') {
    if (v.visibility?.startAt && now < v.visibility.startAt) return false;
    if (v.visibility?.endAt && now > v.visibility.endAt) return false;
  }
  return true;
}

// Selalu kembalikan string ObjectId (atau null)
const getMemberId = (req) => {
  const m = req?.member;
  if (!m) return null;
  if (typeof m === 'string') return m;
  return String(m.id || m._id || m);
};

// GET /member/vouchers/explore
exports.explore = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const now = new Date();
  const list = await Voucher.find({ isDeleted: false, isActive: true })
    .sort('-createdAt')
    .lean();

  const visible = list.filter((v) => {
    if (!inWindow(v, now)) return false;

    // include/exclude
    if (v.target?.excludeMemberIds?.some((id) => String(id) === meId))
      return false;

    if (
      Array.isArray(v.target?.includeMemberIds) &&
      v.target.includeMemberIds.length
    ) {
      if (!v.target.includeMemberIds.some((id) => String(id) === meId))
        return false;
    }

    // global stock (opsional)
    if (
      v.visibility?.mode === 'global_stock' &&
      (v.visibility?.globalStock || 0) <= 0
    )
      return false;

    return true;
  });

  res.json({ vouchers: visible });
});

// POST /member/vouchers/:voucherId/claim
exports.claim = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const { voucherId } = req.params;
  if (!isValidId(voucherId)) throwError('voucherId tidak valid', 400);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const v = await Voucher.findById(voucherId).session(session);
      if (!v || v.isDeleted || !v.isActive)
        throwError('Voucher tidak tersedia', 400);

      const now = new Date();
      if (!inWindow(v, now)) throwError('Di luar periode klaim', 400);

      // global stock (opsional)
      if (v.visibility?.mode === 'global_stock') {
        if ((v.visibility.globalStock || 0) < 1)
          throwError('Stok voucher habis', 400);
        v.visibility.globalStock -= 1;
        await v.save({ session });
      }

      // per-member limit
      if ((v.visibility?.perMemberLimit || 0) > 0) {
        const count = await VoucherClaim.countDocuments({
          voucher: v._id,
          member: meId
        }).session(session);
        if (count >= v.visibility.perMemberLimit)
          throwError('Batas klaim per member tercapai', 400);
      }

      // potong poin (kalau perlu)
      if ((v.target?.requiredPoints || 0) > 0) {
        const m = await Member.findById(meId).session(session);
        if (!m) throwError('Member tidak ditemukan', 404);
        if ((m.points || 0) < v.target.requiredPoints)
          throwError('Poin tidak cukup', 400);
        m.points -= v.target.requiredPoints;
        await m.save({ session });
      }

      // buat claim wallet
      const claimDocs = await VoucherClaim.create(
        [
          {
            voucher: v._id,
            member: meId,
            status: 'claimed',
            remainingUse: v.usage?.maxUsePerClaim || 1,
            validUntil:
              (v.usage?.useValidDaysAfterClaim || 0) > 0
                ? new Date(
                    now.getTime() + v.usage.useValidDaysAfterClaim * 86400000
                  )
                : undefined,
            spentPoints: v.target?.requiredPoints || 0,
            history: [{ action: 'CLAIM', note: 'claim voucher' }]
          }
        ],
        { session }
      );

      res.status(201).json({ claim: claimDocs[0] });
    });
  } finally {
    session.endSession();
  }
});

// GET /member/vouchers/wallet
exports.myWallet = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const data = await VoucherClaim.find({
    member: meId,
    status: { $in: ['claimed', 'used'] }
  })
    .populate('voucher')
    .sort('-createdAt');

  res.json({ claims: data });
});
