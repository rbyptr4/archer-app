// controllers/promoController.js
const asyncHandler = require('express-async-handler');
const { findApplicablePromos } = require('../utils/promoEngine');
const Member = require('../models/memberModel');
const throwError = require('../utils/throwError');

/**
 * POST /promos/evaluate
 * body: { cart, memberId? }
 * returns: eligiblePromos (ringkasan)
 */
exports.evaluate = asyncHandler(async (req, res) => {
  const { cart, memberId } = req.body || {};
  if (!cart || !Array.isArray(cart.items))
    throwError('cart wajib dikirim', 400);

  let member = null;
  if (memberId) {
    member = await Member.findById(memberId).lean();
    if (!member) throwError('Member tidak ditemukan', 404);
  }

  const now = new Date();
  const eligible = await findApplicablePromos(cart, member, now);

  const summary = eligible.map((p) => ({
    id: String(p._id),
    name: p.name,
    type: p.type,
    desc: p.notes || null,
    blocksVoucher: !!p.blocksVoucher,
    autoApply: !!p.autoApply,
    priority: Number(p.priority || 0),
    // preview meta: show reward basic summary
    rewardSummary: {
      freeMenuId: p.reward?.freeMenuId || null,
      freeQty: p.reward?.freeQty || 0,
      percent: p.reward?.percent || null,
      pointsFixed: p.reward?.pointsFixed || null
    }
  }));

  res.json({ eligiblePromos: summary });
});
