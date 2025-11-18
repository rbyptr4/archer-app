// utils/promoEngine.js
const Promo = require('../models/promoModel');
const Menu = require('../models/menuModel'); // asumsi ada model Menu
const throwError = require('../utils/throwError');

/**
 * helper utk menghitung total qty & subtotal
 */
function snapshotTotals(cart) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  const items_subtotal = items.reduce(
    (s, it) =>
      s +
      Number(it.base_price || it.unit_price || 0) *
        Number(it.quantity || it.qty || 0),
    0
  );
  const totalQty = items.reduce(
    (s, it) => s + Number(it.quantity || it.qty || 0),
    0
  );
  return { items, items_subtotal, totalQty };
}

/**
 * findApplicablePromos(cart, member, now)
 * - mengembalikan array promo (lean) yang eligible untuk ditampilkan/pilih
 */
async function findApplicablePromos(
  cart = {},
  member = null,
  now = new Date()
) {
  const { items_subtotal, totalQty } = snapshotTotals(cart);

  // ambil promo aktif
  const promos = await Promo.find({ isActive: true })
    .sort({ priority: -1 })
    .lean();

  const eligible = [];
  for (const p of promos) {
    // tanggal absolute
    if (p.conditions?.startAt && new Date(p.conditions.startAt) > now) continue;
    if (p.conditions?.endAt && new Date(p.conditions.endAt) < now) continue;

    // audience
    if (p.conditions?.audience === 'members' && !member) continue;

    // minTotal
    if (
      p.conditions?.minTotal &&
      Number(items_subtotal) < Number(p.conditions.minTotal)
    )
      continue;

    // minQty
    if (p.conditions?.minQty && Number(totalQty) < Number(p.conditions.minQty))
      continue;

    // item-specific checks
    if (Array.isArray(p.conditions?.items) && p.conditions.items.length) {
      let ok = true;
      for (const cond of p.conditions.items) {
        const need = Number(cond.qty || 1);
        if (cond.menuId) {
          const found = (cart.items || []).reduce(
            (s, it) =>
              s +
              (String(it.menu || it.menuId) === String(cond.menuId)
                ? Number(it.quantity || it.qty || 0)
                : 0),
            0
          );
          if (found < need) {
            ok = false;
            break;
          }
        } else if (cond.category) {
          const found = (cart.items || []).reduce(
            (s, it) =>
              s +
              (String(it.category) === String(cond.category)
                ? Number(it.quantity || it.qty || 0)
                : 0),
            0
          );
          if (found < need) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
    }

    // perMemberLimit
    if (p.perMemberLimit && member) {
      const used = (member.promoUsageHistory || []).filter(
        (h) => String(h.promoId) === String(p._id)
      ).length;
      if (used >= Number(p.perMemberLimit)) continue;
    }

    // birthday relative window
    if (p.conditions?.birthdayWindowDays && member) {
      const bd = member.birthday ? new Date(member.birthday) : null;
      if (!bd) continue; // butuh birthday
      const bdThisYear = new Date(
        now.getFullYear(),
        bd.getMonth(),
        bd.getDate()
      );
      const start = bdThisYear;
      const end = new Date(
        bdThisYear.getTime() +
          Number(p.conditions.birthdayWindowDays || 0) * 24 * 3600 * 1000
      );
      if (now < start || now > end) continue;
      // cek perMemberLimit handled di atas
    }

    // globalStock
    if (Number.isFinite(Number(p.globalStock))) {
      if ((p.globalStock || 0) <= 0) continue;
    }

    eligible.push(p);
  }

  return eligible;
}

/**
 * applyPromo(promo, cartSnapshot, pricing)
 * - menghitung dampak (impact) dari promo pada cart, tanpa melakukan side-effect
 * - return { impact, actions }
 *   impact: { itemsDiscount, cartDiscount, addedFreeItems: [{menuId, qty}], note }
 *   actions: [{ type:'award_points'|'grant_membership', amount?, meta? }]
 */
async function applyPromo(promo, cartSnapshot = {}, pricing = {}) {
  const impact = {
    itemsDiscount: 0,
    cartDiscount: 0,
    addedFreeItems: [],
    note: null
  };
  const actions = [];

  const { items_subtotal } = snapshotTotals(cartSnapshot);
  const sub = Number(items_subtotal || 0);

  switch (String(promo.type)) {
    case 'free_item':
    case 'buy_x_get_y':
    case 'bundling': {
      if (promo.reward?.freeMenuId) {
        const qty = Number(promo.reward?.freeQty || 1);
        impact.addedFreeItems.push({ menuId: promo.reward.freeMenuId, qty });
        impact.note = `Menambah free item (${qty})`;
      }
      break;
    }
    case 'cart_percent': {
      if (Number.isFinite(Number(promo.reward?.percent))) {
        const pct = Math.max(0, Math.min(100, Number(promo.reward.percent)));
        const amt = Math.floor((sub * pct) / 100);
        impact.cartDiscount = amt;
        impact.itemsDiscount += amt;
        impact.note = `Diskon ${pct}%`;
      }
      break;
    }
    case 'cart_amount': {
      if (Number.isFinite(Number(promo.reward?.amount))) {
        const amt = Math.max(0, Number(promo.reward.amount));
        impact.cartDiscount = amt;
        impact.itemsDiscount += amt;
        impact.note = `Diskon Rp ${amt}`;
      }
      break;
    }
    case 'fixed_price_bundle': {
      // simple handling: if conditions.items specify a group qty, compute naive delta
      const group = Array.isArray(promo.conditions?.items)
        ? promo.conditions.items[0]
        : null;
      if (group && Number(promo.reward?.fixedPriceBundle)) {
        const need = Number(group.qty || 0);
        if (need > 0) {
          // gather candidate prices
          const candidates = [];
          for (const it of cartSnapshot.items || []) {
            const matches =
              (group.menuId &&
                String(it.menu || it.menuId) === String(group.menuId)) ||
              (group.category &&
                String(it.category) === String(group.category));
            if (matches) {
              for (let i = 0; i < Number(it.quantity || it.qty || 0); i++)
                candidates.push(Number(it.base_price || it.unit_price || 0));
            }
          }
          const groupsCount = Math.floor(candidates.length / need);
          if (groupsCount > 0) {
            candidates.sort((a, b) => a - b);
            // conservative calc: take cheapest per group
            let sumGroup = 0;
            for (let g = 0; g < groupsCount; g++) {
              const slice = candidates.slice(g * need, g * need + need);
              sumGroup += slice.reduce((s, x) => s + x, 0);
            }
            const fixedTotal =
              Number(promo.reward.fixedPriceBundle) * groupsCount;
            const delta = Math.max(0, sumGroup - fixedTotal);
            impact.itemsDiscount += delta;
            impact.note = `Bundle fixed price ${promo.reward.fixedPriceBundle} x ${groupsCount}`;
          }
        }
      }
      break;
    }
    case 'award_points': {
      if (Number.isFinite(Number(promo.reward?.pointsFixed))) {
        actions.push({
          type: 'award_points',
          amount: Number(promo.reward.pointsFixed),
          meta: { promoId: promo._id }
        });
      } else if (Number.isFinite(Number(promo.reward?.pointsPercent))) {
        const pts = Math.floor(
          (sub * Number(promo.reward.pointsPercent || 0)) / 100
        );
        if (pts > 0)
          actions.push({
            type: 'award_points',
            amount: pts,
            meta: { promoId: promo._id }
          });
      }
      impact.note = 'Member akan menerima poin';
      break;
    }
    case 'grant_membership': {
      actions.push({ type: 'grant_membership', meta: { promoId: promo._id } });
      impact.note = 'Member akan didaftarkan';
      break;
    }
    case 'composite': {
      // composite: gabungan free item + percent (contoh birthday)
      if (promo.reward?.freeMenuId) {
        const qty = Number(promo.reward?.freeQty || 1);
        impact.addedFreeItems.push({ menuId: promo.reward.freeMenuId, qty });
      }
      if (Number.isFinite(Number(promo.reward?.percent))) {
        const pct = Number(promo.reward.percent);
        const amt = Math.floor((sub * pct) / 100);
        impact.itemsDiscount += amt;
        impact.cartDiscount += amt;
      }
      if (
        Number.isFinite(Number(promo.reward?.pointsFixed)) ||
        Number.isFinite(Number(promo.reward?.pointsPercent))
      ) {
        if (Number.isFinite(Number(promo.reward?.pointsFixed)))
          actions.push({
            type: 'award_points',
            amount: Number(promo.reward.pointsFixed),
            meta: { promoId: promo._id }
          });
        else if (Number.isFinite(Number(promo.reward?.pointsPercent))) {
          const pts = Math.floor(
            (sub * Number(promo.reward.pointsPercent || 0)) / 100
          );
          if (pts > 0)
            actions.push({
              type: 'award_points',
              amount: pts,
              meta: { promoId: promo._id }
            });
        }
      }
      if (promo.reward?.grantMembership)
        actions.push({
          type: 'grant_membership',
          meta: { promoId: promo._id }
        });
      break;
    }
    default:
      break;
  }

  return { impact, actions };
}

/**
 * executePromoActions(order, memberModel)
 * - mengeksekusi side-effects setelah order ter-verified
 * - melakukan update pada member (points, loyalty) dan menambah entry di order.rewards
 */
async function executePromoActions(order, MemberModel) {
  if (!order || !order.applied_promo) return;
  const actions = order.applied_promo.actions || [];
  if (!actions.length) return;

  // ambil member doc
  const memberId = order.member;
  const now = new Date();
  const rewards = order.rewards || [];

  for (const a of actions) {
    if (a.type === 'award_points') {
      if (!memberId) continue;
      const add = Number(a.amount || 0);
      if (add <= 0) continue;
      await MemberModel.updateOne({ _id: memberId }, { $inc: { points: add } });
      rewards.push({
        type: 'points',
        amount: add,
        grantedAt: now,
        promoId: a.meta?.promoId || null
      });
    } else if (a.type === 'grant_membership') {
      if (!memberId) continue;
      await MemberModel.updateOne(
        { _id: memberId },
        { $set: { loyalty_card: true, loyalty_awarded_at: now } }
      );
      rewards.push({
        type: 'membership',
        grantedAt: now,
        promoId: a.meta?.promoId || null
      });
      // set order flag
      order.granted_membership = true;
    }
  }

  order.rewards = rewards;
  await order.save();
}

module.exports = {
  findApplicablePromos,
  applyPromo,
  executePromoActions
};
