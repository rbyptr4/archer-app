// controllers/paymentController.js (misah dari orderController biar bersih)
const axios = require('axios');
const PaymentSession = require('../models/paymentSessionModel');
const Cart = require('../models/cartModel');

const { validateAndPrice } = require('../utils/voucherEngine');
const { haversineKm } = require('../utils/distance');
const { SERVICE_FEE_RATE, int } = require('../utils/money');

const { DEVICE_COOKIE } = require('../utils/memberToken');

const X_BASE = process.env.XENDIT_BASE_URL;
const X_KEY = process.env.XENDIT_SECRET_KEY;
const HDRS = { 'Content-Type': 'application/json' };

function parsePpnRate() {
  const raw = Number(process.env.PPN_RATE ?? 0.11); // default 11%
  if (!Number.isFinite(raw)) return 0.11;
  return raw > 1 ? raw / 100 : raw;
}

const normFt = (v) =>
  String(v).toLowerCase() === 'delivery' ? 'delivery' : 'dine_in';

const recomputeTotals = (cart) => {
  let totalQty = 0;
  for (const it of cart.items) {
    const addonsTotal = (it.addons || []).reduce(
      (s, a) => s + asInt(a.price) * asInt(a.qty, 1),
      0
    );
    it.line_subtotal =
      (asInt(it.base_price, 0) + addonsTotal) *
      clamp(asInt(it.quantity, 1), 1, 999);
    totalQty += it.quantity;
  }
  cart.total_quantity = totalQty;
  cart.total_items = cart.items.length;
  cart.total_price = cart.items.reduce(
    (s, it) => s + asInt(it.line_subtotal, 0),
    0
  );
  return cart;
};

const calcDeliveryFee = () =>
  Number(DELIVERY_FLAT_FEE ?? process.env.DELIVERY_FLAT_FEE ?? 5000);

const mergeTwoCarts = (dst, src) => {
  for (const it of src.items || []) {
    const idx = dst.items.findIndex((d) => d.line_key === it.line_key);
    if (idx >= 0) {
      dst.items[idx].quantity = clamp(
        asInt(dst.items[idx].quantity, 1) + asInt(it.quantity, 1),
        1,
        999
      );
    } else {
      dst.items.push(it.toObject ? it.toObject() : { ...it });
    }
  }
  recomputeTotals(dst);
};

const attachOrMergeCartsForIdentity = async (iden) => {
  if (!iden?.memberId || !iden?.session_id) return;

  const SOURCES = ['online', 'qr'];
  for (const src of SOURCES) {
    const sessionCart = await Cart.findOne({
      status: 'active',
      source: src,
      session_id: iden.session_id,
      $or: [{ member: null }, { member: { $exists: false } }]
    });
    if (!sessionCart) continue;

    let memberCart = await Cart.findOne({
      status: 'active',
      source: src,
      member: iden.memberId
    });

    if (memberCart) {
      mergeTwoCarts(memberCart, sessionCart);
      await memberCart.save();
      await Cart.deleteOne({ _id: sessionCart._id }).catch(() => {});
      continue;
    }

    try {
      const r = await Cart.updateOne(
        {
          _id: sessionCart._id,
          status: 'active',
          source: src,
          session_id: iden.session_id,
          $or: [{ member: null }, { member: { $exists: false } }]
        },
        { $set: { member: iden.memberId, session_id: null } }
      );
      if (!r.matchedCount) continue;
    } catch (e) {
      if (e && e.code === 11000) {
        memberCart = await Cart.findOne({
          status: 'active',
          source: src,
          member: iden.memberId
        });
        if (memberCart) {
          const freshSession = await Cart.findById(sessionCart._id);
          if (freshSession) {
            mergeTwoCarts(memberCart, freshSession);
            await memberCart.save();
            await Cart.deleteOne({ _id: freshSession._id }).catch(() => {});
          }
          continue;
        }
        throw e;
      }
      throw e;
    }
  }
};

