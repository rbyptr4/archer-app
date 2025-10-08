// utils/loyalty.js
const LOYALTY_THRESHOLD_AMOUNT = Number(
  process.env.LOYALTY_THRESHOLD_AMOUNT || 110000
);
const LOYALTY_REWARD_POINTS = Number(process.env.LOYALTY_REWARD_POINTS || 10);

exports.awardPointsIfEligible = async function awardPointsIfEligible(
  order,
  MemberModel
) {
  try {
    if (!order?.member) return;
    if (order.loyalty_awarded_at) return; // idempotent guard

    const base = Number(order.items_subtotal || 0);
    if (base >= LOYALTY_THRESHOLD_AMOUNT) {
      await MemberModel.findByIdAndUpdate(order.member, {
        $inc: { points: LOYALTY_REWARD_POINTS }
      });
      order.loyalty_awarded_at = new Date();
      await order.save();
    }
  } catch (err) {
    console.warn('[loyalty] award failed:', err?.message || err);
  }
};
