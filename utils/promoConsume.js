// utils/promoConsume.js
const mongoose = require('mongoose');
const Promo = require('../models/promoModel');
const Member = require('../models/memberModel');
const throwError = require('./throwError');

function wasUpdated(result) {
  if (!result) return false;
  if (typeof result.modifiedCount !== 'undefined')
    return result.modifiedCount > 0;
  if (typeof result.nModified !== 'undefined') return result.nModified > 0;
  if (typeof result.matchedCount !== 'undefined')
    return result.matchedCount > 0;
  return false;
}

async function consumePromoForOrder({
  promoId,
  memberId = null,
  orderId = null,
  session = null
} = {}) {
  if (!promoId) throw new Error('promoId required');

  let ownSession = null;
  let createdOwnSession = false;
  try {
    if (!session && mongoose.startSession) {
      ownSession = await mongoose.startSession();
      ownSession.startTransaction();
      session = ownSession;
      createdOwnSession = true;
    }

    // fetch promo inside session to read current globalStock
    const promo = await Promo.findById(promoId).session(session);
    if (!promo) throwError('Promo tidak ditemukan', 404);

    // handle globalStock decrement (only if configured / not null)
    if (promo.globalStock != null) {
      const updResult = await Promo.updateOne(
        { _id: promoId, globalStock: { $gt: 0 } },
        { $inc: { globalStock: -1 } },
        { session }
      );
      // if update didn't modify -> stok habis / failed
      if (!wasUpdated(updResult)) {
        throwError('Promo sudah habis stoknya', 400);
      }
      console.log('[promoConsume] globalStock decremented', {
        promoId: String(promoId)
      });
    }

    // handle member usage logging (idempotent if orderId provided)
    if (memberId) {
      if (orderId) {
        // if an entry with same orderId already exists, skip (idempotent)
        const already = await Member.findOne({
          _id: memberId,
          'promoUsageHistory.orderId': String(orderId),
          'promoUsageHistory.promoId': String(promoId)
        }).session(session);
        if (!already) {
          await Member.updateOne(
            { _id: memberId },
            {
              $push: {
                promoUsageHistory: {
                  promoId: String(promoId),
                  usedAt: new Date(),
                  orderId: String(orderId)
                }
              }
            },
            { session }
          );
          console.log('[promoConsume] member promoUsageHistory pushed', {
            promoId: String(promoId),
            memberId: String(memberId),
            orderId: String(orderId)
          });
        } else {
          console.log(
            '[promoConsume] member usage already recorded for orderId, skip push',
            {
              promoId: String(promoId),
              memberId: String(memberId),
              orderId: String(orderId)
            }
          );
        }
      } else {
        // no orderId: push only if no entry for this promoId exists (best-effort idempotency)
        await Member.updateOne(
          {
            _id: memberId,
            'promoUsageHistory.promoId': { $ne: String(promoId) }
          },
          {
            $push: {
              promoUsageHistory: {
                promoId: String(promoId),
                usedAt: new Date(),
                orderId: null
              }
            }
          },
          { session }
        );
        console.log(
          '[promoConsume] member promoUsageHistory pushed (no orderId)',
          {
            promoId: String(promoId),
            memberId: String(memberId)
          }
        );
      }
    }

    if (createdOwnSession && ownSession) {
      await ownSession.commitTransaction();
      ownSession.endSession();
    }
    return { ok: true };
  } catch (err) {
    if (createdOwnSession && ownSession) {
      try {
        await ownSession.abortTransaction();
        ownSession.endSession();
      } catch (e) {
        /* ignore */
      }
    }
    throw err;
  }
}

async function releasePromoForOrder({
  promoId,
  memberId = null,
  orderId = null,
  session = null
} = {}) {
  if (!promoId) throw new Error('promoId required');

  let ownSession = null;
  let createdOwnSession = false;
  try {
    if (!session && mongoose.startSession) {
      ownSession = await mongoose.startSession();
      ownSession.startTransaction();
      session = ownSession;
      createdOwnSession = true;
    }

    const promo = await Promo.findById(promoId).session(session);
    if (!promo) {
      // promo not found -> nothing to release, commit/return ok
      if (createdOwnSession && ownSession) {
        await ownSession.commitTransaction();
        ownSession.endSession();
      }
      console.warn('[promoRelease] promo not found, nothing to release', {
        promoId: String(promoId)
      });
      return { ok: true, note: 'promo_not_found' };
    }

    // increment globalStock if it is configured (not null)
    if (promo.globalStock != null) {
      // increment by 1
      await Promo.updateOne(
        { _id: promoId },
        { $inc: { globalStock: 1 } },
        { session }
      );
      console.log('[promoRelease] globalStock incremented', {
        promoId: String(promoId)
      });
    } else {
      console.log(
        '[promoRelease] promo has unlimited stock (globalStock=null), skip increment',
        { promoId: String(promoId) }
      );
    }

    // remove usage history entry for member
    if (memberId) {
      if (orderId) {
        await Member.updateOne(
          { _id: memberId },
          {
            $pull: {
              promoUsageHistory: {
                orderId: String(orderId),
                promoId: String(promoId)
              }
            }
          },
          { session }
        );
        console.log('[promoRelease] pulled promoUsageHistory by orderId', {
          promoId: String(promoId),
          memberId: String(memberId),
          orderId: String(orderId)
        });
      } else {
        await Member.updateOne(
          { _id: memberId },
          { $pull: { promoUsageHistory: { promoId: String(promoId) } } },
          { session }
        );
        console.log(
          '[promoRelease] pulled promoUsageHistory by promoId (no orderId)',
          {
            promoId: String(promoId),
            memberId: String(memberId)
          }
        );
      }
    }

    if (createdOwnSession && ownSession) {
      await ownSession.commitTransaction();
      ownSession.endSession();
    }
    return { ok: true };
  } catch (err) {
    if (createdOwnSession && ownSession) {
      try {
        await ownSession.abortTransaction();
        ownSession.endSession();
      } catch (e) {
        /* ignore */
      }
    }
    throw err;
  }
}

module.exports = {
  consumePromoForOrder,
  releasePromoForOrder
};