const getActiveCartForIdentity = async (
  iden,
  { allowCreateOnline = false, defaultFt = null }
) => {
  await attachOrMergeCartsForIdentity(iden);

  const requestedSource = iden.source || '';
  const identityFilter = iden.memberId
    ? { member: iden.memberId }
    : { session_id: iden.session_id };

  const sourcesToCheck = requestedSource === 'qr' ? ['qr'] : ['qr', 'online'];
  let cart = null;
  let cartsQueried = [];
  let foundSource = null;

  for (const src of sourcesToCheck) {
    const carts = await Cart.find({
      status: 'active',
      source: src,
      ...identityFilter
    })
      .sort([
        ['table_number', -1],
        ['updatedAt', -1]
      ])
      .limit(2)
      .lean();
    if (carts.length) {
      cart = carts[0];
      cartsQueried = carts;
      foundSource = src;
      break;
    }
  }

  if (!cart) {
    if (requestedSource === 'qr') {
      throwError(
        'Belum ada cart self-order. Silakan assign nomor meja dahulu.',
        400
      );
    } else if (allowCreateOnline) {
      const ensureSession = iden.memberId
        ? null
        : iden.session_id || crypto.randomUUID();
      const upsertFilter = {
        status: 'active',
        source: 'online',
        ...(iden.memberId
          ? { member: iden.memberId }
          : { session_id: ensureSession })
      };
      const setOnInsert = {
        member: iden.memberId || null,
        session_id: iden.memberId ? null : ensureSession,
        table_number: null,
        fulfillment_type: defaultFt ? normFt(defaultFt) : 'dine_in',
        items: [],
        total_items: 0,
        total_quantity: 0,
        total_price: 0,
        status: 'active',
        source: 'online'
      };

      try {
        const upserted = await Cart.findOneAndUpdate(
          upsertFilter,
          { $setOnInsert: setOnInsert },
          { new: true, upsert: true, lean: true }
        );
        cart = upserted;
        foundSource = 'online';
      } catch (e) {
        if (e && e.code === 11000) {
          const retry = await Cart.findOne(upsertFilter).lean();
          if (retry) {
            cart = retry;
            foundSource = 'online';
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }
  }

  if (cart && cartsQueried.length > 1) {
    await Cart.deleteMany({
      _id: { $in: cartsQueried.slice(1).map((c) => c._id) },
      status: 'active',
      source: foundSource,
      ...identityFilter
    }).catch(() => {});
  }

  return cart;
};

const calcDeliveryFee = () =>
  Number(DELIVERY_FLAT_FEE ?? process.env.DELIVERY_FLAT_FEE ?? 5000);

const getIdentity = (req) => {
  const memberId = req.member?.id || null;
  const session_id =
    req.session_id ||
    req.cookies?.[DEVICE_COOKIE] ||
    req.header('x-device-id') ||
    null;

  return {
    mode: req.orderMode,
    source: req.orderSource,
    memberId,
    session_id,
    table_number: req.table_number || null
  };
};

exports.createQrisFromCart = async (req, res, next) => {
  try {
    const iden0 = getIdentity(req);
    const {
      fulfillment_type,
      address_text,
      lat,
      lng,
      note_to_rider,
      voucherClaimIds = []
    } = req.body || {};

    const ft =
      iden0.mode === 'self_order' ? 'dine_in' : fulfillment_type || 'dine_in';
    if (!['dine_in', 'delivery'].includes(ft)) {
      return res.status(400).json({ message: 'fulfillment_type tidak valid' });
    }

    // 1) Ambil cart aktif
    const iden = {
      ...iden0,
      session_id:
        iden0.session_id ||
        req.cookies?.[DEVICE_COOKIE] ||
        req.header('x-device-id') ||
        null
    };

    const cartObj = await getActiveCartForIdentity(iden, {
      allowCreateOnline: false
    });
    if (!cartObj) {
      return res.status(404).json({ message: 'Cart tidak ditemukan / kosong' });
    }

    const cart = await Cart.findById(cartObj._id);
    if (!cart || !cart.items?.length) {
      return res.status(404).json({ message: 'Cart kosong' });
    }

    // 2) Setup delivery (kalau perlu)
    let delivery_fee = 0;
    let deliverySnapshot = undefined;
    if (ft === 'delivery') {
      const latN = Number(lat),
        lngN = Number(lng);
      if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
        return res
          .status(400)
          .json({ message: 'Lokasi (lat,lng) wajib untuk delivery' });
      }
      const distance_km = haversineKm(CAFE_COORD, { lat: latN, lng: lngN });
      if (distance_km > Number(DELIVERY_MAX_RADIUS_KM || 0)) {
        return res.status(400).json({
          message: `Di luar radius ${DELIVERY_MAX_RADIUS_KM} km`
        });
      }
      delivery_fee = calcDeliveryFee();
      deliverySnapshot = {
        address_text: String(address_text || '').trim(),
        location: { lat: latN, lng: lngN },
        distance_km: Number(distance_km.toFixed(2)),
        delivery_fee,
        note_to_rider: String(note_to_rider || ''),
        status: 'pending'
      };
    }

    // 3) Hitung ulang cart
    recomputeTotals(cart);
    await cart.save();

    // 4) Voucher (kalau member)
    let memberId = iden0.memberId || null;
    let eligibleClaimIds = [];
    if (memberId && Array.isArray(voucherClaimIds) && voucherClaimIds.length) {
      const rawClaims = await VoucherClaim.find({
        _id: { $in: voucherClaimIds },
        member: memberId,
        status: 'claimed'
      }).lean();
      const now = new Date();
      eligibleClaimIds = rawClaims
        .filter((c) => !c.validUntil || c.validUntil > now)
        .map((c) => String(c._id));
    }

    const priced = await validateAndPrice({
      memberId,
      cart: {
        items: cart.items.map((it) => ({
          menuId: it.menu,
          qty: it.quantity,
          price: it.base_price,
          category: it.category || null
        }))
      },
      fulfillmentType: ft,
      deliveryFee: delivery_fee,
      voucherClaimIds: eligibleClaimIds
    });

    const items_subtotal = int(priced.totals.baseSubtotal);
    const items_discount = int(priced.totals.itemsDiscount);
    const shipping_discount = int(priced.totals.shippingDiscount);
    const baseDelivery = int(priced.totals.deliveryFee);

    // Service fee 2% dari (items + delivery)
    const sfBase = items_subtotal + baseDelivery;
    const service_fee = int(sfBase * SERVICE_FEE_RATE);

    // Tax base (sebelum pajak & rounding)
    const taxBase =
      items_subtotal +
      baseDelivery +
      service_fee -
      items_discount -
      shipping_discount;

    const safeTaxBase = Math.max(0, taxBase);
    const rate = parsePpnRate();
    const taxAmount = int(safeTaxBase * rate);

    const requested_amount = safeTaxBase + taxAmount;

    if (requested_amount <= 0) {
      return res.status(400).json({ message: 'Total pembayaran tidak valid.' });
    }

    // 5) Buat PaymentSession
    const reference_id = `QRIS-${cart._id}-${Date.now()}`;

    const session = await PaymentSession.create({
      member: memberId || null,
      customer_name: '', // bisa diisi dari body kalau mau
      customer_phone: '',
      source: iden.source || 'online',
      fulfillment_type: ft,
      table_number: ft === 'dine_in' ? cart.table_number ?? null : null,
      items: cart.items.map((it) => ({
        menu: it.menu,
        menu_code: it.menu_code,
        name: it.name,
        imageUrl: it.imageUrl,
        base_price: it.base_price,
        quantity: it.quantity,
        addons: it.addons,
        notes: it.notes,
        category: it.category || null
      })),
      items_subtotal,
      delivery_fee: baseDelivery,
      service_fee,
      items_discount,
      shipping_discount,
      discounts: priced.breakdown,
      requested_amount,
      provider: 'xendit',
      channel: 'qris',
      external_id: reference_id
    });

    // 6) Call Xendit QR
    const payload = {
      reference_id,
      type: 'DYNAMIC',
      currency: 'IDR',
      amount: requested_amount,
      metadata: {
        payment_session_id: String(session._id)
      }
    };

    const resp = await axios.post(`${X_BASE}/qr_codes`, payload, {
      auth: { username: X_KEY, password: '' },
      headers: { ...HDRS, 'api-version': '2022-07-31' },
      timeout: 15000
    });

    const qr = resp.data;

    session.qr_code_id = qr.id;
    session.qr_string = qr.qr_string;
    session.expires_at = qr.expires_at ? new Date(qr.expires_at) : null;
    await session.save();

    return res.json({
      success: true,
      data: {
        sessionId: String(session._id),
        channel: 'QRIS',
        amount: requested_amount,
        qris: {
          qr_string: qr.qr_string,
          expiry_at: qr.expires_at
        },
        status: 'pending'
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getSessionStatus = async (req, res, next) => {
  try {
    const { id } = req.params || {};
    const s = await PaymentSession.findById(id).lean();
    if (!s) return res.status(404).json({ message: 'Session tidak ditemukan' });

    // Kalau sudah dibuat order-nya oleh webhook
    if (s.order) {
      return res.json({
        sessionId: String(s._id),
        status: 'paid',
        orderId: String(s.order),
        provider: s.provider || 'xendit',
        channel: s.channel || 'qris'
      });
    }

    // Kalau belum dibayar
    return res.json({
      sessionId: String(s._id),
      status: s.status || 'pending',
      provider: s.provider || 'xendit',
      channel: s.channel || 'qris',
      amount: s.requested_amount || 0,
      expires_at: s.expires_at || null
    });
  } catch (err) {
    next(err);
  }
};
