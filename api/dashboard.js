import { HttpError, queryParam, route, sendJson } from '../lib/http.js';
import { isAdmin } from '../lib/auth.js';
import { readTabs, sheetUrl } from '../lib/sheets.js';
import { transformUrl } from '../lib/cloudinary.js';
import { dayLabel, isDateStr, shiftDate, zonedNow } from '../lib/time.js';

const HISTORY_DAYS = 7;

export default route(['GET'], async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(401, 'Please log in.');

  const today = zonedNow().date;
  const requested = queryParam(req, 'date');
  const date = isDateStr(requested) ? requested : today;

  const { staff, locations, attendance } = await readTabs('staff', 'locations', 'attendance');
  const entries = attendance.filter(r => r.date === date).sort((a, b) => a.ts - b.ts);
  const activeLocations = locations.filter(l => l.active);
  const activeStaff = staff.filter(s => s.active);

  const history = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = shiftDate(date, -i);
    const rows = attendance.filter(r => r.date === d);
    history.push({ date: d, label: dayLabel(d), submissions: rows.length, locationsCleaned: new Set(rows.map(r => r.locId)).size });
  }

  sendJson(res, 200, {
    date,
    today,
    sheetUrl: sheetUrl(),
    entries: entries.map(e => ({
      time: e.time,
      name: e.name,
      locId: e.locId,
      locName: e.locName,
      thumbUrl: transformUrl(e.photoUrl, 'c_fill,w_160,h_160,q_auto,f_auto'),
      photoUrl: transformUrl(e.photoUrl, 'q_auto,f_auto'),
    })),
    locationStatus: activeLocations.map(l => ({
      id: l.id,
      name: l.name,
      entries: entries.filter(e => e.locId === l.id).map(e => ({ name: e.name, time: e.time })),
    })),
    staffStatus: activeStaff.map(s => ({
      name: s.name,
      entries: entries.filter(e => e.name === s.name).map(e => ({ locName: e.locName, time: e.time })),
    })),
    history,
  });
});
