// models/orderHistoryModel.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Catatan desain ringkas:
 * - Snapshot seperlunya dari Order pada momen "jadi paid" / "dibuat di POS dengan mark_paid".
 * - Disimpan key waktu (dayKey/week/month/year) agar laporan & filter cepat tanpa heavy $group.
 * - Index disiapkan untuk use-case: range waktu, status pembayaran, status order, kasir, member, source, fulfillment.
 */

const HistoryItemSchema = new Schema(
  {
    menu: { type: Schema.Types.ObjectId, ref: 'Menu' },
    name: { type: String, trim: true },
    menu_code: { type: String, trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    base_price: { type: Number, default: 0 }, // harga dasar per unit (tanpa addons)
    addons_total: { type: Number, default: 0 }, // total addons per unit * qty
    line_subtotal: { type: Number, default: 0 }, // final per baris (base + addons) * qty
    category: {
      big: { type: String, default: null }, // ex: "FOOD" | "DRINK"
      subId: {
        type: Schema.Types.ObjectId,
        ref: 'MenuSubcategory',
        default: null
      },
      subName: { type: String, trim: true, default: '' } // opsional (biar gampang render)
    },
    imageUrl: { type: String, trim: true }, // buat card di UI
    notes: { type: String, trim: true }, // varian by notes
    addons: [
      {
        name: { type: String, trim: true },
        price: { type: Number, default: 0 },
        qty: { type: Number, default: 1 }
      }
    ], // varian by addons
    line_key: { type: String, trim: true }
  },
  { _id: false }
);

const HistoryDiscountSchema = new Schema(
  {
    kind: { type: String, trim: true }, // 'item' | 'shipping' | 'order' | dll
    label: { type: String, trim: true },
    amount: { type: Number, default: 0 },
    ref: { type: String, trim: true } // mis. voucher code/claim id
  },
  { _id: false }
);

const HistoryDeliverySchema = new Schema(
  {
    address_text: { type: String, trim: true },
    distance_km: { type: Number, default: null },
    delivery_fee: { type: Number, default: 0 },
    status: { type: String, trim: true }, // snapshot saat entry dibuat (mis. 'pending'/'assigned'/'delivered')
    courier: {
      id: { type: String, trim: true },
      name: { type: String, trim: true },
      phone: { type: String, trim: true }
    }
  },
  { _id: false }
);

const OrderHistorySchema = new Schema(
  {
    // Referensi & metadata dasar
    order: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      index: true,
      required: true
    },
    transaction_code: { type: String, index: true, required: true },

    // Source & fulfillment
    source: {
      type: String,
      enum: ['qr', 'online', 'pos'],
      index: true,
      required: true
    },
    fulfillment_type: {
      type: String,
      enum: ['dine_in', 'delivery'],
      index: true,
      required: true
    },
    table_number: { type: Number, default: null, index: true },

    // Status order & pembayaran (snapshot saat entry dibuat)
    status: {
      type: String,
      enum: ['created', 'accepted', 'completed', 'cancelled'],
      index: true,
      required: true
    },
    payment_status: {
      type: String,
      enum: ['verified', 'paid', 'refunded', 'void'],
      index: true,
      required: true
    },
    payment_method: { type: String, trim: true, index: true }, // 'qr' | 'cash' | 'card' | 'manual' | dll

    // Waktu utama (diambil dari order saat entry dibuat)
    placed_at: { type: Date, index: true }, // waktu dibuat/ditaruh
    paid_at: { type: Date, index: true }, // waktu jadi 'paid' (krusial)
    verified_at: { type: Date, index: true },
    completed_at: { type: Date, index: true },
    cancelled_at: { type: Date, index: true },

    // Snapshot kasir yang verifikasi (kalau ada)
    verified_by: {
      id: { type: Schema.Types.ObjectId, ref: 'User' },
      name: { type: String, trim: true }
    },

    // Snapshot member / customer
    member: {
      id: { type: Schema.Types.ObjectId, ref: 'Member', index: true },
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      is_member: { type: Boolean, default: false, index: true }
    },
    customer: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true }
    },

    // Angka-angka akuntansi
    items_subtotal: { type: Number, default: 0 },
    items_discount: { type: Number, default: 0 },
    delivery_fee: { type: Number, default: 0 },
    shipping_discount: { type: Number, default: 0 },
    grand_total: { type: Number, default: 0, index: true },

    // Ringkasan item
    total_quantity: { type: Number, default: 0 },
    line_count: { type: Number, default: 0 },
    items: { type: [HistoryItemSchema], default: [] }, // optional: bisa dikosongkan jika ingin hemat storage

    // Diskon/voucher breakdown (opsional)
    discounts: { type: [HistoryDiscountSchema], default: [] },

    // Delivery snapshot (opsional)
    delivery: { type: HistoryDeliverySchema, default: undefined },

    // Loyalti / poin
    points_awarded: { type: Number, default: 0 },

    // Flag bantu untuk laporan
    is_refund: { type: Boolean, default: false, index: true }, // true jika payment_status 'refunded'
    is_cancelled: { type: Boolean, default: false, index: true },

    // Kunci waktu untuk agregasi cepat
    // Format:
    //   dayKey:   'YYYY-MM-DD'
    //   weekKey:  'YYYY-Www' (ISO week, contoh '2025-W42')
    //   monthKey: 'YYYY-MM'
    //   year:     2025
    dayKey: { type: String, index: true },
    weekKey: { type: String, index: true },
    monthKey: { type: String, index: true },
    year: { type: Number, index: true }
  },
  {
    timestamps: true
  }
);

