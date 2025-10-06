// src/jobs/index.js
const { startAutoCancelJob } = require('./autoCancel');

function startJobs() {
  const enabled = String(process.env.ENABLE_CRON_JOBS || 'false') === 'true';
  const role = process.env.JOBS_ROLE || 'web';

  if (!enabled) {
    console.log('[JOBS] disabled (ENABLE_CRON_JOBS=false)');
    return { started: false };
  }
  if (role !== 'worker' && role !== 'web') {
    console.log('[JOBS] unknown JOBS_ROLE, skip');
    return { started: false };
  }

  // Kalau kamu nanti pakai 2 proses (web+worker), sarankan: aktifkan jobs hanya di 'worker'
  if (role !== 'worker') {
    console.log('[JOBS] running on role=', role, '→ skip (prefer worker)');
    return { started: false };
  }

  console.log('[JOBS] starting… (role=', role, ')');
  const autoCancelTask = startAutoCancelJob();

  return {
    started: true,
    stop() {
      try {
        autoCancelTask?.stop();
      } catch (_) {}
    }
  };
}

module.exports = { startJobs };
