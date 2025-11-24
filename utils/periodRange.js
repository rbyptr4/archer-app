// utils/periodRange.js
// Sederhana: hanya gunakan tanggal. Semua return berupa Date object (UTC local JS Date).
// Preset yang didukung untuk query.range:
// 'today', 'yesterday', 'this_week', 'this_month', 'this_year', 'last_7', 'last_30', 'custom'
// Untuk custom gunakan query.from, query.to (ISO/parsable string)

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d, weekStartsOn = 1) {
  // weekStartsOn: 1 = Senin (ID)
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun,1=Mon,...6=Sat
  const diff = (day - weekStartsOn + 7) % 7;
  x.setDate(x.getDate() - diff);
  return startOfDay(x);
}
function endOfWeek(d, weekStartsOn = 1) {
  const s = startOfWeek(d, weekStartsOn);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  return endOfDay(e);
}

function startOfMonth(d) {
  const x = new Date(d);
  x.setDate(1);
  return startOfDay(x);
}
function endOfMonth(d) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + 1, 0); // last day prev month
  return endOfDay(x);
}

function startOfYear(d) {
  const x = new Date(d);
  x.setMonth(0, 1);
  return startOfDay(x);
}
function endOfYear(d) {
  const x = new Date(d);
  x.setMonth(11, 31);
  return endOfDay(x);
}

/**
 * parseRange(options)
 * options:
 *   - range: 'today'|'yesterday'|'this_week'|'this_month'|'this_year'|'last_7'|'last_30'|'custom'
 *   - from: ISO date string (untuk custom)
 *   - to: ISO date string (untuk custom)
 *   - weekStartsOn: 1 = Monday (default)
 *
 * Returns: { start: Date, end: Date }
 */
function parseRange({ range = 'today', from, to, weekStartsOn = 1 } = {}) {
  // custom range wins when from/to diberikan
  if (from || to) {
    const s = from ? new Date(from) : new Date('1970-01-01');
    const e = to ? new Date(to) : new Date();
    // normalize to day boundaries
    const start = isNaN(s.getTime()) ? new Date('1970-01-01') : startOfDay(s);
    const end = isNaN(e.getTime()) ? endOfDay(new Date()) : endOfDay(e);
    return { start, end };
  }

  const now = new Date();

  switch (String(range || '').toLowerCase()) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { start: startOfDay(d), end: endOfDay(d) };
    }
    case 'this_week':
      return {
        start: startOfWeek(now, weekStartsOn),
        end: endOfWeek(now, weekStartsOn)
      };
    case 'this_month':
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case 'this_year':
      return { start: startOfYear(now), end: endOfYear(now) };
    case 'last_7':
      return {
        start: startOfDay(new Date(Date.now() - 7 * 24 * 3600 * 1000)),
        end: endOfDay(now)
      };
    case 'last_30':
      return {
        start: startOfDay(new Date(Date.now() - 30 * 24 * 3600 * 1000)),
        end: endOfDay(now)
      };
    case 'custom':
    // fallback to today if no from/to supplied
    default:
      return { start: startOfDay(now), end: endOfDay(now) };
  }
}

module.exports = {
  parseRange,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear
};
