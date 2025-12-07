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

exports.explore = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const now = new Date();

  const list = await Voucher.find({ isDeleted: false, isActive: true })
    .sort('-createdAt')
    .lean();

  if (!Array.isArray(list) || list.length === 0) {
    return res.json({ vouchers: [] });
  }

  const ids = list.map((v) => v._id);

  const claimCounts = await VoucherClaim.aggregate([
    {
      $match: {
        member: meId,
        voucher: { $in: ids },
        status: { $ne: 'revoked' }
      }
    },
    {
      $group: {
        _id: '$voucher',
        count: { $sum: 1 }
      }
    }
  ]);

  const countsMap = (claimCounts || []).reduce((acc, it) => {
    acc[String(it._id)] = Number(it.count) || 0;
    return acc;
  }, {});

  function getPerMemberLimit(v) {
    if (v.visibility && typeof v.visibility.perMemberLimit === 'number')
      return Number(v.visibility.perMemberLimit);
    return 1;
  }

  const prelim = list.filter((v) => {
    if (!inWindow(v, now)) return false;

    if (v.target?.excludeMemberIds?.some((id) => String(id) === meId))
      return false;

    if (
      Array.isArray(v.target?.includeMemberIds) &&
      v.target.includeMemberIds.length
    ) {
      if (!v.target.includeMemberIds.some((id) => String(id) === meId))
        return false;
    }

    if (
      v.visibility?.mode === 'global_stock' &&
      (v.visibility?.globalStock || 0) <= 0
    )
      return false;

    return true;
  });

  const visible = prelim.filter((v) => {
    const id = String(v._id);
    const limit = getPerMemberLimit(v); // >=1
    const claimed = countsMap[id] || 0;
    return claimed < Number(limit);
  });

  const out = visible.map((v) => {
    const id = String(v._id);
    const valid_until = v.visibility?.endAt
      ? new Date(v.visibility.endAt).toISOString()
      : null;
    const stock =
      v.visibility?.mode === 'global_stock'
        ? typeof v.visibility?.globalStock === 'number'
          ? v.visibility.globalStock
          : null
        : null;

    return {
      id,
      name: v.name,
      description: v.notes || null,
      valid_until,
      stock,
      perMemberLimit: getPerMemberLimit(v)
    };
  });

  return res.json({ vouchers: out });
});

exports.getVoucherById = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const v = await Voucher.findById(id).lean();
  if (!v) throwError('Voucher tidak ditemukan', 404);

  const now = new Date();

  // cek visibility & audience rules
  if (!inWindow(v, now)) throwError('Voucher tidak tersedia saat ini', 404);

  if (v.target?.excludeMemberIds?.some((x) => String(x) === String(meId)))
    throwError('Voucher tidak tersedia untuk member ini', 404);

  if (
    Array.isArray(v.target?.includeMemberIds) &&
    v.target.includeMemberIds.length &&
    !v.target.includeMemberIds.some((x) => String(x) === String(meId))
  )
    throwError('Voucher tidak tersedia untuk member ini', 404);

  // global stock remaining
  const globalStockRemaining =
    v.visibility?.mode === 'global_stock' &&
    typeof v.visibility.globalStock === 'number'
      ? Math.max(0, v.visibility.globalStock)
      : null;

  // per-member limit & how many this member already claimed
  const perMemberLimit =
    typeof v.visibility?.perMemberLimit === 'number'
      ? v.visibility.perMemberLimit
      : null; // null treat as undefined/unlimited

  let claimedByMe = 0;
  if (perMemberLimit !== null && perMemberLimit > 0) {
    claimedByMe = await VoucherClaim.countDocuments({
      voucher: v._id,
      member: meId
    }).catch(() => 0);
  }

  const perMemberRemaining =
    perMemberLimit === null
      ? null
      : Math.max(0, perMemberLimit - (claimedByMe || 0));

  // simple canClaim boolean
  const inPeriod = inWindow(v, now);
  const notExcluded = !v.target?.excludeMemberIds?.some(
    (x) => String(x) === String(meId)
  );
  const inInclude =
    !Array.isArray(v.target?.includeMemberIds) ||
    v.target.includeMemberIds.length === 0 ||
    v.target.includeMemberIds.some((x) => String(x) === String(meId));

  const hasGlobalStock =
    v.visibility?.mode === 'global_stock'
      ? typeof v.visibility.globalStock === 'number'
        ? v.visibility.globalStock > 0
        : false
      : true;

  const meetsPerMember =
    perMemberLimit === null ? true : perMemberRemaining > 0;

  const canClaim =
    inPeriod && notExcluded && inInclude && hasGlobalStock && meetsPerMember;

  // susun response detail rapi
  const detail = {
    id: String(v._id),
    name: v.name,
    description: v.notes || null,
    type: v.type,
    benefit: {
      percent: typeof v.percent === 'number' ? v.percent : null,
      amount: typeof v.amount === 'number' ? v.amount : null,
      maxDiscount: typeof v.maxDiscount === 'number' ? v.maxDiscount : null,
      shipping: v.shipping
        ? {
            percent: v.shipping.percent ?? 100,
            maxAmount: v.shipping.maxAmount ?? 0
          }
        : null
    },
    visibility: {
      mode: v.visibility?.mode || 'periodic',
      startAt: v.visibility?.startAt
        ? new Date(v.visibility.startAt).toISOString()
        : null,
      endAt: v.visibility?.endAt
        ? new Date(v.visibility.endAt).toISOString()
        : null,
      globalStock:
        typeof v.visibility?.globalStock === 'number'
          ? v.visibility.globalStock
          : null,
      perMemberLimit:
        typeof v.visibility?.perMemberLimit === 'number'
          ? v.visibility.perMemberLimit
          : null
    },
    target: {
      audience: v.target?.audience || 'all',
      minTransaction: v.target?.minTransaction ?? 0,
      requiredPoints: v.target?.requiredPoints ?? 0,
      includeCount: Array.isArray(v.target?.includeMemberIds)
        ? v.target.includeMemberIds.length
        : 0,
      excludeCount: Array.isArray(v.target?.excludeMemberIds)
        ? v.target.excludeMemberIds.length
        : 0
    },
    usage: {
      claimRequired: v.usage?.claimRequired ?? true,
      maxUsePerClaim: v.usage?.maxUsePerClaim ?? 1,
      useValidDaysAfterClaim: v.usage?.useValidDaysAfterClaim ?? 0,
      stackableWithShipping: v.usage?.stackableWithShipping ?? true,
      stackableWithOthers: v.usage?.stackableWithOthers ?? false
    },
    status: {
      isActive: !!v.isActive,
      isDeleted: !!v.isDeleted,
      inWindow,
      globalStockRemaining,
      perMemberRemaining,
      claimedByMe
    },
    canClaim
  };

  return res.json({ voucher: detail });
});

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

