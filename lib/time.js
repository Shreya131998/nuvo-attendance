export const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** { date: 'YYYY-MM-DD', time: 'HH:mm:ss' } in the app timezone. */
export function zonedNow(now = new Date()) {
  const p = Object.fromEntries(partsFormatter.formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

export function isDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

export function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const labelFormatter = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

export function dayLabel(dateStr) {
  return labelFormatter.format(new Date(`${dateStr}T12:00:00Z`));
}
