// controllers/member/voucherMemberController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Voucher = require('../../models/voucherModel');
const VoucherClaim = require('../../models/voucherClaimModel');
const Member = require('../../models/memberModel');
const throwError = require('../../utils/throwError');

function inWindow(v, now = new Date()) {
  const m = v.visibility?.mode || 'periodic';
  if (m === 'periodic') {
    if (v.visibility.startAt && now < v.visibility.startAt) return false;
    if (v.visibility.endAt && now > v.visibility.endAt) return false;
  }
  return true;
}

const getMemberId = (req) => String(req?.member || '');

exports.explore = asyncHandler(async (req, res) => {
  const me = getMemberId(req);
  if (!me) throwError('Unauthorized (member)', 401);
  const now = new Date();
  const list = await Voucher.find({ isDeleted: false, isActive: true })
    .sort('-createdAt')
    .lean();

  const visible = list.filter((v) => {
    if (!inWindow(v, now)) return false;
    if (v.target?.excludeMemberIds?.some((id) => String(id) === String(me.id)))
      return false;
    if (v.target?.includeMemberIds?.length) {
      if (!v.target.includeMemberIds.some((id) => String(id) === String(me.id)))
        return false;
    }
    if (
      v.visibility?.mode === 'global_stock' &&
      (v.visibility.globalStock || 0) <= 0
    )
      return false;
    return true;
  });

  res.json({ vouchers: visible });
});

exports.claim = asyncHandler(async (req, res) => {
  const member = getMemberId(req);
  if (!member) throwError('Unauthorized (member)', 401);
  const { voucherId } = req.params;
  const memberId = member.id;

  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    const v = await Voucher.findById(voucherId).session(session);
    if (!v || v.isDeleted || !v.isActive)
      throwError(400, 'Voucher tidak tersedia');

    // waktu & stok
    const now = new Date();
    if (!inWindow(v, now)) throwError(400, 'Di luar periode klaim');
    if (v.visibility?.mode === 'global_stock') {
      if ((v.visibility.globalStock || 0) < 1)
        throwError(400, 'Stok voucher habis');
      v.visibility.globalStock -= 1;
      await v.save({ session });
    }

    // per-member limit
    if ((v.visibility?.perMemberLimit || 0) > 0) {
      const count = await VoucherClaim.countDocuments({
        voucher: v._id,
        member: memberId
      }).session(session);
      if (count >= v.visibility.perMemberLimit)
        throwError(400, 'Batas klaim per member tercapai');
    }

    // potong poin
    if ((v.target?.requiredPoints || 0) > 0) {
      const m = await Member.findById(memberId).session(session);
      if (!m) throwError(404, 'Member tidak ditemukan');
      if ((m.points || 0) < v.target.requiredPoints)
        throwError(400, 'Poin tidak cukup');
      m.points -= v.target.requiredPoints;
      await m.save({ session });
    }

    // buat claim wallet
    const claim = await VoucherClaim.create(
      [
        {
          voucher: v._id,
          member: memberId,
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

    res.status(201).json({ claim: claim[0] });
  });
  session.endSession();
});

exports.myWallet = asyncHandler(async (req, res) => {
  const member = getMemberId(req);
  if (!member) throwError('Unauthorized (member)', 401);

  const data = await VoucherClaim.find({
    member: member.id,
    status: { $in: ['claimed', 'used'] }
  })
    .populate('voucher')
    .sort('-createdAt');
  res.json({ claims: data });
});