exports.myWallet = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  // ambil claims yang status = 'claimed'
  const claims = await VoucherClaim.find({
    member: meId,
    status: 'claimed'
  })
    .populate('voucher')
    .sort('-createdAt')
    .lean();

  // filter: hanya kembalikan klaim yang voucher-nya aktif & belum dihapus
  const visible = (claims || []).filter((c) => {
    if (!c.voucher) return false;
    if (c.voucher.isDeleted) return false;
    if (!c.voucher.isActive) return false; // hide sementara kalau voucher dinonaktifkan
    return true;
  });

  res.json({ claims: visible });
});

exports.myVoucher = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const now = new Date();

  // Ambil hanya claim yang masih bisa dipakai:
  // - status: claimed
  // - remainingUse > 0
  const claims = await VoucherClaim.find({
    member: meId,
    status: 'claimed',
    remainingUse: { $gt: 0 }
  })
    .populate('voucher')
    .sort('-createdAt')
    .lean();

  const out = (claims || [])
    .map((c) => {
      const v = c.voucher || null;
      if (!v || v.isDeleted || !v.isActive) return null; // hide voucher inactive / deleted

      // Tentukan validUntil
      const validUntil = c.validUntil
        ? new Date(c.validUntil)
        : v?.visibility?.endAt
        ? new Date(v.visibility.endAt)
        : null;

      // Check expired
      const isExpired = validUntil ? now > validUntil : false;
      if (isExpired) return null; // jangan tampilkan voucher expired

      return {
        claimId: String(c._id),
        voucherId: String(v._id),
        name: v.name,
        description: v.notes ?? null,
        claimedAt: c.claimedAt ? new Date(c.claimedAt).toISOString() : null,
        valid_until: validUntil ? validUntil.toISOString() : null,
        remainingUse: c.remainingUse ?? null,
        claimStatus: c.status || 'claimed',
        voucherActive: true,
        isExpired: false,
        stock:
          v.visibility?.mode === 'global_stock'
            ? typeof v.visibility.globalStock === 'number'
              ? v.visibility.globalStock
              : null
            : null,
        state: {
          canUse: true,
          isDisabledStyle: false
        }
      };
    })
    .filter(Boolean); // bersihkan yg null (inactive / expired)

  return res.json({ claims: out });
});

