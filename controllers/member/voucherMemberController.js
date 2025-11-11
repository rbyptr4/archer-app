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
  // only active + not deleted vouchers
  const list = await Voucher.find({ isDeleted: false, isActive: true })
    .sort('-createdAt')
    .lean();

  const visible = list.filter((v) => {
    if (!inWindow(v, now)) return false;

    // include/exclude lists
    if (v.target?.excludeMemberIds?.some((id) => String(id) === meId))
      return false;

    if (
      Array.isArray(v.target?.includeMemberIds) &&
      v.target.includeMemberIds.length
    ) {
      if (!v.target.includeMemberIds.some((id) => String(id) === meId))
        return false;
    }

    // global stock
    if (
      v.visibility?.mode === 'global_stock' &&
      (v.visibility?.globalStock || 0) <= 0
    )
      return false;

    return true;
  });

  res.json({ vouchers: visible });
});

/**
 * POST /member/vouchers/:voucherId/claim
 * - Requires authenticated member (req.member)
 * - No body required (server computes/records the claim)
 */
exports.claim = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const { voucherId } = req.params;
  if (!isValidId(voucherId)) throwError('voucherId tidak valid', 400);

  // Start transaction to be safe for stock/points concurrency
  const session = await mongoose.startSession();
  try {
    let createdClaim = null;
    await session.withTransaction(async () => {
      // Lock/read voucher inside session
      const v = await Voucher.findById(voucherId).session(session);
      if (!v || v.isDeleted || !v.isActive)
        throwError('Voucher tidak tersedia', 400);

      const now = new Date();
      // claim window check
      if (!inWindow(v, now)) throwError('Di luar periode klaim', 400);

      // If voucher is auto-applied (claimRequired=false), don't allow manual claim.
      // This avoids confusion where FE tries to "claim" something that should be auto-applied at checkout.
      if (v.usage && v.usage.claimRequired === false) {
        throwError('Voucher ini tidak perlu diklaim (auto-applied).', 400);
      }

      // global stock: ensure still >0 then decrement
      if (v.visibility?.mode === 'global_stock') {
        if ((v.visibility.globalStock || 0) < 1)
          throwError('Stok voucher habis', 400);
        v.visibility.globalStock = (v.visibility.globalStock || 0) - 1;
        await v.save({ session });
      }

      // per-member limit (count claims for this voucher by this member)
      if ((v.visibility?.perMemberLimit || 0) > 0) {
        const count = await VoucherClaim.countDocuments({
          voucher: v._id,
          member: meId
        }).session(session);
        if (count >= v.visibility.perMemberLimit)
          throwError('Batas klaim per member tercapai', 400);
      }

      // oneTimePerPeriod (if enabled) => check claims in the same period window (visibility.startAt..endAt)
      if (v.target?.oneTimePerPeriod) {
        // define the period: use visibility.startAt..visibility.endAt if periodic, otherwise fallback to createdAt month
        let periodStart = v.visibility?.startAt || null;
        let periodEnd = v.visibility?.endAt || null;
        if (!periodStart || !periodEnd) {
          // fallback: use voucher.createdAt month window
          const created = v.createdAt || new Date();
          periodStart = new Date(created.getFullYear(), created.getMonth(), 1);
          periodEnd = new Date(
            created.getFullYear(),
            created.getMonth() + 1,
            0,
            23,
            59,
            59,
            999
          );
        }
        const existing = await VoucherClaim.countDocuments({
          voucher: v._id,
          member: meId,
          claimedAt: { $gte: periodStart, $lte: periodEnd }
        }).session(session);
        if (existing > 0)
          throwError(
            'Voucher ini hanya boleh diklaim sekali pada periode yang sama',
            400
          );
      }

      // require points? deduct from member
      if ((v.target?.requiredPoints || 0) > 0) {
        const m = await Member.findById(meId).session(session);
        if (!m) throwError('Member tidak ditemukan', 404);
        const need = Number(v.target.requiredPoints || 0);
        if ((m.points || 0) < need) throwError('Poin tidak cukup', 400);
        m.points = (m.points || 0) - need;
        await m.save({ session });
      }

      // compute validUntil:
      // - if useValidDaysAfterClaim > 0 => now + days
      // - else if visibility.endAt exists => visibility.endAt
      // - else undefined (no expiry)
      let validUntil = undefined;
      const days = v.usage?.useValidDaysAfterClaim || 0;
      if (days > 0) {
        validUntil = new Date(now.getTime() + days * 86400000);
      } else if (v.visibility?.endAt) {
        validUntil = v.visibility.endAt;
      }

      // remainingUse based on voucher.usage.maxUsePerClaim
      const remainingUse = Math.max(1, Number(v.usage?.maxUsePerClaim || 1));

      // create claim document
      const claim = await VoucherClaim.create(
        [
          {
            voucher: v._id,
            member: meId,
            status: 'claimed',
            remainingUse,
            validUntil,
            spentPoints: Number(v.target?.requiredPoints || 0),
            history: [
              { at: now, action: 'CLAIM', note: 'Member claimed voucher' }
            ]
          }
        ],
        { session }
      );

      createdClaim = claim[0];
    });

    // transaction committed
    res.status(201).json({ claim: createdClaim });
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
