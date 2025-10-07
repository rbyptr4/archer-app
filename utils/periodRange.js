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
  // 1 = Senin (ID)
  const x = new Date(d);
  const day = x.getDay(); // 0=Min,1=Sen,...6=Sab
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
  x.setMonth(x.getMonth() + 1, 0);
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
 * period: 'day' | 'week' | 'month' | 'year' | 'overall'
 * mode: 'calendar' (default) | 'rolling'
 * start/end (ISO date) override period jika diisi
 * weekStartsOn: 1=Senin (Indonesia)
 */
function parsePeriod({
  period,
  start,
  end,
  mode = 'calendar',
  weekStartsOn = 1
} = {}) {
  // 1) Custom range menang
  if (start || end) {
    const s = start ? new Date(start) : new Date('1970-01-01');
    const e = end ? new Date(end) : new Date();
    return { start: s, end: e };
  }

  const now = new Date();

  // 2) Preset kalender (default)
  if (mode === 'calendar') {
    switch (String(period || '').toLowerCase()) {
      case 'day': {
        return { start: startOfDay(now), end: endOfDay(now) };
      }
      case 'week': {
        return {
          start: startOfWeek(now, weekStartsOn),
          end: endOfWeek(now, weekStartsOn)
        };
      }
      case 'month': {
        return { start: startOfMonth(now), end: endOfMonth(now) };
      }
      case 'year': {
        return { start: startOfYear(now), end: endOfYear(now) };
      }
      case 'overall':
      default:
        return { start: new Date('1970-01-01'), end: endOfDay(now) };
    }
  }

  // 3) Preset rolling (bergerak mundur dari "sekarang")
  switch (String(period || '').toLowerCase()) {
    case 'day': // 1 hari terakhir
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
    case 'week': // 7 hari terakhir
      return {
        start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        end: now
      };
    case 'month': // 30 hari terakhir
      return {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        end: now
      };
    case 'year': // 365 hari terakhir
      return {
        start: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
        end: now
      };
    case 'overall':
    default:
      return { start: new Date('1970-01-01'), end: now };
  }
}

module.exports = { parsePeriod };