exports.getMyVoucherClaimDetail = asyncHandler(async (req, res) => {
  const meId = getMemberId(req);
  if (!meId) throwError('Unauthorized (member)', 401);

  const claimId = req.params.claimId;
  if (!mongoose.Types.ObjectId.isValid(claimId))
    throwError('ID tidak valid', 400);

  // ambil klaim + populate voucher minimal
  const claim = await VoucherClaim.findById(claimId)
    .populate({ path: 'voucher' })
    .lean();

  if (!claim) throwError('Klaim voucher tidak ditemukan', 404);

  // pastikan klaim milik member
  if (String(claim.member) !== String(meId))
    throwError('Tidak berhak mengakses klaim ini', 403);

  const v = claim.voucher || null;
  const now = new Date();

  // basic voucher master flags
  const voucherActive = !!(v && v.isActive && !v.isDeleted);
  const voucherExists = !!v;

  // compute validUntil: prefer claim.validUntil, fallback voucher.visibility.endAt
  const validUntil = claim.validUntil
    ? new Date(claim.validUntil)
    : v && v.visibility && v.visibility.endAt
    ? new Date(v.visibility.endAt)
    : null;
  const isExpired = validUntil ? now > validUntil : false;

  // global stock (if applicable)
  const globalStock =
    v && v.visibility && v.visibility.mode === 'global_stock'
      ? typeof v.visibility.globalStock === 'number'
        ? v.visibility.globalStock
        : null
      : null;

  // per-member limit from voucher master (0 => unlimited according to your model earlier? You used 0 = unlimited)
  const perMemberLimitRaw =
    v && v.visibility && typeof v.visibility.perMemberLimit === 'number'
      ? v.visibility.perMemberLimit
      : null;
  // treat 0 as unlimited (consistent dengan model sebelumnya)
  const perMemberLimit = perMemberLimitRaw === 0 ? null : perMemberLimitRaw;

  // count how many claims this member already has for this voucher (to compute perMemberRemaining)
  let totalClaimsByMeForVoucher = 0;
  if (v && perMemberLimit !== null) {
    totalClaimsByMeForVoucher = await VoucherClaim.countDocuments({
      voucher: v._id,
      member: meId
    }).catch(() => 0);
  }

  const perMemberRemaining =
    perMemberLimit === null
      ? null
      : Math.max(0, perMemberLimit - totalClaimsByMeForVoucher);

  // canUse logic: klaim status harus 'claimed', masih ada remainingUse, belum expired, voucher master aktif
  const canUse =
    claim.status === 'claimed' &&
    (typeof claim.remainingUse !== 'number' || claim.remainingUse > 0) &&
    !isExpired &&
    voucherActive;

  // Susun response (ringkas & lengkap sesuai kebutuhan FE)
  const response = {
    claimId: String(claim._id),
    voucherId: v ? String(v._id) : null,
    claimStatus: claim.status || 'claimed', // 'claimed'|'used'|'expired'|'revoked'
    remainingUse:
      typeof claim.remainingUse === 'number' ? claim.remainingUse : null,
    spentPoints: typeof claim.spentPoints === 'number' ? claim.spentPoints : 0,
    claimedAt: claim.claimedAt ? new Date(claim.claimedAt).toISOString() : null,
    validUntil: validUntil ? validUntil.toISOString() : null,
    isExpired,
    voucherActive,
    canUse,
    // voucher master snapshot (useful for FE detail page)
    voucher: v
      ? {
          id: String(v._id),
          name: v.name,
          type: v.type,
          notes: v.notes || null,
          percent: typeof v.percent === 'number' ? v.percent : null,
          amount: typeof v.amount === 'number' ? v.amount : null,
          maxDiscount: typeof v.maxDiscount === 'number' ? v.maxDiscount : null,
          shipping: v.shipping
            ? {
                percent: v.shipping.percent ?? 100,
                maxAmount: v.shipping.maxAmount ?? 0
              }
            : null,
          visibility: {
            mode: v.visibility?.mode || 'periodic',
            startAt: v.visibility?.startAt
              ? new Date(v.visibility.startAt).toISOString()
              : null,
            endAt: v.visibility?.endAt
              ? new Date(v.visibility.endAt).toISOString()
              : null,
            globalStock:
              typeof v.visibility?.globalStock === 'number'
                ? v.visibility.globalStock
                : null,
            perMemberLimit: perMemberLimitRaw ?? null
          },
          target: {
            audience: v.target?.audience || 'all',
            minTransaction: v.target?.minTransaction ?? 0,
            requiredPoints: v.target?.requiredPoints ?? 0
          },
          usage: {
            maxUsePerClaim: v.usage?.maxUsePerClaim ?? 1,
            useValidDaysAfterClaim: v.usage?.useValidDaysAfterClaim ?? 0,
            claimRequired: v.usage?.claimRequired ?? true,
            stackableWithShipping: v.usage?.stackableWithShipping ?? true,
            stackableWithOthers: v.usage?.stackableWithOthers ?? false
          }
        }
      : null,
    // stok / per-member info
    globalStock,
    perMemberLimit: perMemberLimit === null ? null : perMemberLimit,
    totalClaimsByMeForVoucher:
      perMemberLimit === null ? null : totalClaimsByMeForVoucher,
    perMemberRemaining,
    // history & raw minimal klaim (FE bisa tampilkan timeline)
    history: Array.isArray(claim.history)
      ? claim.history.map((h) => ({
          at: h.at ? new Date(h.at).toISOString() : null,
          action: h.action || null,
          ref: h.ref || null,
          note: h.note || null
        }))
      : []
    // jika FE butuh data voucher claim mentah untuk debug, bisa pakai claim.raw (tidak disertakan)
    // rawClaim: claim
  };

  return res.status(200).json({ success: true, claim: response });
});
