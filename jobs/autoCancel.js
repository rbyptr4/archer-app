// src/jobs/autoCancel.js
const cron = require('node-cron');
const Order = require('../models/orderModel');
const {
  emitToMember,
  emitToStaff,
  emitToTable
} = require('../controllers/socket/socketBus');

function log(...args) {
  if (process.env.NODE_ENV !== 'test')
    console.log('[JOB auto-cancel]', ...args);
}

async function runAutoCancelOnce() {
  const THRESHOLD_MIN = Number(process.env.UNPAID_CANCEL_MIN || 30);
  const BATCH_SIZE = Number(process.env.AUTO_CANCEL_BATCH || 100);
  const cutoff = new Date(Date.now() - THRESHOLD_MIN * 60 * 1000);

  // Ambil batch order expired
  const candidates = await Order.find({
    source: 'online', // kalau mau semua sumber, hapus baris ini
    status: 'created',
    payment_status: 'unpaid',
    placed_at: { $lte: cutoff }
  })
    .sort({ placed_at: 1 })
    .limit(BATCH_SIZE);

  if (!candidates.length) return { processed: 0 };

  let processed = 0;
  for (const order of candidates) {
    try {
      const fromStatus = order.status;
      order.status = 'cancelled';
      order.payment_status = 'void';
      order.cancellation_reason = 'AUTO_UNPAID_TIMEOUT';
      order.cancelled_at = new Date();
      await order.save();

      // Emit event realtime
      const payload = {
        id: String(order._id),
        member: String(order.member),
        table_number: order.table_number || null,
        from_status: fromStatus,
        status: order.status,
        reason: order.cancellation_reason,
        at: order.cancelled_at
      };
      emitToMember(order.member, 'order:status', payload);
      emitToStaff('order:status', payload);
      if (order.table_number)
        emitToTable(order.table_number, 'order:status', payload);

      processed++;
    } catch (e) {
      log('gagal cancel', order._id, e.message);
    }
  }
  return { processed };
}

function startAutoCancelJob() {
  const spec = process.env.AUTO_CANCEL_CRON || '*/5 * * * *';
  // Jalankan tiap interval
  const task = cron.schedule(
    spec,
    async () => {
      try {
        const { processed } = await runAutoCancelOnce();
        if (processed) log('cancelled:', processed);
      } catch (e) {
        log('error run:', e.message);
      }
    },
    { scheduled: false }
  );

  // Jalankan langsung sekali saat boot (opsional)
  runAutoCancelOnce().catch(() => {});

  task.start();
  log('scheduled with cron:', spec);
  return task;
}

module.exports = { startAutoCancelJob, runAutoCancelOnce };
