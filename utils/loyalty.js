const asInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

function evaluateMemberLevel(totalSpend = 0) {
  const bronze = asInt(process.env.MEMBER_BRONZE_SPEND);
  const silver = asInt(process.env.MEMBER_SILVER_SPEND);
  const gold = asInt(process.env.MEMBER_GOLD_SPEND);

  const spend = Number(totalSpend || 0);

  if (spend >= gold) return 'gold';
  if (spend >= silver) return 'silver';
  return 'bronze';
}

module.exports = { evaluateMemberLevel };