/* =========================
 * Index gabungan (untuk dashboard & laporan)
 * ========================= */
OrderHistorySchema.index({ dayKey: 1, payment_status: 1 });
OrderHistorySchema.index({ monthKey: 1, payment_status: 1 });
OrderHistorySchema.index({ weekKey: 1, payment_status: 1 });
OrderHistorySchema.index({ year: 1, payment_status: 1 });

OrderHistorySchema.index({ 'items.category.big': 1 });
OrderHistorySchema.index({ 'items.category.subId': 1 });
OrderHistorySchema.index({ paid_at: 1, source: 1 });
OrderHistorySchema.index({ paid_at: 1, fulfillment_type: 1 });
OrderHistorySchema.index({ paid_at: 1, verified_by: 1 });
OrderHistorySchema.index({ paid_at: 1, 'member.id': 1 });

OrderHistorySchema.index({ createdAt: -1 }); // fallback sort

/* =========================
 * Helper util internal
 * ========================= */
function buildTimeKeys(date) {
  const d = new Date(date || Date.now());
  const y = d.getFullYear();

  // monthKey: YYYY-MM
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dayKey = `${y}-${month}-${day}`;
  const monthKey = `${y}-${month}`;

  // ISO week
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3); // ke Kamis di minggu ini
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((tmp.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    );
  const weekStr = String(week).padStart(2, '0');
  const weekKey = `${tmp.getUTCFullYear()}-W${weekStr}`;

  return { dayKey, monthKey, weekKey, year: y };
}

/* ===================================================================
 * (Opsional) Static helper untuk bikin history dari dokumen Order.
 * Supaya controller nanti tinggal panggil: OrderHistory.createFromOrder(order)
 * =================================================================== */
OrderHistorySchema.statics.createFromOrder = async function createFromOrder(
  orderDoc,
  opts = {}
) {
  // orderDoc bisa Mongoose doc atau plain object
  const o = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const paidAt = o.paid_at || o.verified_at || o.createdAt || new Date();
  const timeKeys = buildTimeKeys(paidAt);

  const items = Array.isArray(o.items)
    ? o.items.map((it) => ({
        menu: it.menu || null,
        name: it.name,
        menu_code: it.menu_code,
        quantity: it.quantity || 1,
        base_price: it.base_price || 0,
        addons_total: (Array.isArray(it.addons) ? it.addons : []).reduce(
          (s, a) => s + Number(a.price || 0) * Number(a.qty || 1),
          0
        ),
        line_subtotal: it.line_subtotal || 0,
        category: it.category
          ? {
              big: it.category.big || null,
              subId: it.category.subId || null,
              subName: it.category.subName || opts?.subcategory_name || ''
            }
          : { big: null, subId: null, subName: '' },
        imageUrl: it.imageUrl || '',
        notes: it.notes || '',
        addons: Array.isArray(it.addons)
          ? it.addons.map((a) => ({
              name: a.name,
              price: Number(a.price || 0),
              qty: Number(a.qty || 1)
            }))
          : [],
        line_key: it.line_key || undefined
      }))
    : [];

  const discounts = Array.isArray(o.discounts)
    ? o.discounts.map((d) => ({
        kind: d.kind || d.type || '',
        label: d.label || d.name || '',
        amount: Number(d.amount || d.value || 0),
        ref: d.ref || d.code || d.claimId || ''
      }))
    : [];

  const doc = {
    order: o._id,
    transaction_code: o.transaction_code,

    source: o.source,
    fulfillment_type: o.fulfillment_type,
    table_number: o.table_number ?? null,

    status: o.status,
    payment_status: o.payment_status,
    payment_method: o.payment_method,

    placed_at: o.placed_at || o.createdAt || null,
    paid_at: o.paid_at || null,
    verified_at: o.verified_at || null,
    completed_at: o.completed_at || null,
    cancelled_at: o.cancelled_at || null,

    verified_by: o.verified_by
      ? { id: o.verified_by, name: opts.verified_by_name || undefined }
      : undefined,

    member: o.member
      ? {
          id: o.member,
          name: o.member_name || (o.member?.name ?? undefined),
          phone: o.member_phone || (o.member?.phone ?? undefined),
          is_member: true
        }
      : {
          is_member: false
        },
    customer: o.member
      ? undefined
      : {
          name: o.customer_name || '',
          phone: o.customer_phone || ''
        },

    items_subtotal: Number(o.items_subtotal || 0),
    items_discount: Number(o.items_discount || 0),
    delivery_fee: Number(o.delivery_fee || 0),
    shipping_discount: Number(o.shipping_discount || 0),
    grand_total: Number(o.grand_total || 0),

    total_quantity: Number(o.total_quantity || 0),
    line_count: Array.isArray(o.items) ? o.items.length : 0,
    items,

    discounts,

    delivery:
      o.fulfillment_type === 'delivery' && o.delivery
        ? {
            address_text: o.delivery.address_text || '',
            distance_km: o.delivery.distance_km ?? null,
            delivery_fee: o.delivery.delivery_fee ?? 0,
            status: o.delivery.status || '',
            courier: o.delivery.courier || undefined
          }
        : undefined,

    points_awarded: Number(o.points_awarded || 0),

    is_refund: o.payment_status === 'refunded',
    is_cancelled: o.status === 'cancelled',

    ...timeKeys
  };

  return this.create(doc);
};

module.exports =
  mongoose.models.OrderHistory ||
  mongoose.model('OrderHistory', OrderHistorySchema);
