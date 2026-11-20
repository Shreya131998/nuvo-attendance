/**
 * Cleaning Attendance — Google Apps Script web app (bound to a Google Sheet).
 *
 *   <web app URL>?loc=<LOCATION_ID>   → worker form (scan QR, pick name, take photo)
 *   <web app URL>?page=admin          → admin dashboard (PIN protected)
 *
 * Run setup() once from the Apps Script editor before deploying.
 */

const SHEETS = { ATTENDANCE: 'Attendance', STAFF: 'Staff', LOCATIONS: 'Locations' };
const ATTENDANCE_HEADERS = ['Timestamp', 'Date', 'Time', 'Name', 'Location ID', 'Location Name', 'Photo URL', 'Photo File ID'];
const PHOTO_FILE_ID_COL = 8;
const DUPLICATE_WINDOW_MIN = 30;
const MAX_IMAGE_CHARS = 8 * 1024 * 1024; // base64 length cap (~6 MB image)
const HISTORY_DAYS = 7;
const MAX_PIN_FAILS = 10;

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

function setup() {
  const ss = SpreadsheetApp.getActive();

  const att = getOrCreateSheet_(ss, SHEETS.ATTENDANCE, ATTENDANCE_HEADERS);
  att.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  att.getRange('B:C').setNumberFormat('@');

  const staff = getOrCreateSheet_(ss, SHEETS.STAFF, ['Name', 'Active']);
  if (staff.getLastRow() === 1) {
    staff.getRange(2, 1, 2, 2).setValues([['Ramesh Kumar', 'Yes'], ['Sunita Devi', 'Yes']]);
  }

  const locs = getOrCreateSheet_(ss, SHEETS.LOCATIONS, ['Location ID', 'Location Name', 'Active']);
  if (locs.getLastRow() === 1) {
    locs.getRange(2, 1, 3, 3).setValues([
      ['GF-GENTS', 'Ground Floor - Gents Toilet', 'Yes'],
      ['GF-LADIES', 'Ground Floor - Ladies Toilet', 'Yes'],
      ['F1-GENTS', 'First Floor - Gents Toilet', 'Yes'],
    ]);
  }

  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PHOTO_FOLDER_ID')) {
    const folder = DriveApp.createFolder('Cleaning Attendance Photos');
    props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  }
  if (!props.getProperty('ADMIN_PIN')) {
    props.setProperty('ADMIN_PIN', '1234');
  }

  Logger.log('Setup complete. Photo folder: ' + DriveApp.getFolderById(props.getProperty('PHOTO_FOLDER_ID')).getUrl());
  Logger.log('Default admin PIN is 1234 — change ADMIN_PIN in Project Settings → Script Properties.');
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// Web app routing
// ---------------------------------------------------------------------------

function doGet(e) {
  const params = (e && e.parameter) || {};
  let tpl, title;

  if (params.page === 'admin') {
    tpl = HtmlService.createTemplateFromFile('Dashboard');
    tpl.appUrl = ScriptApp.getService().getUrl();
    title = 'Cleaning Dashboard';
  } else {
    // One QR code for all toilets: the worker picks the location on the form.
    // An optional ?loc=<ID> still pre-selects a location.
    tpl = HtmlService.createTemplateFromFile('Form');
    const locations = getLocations_().filter(l => l.active).map(l => ({ id: l.id, name: l.name }));
    const preselect = findLocation_(params.loc);
    const boot = locations.length
      ? { ok: true, locations: locations, preselect: preselect ? preselect.id : '',
          staff: getStaff_().filter(s => s.active).map(s => s.name) }
      : { ok: false, error: 'No locations are set up yet. Ask the admin to add them in the Locations sheet.' };
    tpl.bootstrap = jsonForHtml_(boot);
    title = 'Mark Cleaning';
  }

  return tpl.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

/** JSON that is safe to drop inside a <script> tag. */
function jsonForHtml_(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------------
// Worker submission
// ---------------------------------------------------------------------------

function submitAttendance(payload) {
  payload = payload || {};

  const loc = findLocation_(payload.locId);
  if (!loc) throw new Error('Invalid location. Please scan the QR code again.');

  const name = String(payload.name || '').trim();
  if (!getStaff_().some(s => s.active && s.name === name)) {
    throw new Error('Please select your name from the list.');
  }

  const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(payload.image || ''));
  if (!m) throw new Error('Photo missing. Please take a photo.');
  if (m[2].length > MAX_IMAGE_CHARS) throw new Error('Photo is too large. Please retake it.');

  // Server time only — the client never decides when the work was done.
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const timeStr = Utilities.formatDate(now, tz, 'HH:mm:ss');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ATTENDANCE);
    const duplicate = isRecentDuplicate_(sheet, name, loc.id, now);

    const ext = m[1] === 'png' ? 'png' : 'jpg';
    const fileName = [loc.id, safeFileName_(name), timeStr.replace(/:/g, '')].join('_') + '.' + ext;
    const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], fileName);
    const file = getDateFolder_(dateStr).createFile(blob);

    sheet.appendRow([now, dateStr, timeStr, name, loc.id, loc.name, file.getUrl(), file.getId()]);

    return { name: name, locName: loc.name, date: dateStr, time: timeStr.slice(0, 5), duplicate: duplicate };
  } finally {
    lock.releaseLock();
  }
}

function isRecentDuplicate_(sheet, name, locId, now) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const n = Math.min(200, last - 1);
  const rows = sheet.getRange(last - n + 1, 1, n, 5).getValues();
  const cutoff = now.getTime() - DUPLICATE_WINDOW_MIN * 60 * 1000;
  return rows.some(r => r[0] instanceof Date && r[0].getTime() >= cutoff && r[3] === name && r[4] === locId);
}

function getDateFolder_(dateStr) {
  const id = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (!id) throw new Error('App not set up yet. Ask the admin to run setup().');
  const root = DriveApp.getFolderById(id);
  const it = root.getFoldersByName(dateStr);
  return it.hasNext() ? it.next() : root.createFolder(dateStr);
}

function safeFileName_(s) {
  return String(s).replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}

// ---------------------------------------------------------------------------
// Admin API (every call checks the PIN)
// ---------------------------------------------------------------------------

function verifyPin(pin) {
  checkPin_(pin);
  return true;
}

function getDashboard(pin, dateStr) {
  checkPin_(pin);
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) dateStr = today;

  const all = readAttendance_();
  const entries = all.filter(r => r.date === dateStr).sort((a, b) => a.ts - b.ts);
  const locations = getLocations_().filter(l => l.active);
  const staff = getStaff_().filter(s => s.active);

  const locationStatus = locations.map(l => ({
    id: l.id,
    name: l.name,
    entries: entries.filter(e => e.locId === l.id).map(e => ({ name: e.name, time: e.time })),
  }));

  const staffStatus = staff.map(s => ({
    name: s.name,
    entries: entries.filter(e => e.name === s.name).map(e => ({ locName: e.locName, time: e.time })),
  }));

  return {
    date: dateStr,
    today: today,
    entries: entries.map(e => ({ time: e.time, name: e.name, locId: e.locId, locName: e.locName, fileId: e.fileId })),
    locationStatus: locationStatus,
    staffStatus: staffStatus,
    history: buildHistory_(all, dateStr, tz),
    sheetUrl: SpreadsheetApp.getActive().getUrl(),
  };
}

/** Returns a photo as a data URL. Only files recorded in the Attendance sheet can be fetched. */
function getPhoto(pin, fileId, thumb) {
  checkPin_(pin);
  fileId = String(fileId || '');
  if (!/^[\w-]{10,}$/.test(fileId)) throw new Error('Invalid photo id.');

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ATTENDANCE);
  const found = sheet.getRange(1, PHOTO_FILE_ID_COL, sheet.getMaxRows(), 1)
    .createTextFinder(fileId).matchEntireCell(true).findNext();
  if (!found) throw new Error('Photo not found.');

  const file = DriveApp.getFileById(fileId);
  let blob = null;
  if (thumb) {
    try { blob = file.getThumbnail(); } catch (err) { blob = null; }
  }
  if (!blob) blob = file.getBlob();
  return 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= MAX_PIN_FAILS) throw new Error('Too many wrong PIN attempts. Try again in 10 minutes.');

  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!expected || String(pin || '') !== expected) {
    cache.put('pin_fails', String(fails + 1), 600);
    Utilities.sleep(800);
    throw new Error('Wrong PIN.');
  }
}

function buildHistory_(all, endDateStr, tz) {
  const parts = endDateStr.split('-').map(Number);
  const end = new Date(parts[0], parts[1] - 1, parts[2], 12);
  const days = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    const ds = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    const rows = all.filter(r => r.date === ds);
    days.push({
      date: ds,
      label: Utilities.formatDate(d, tz, 'EEE d'),
      submissions: rows.length,
      locationsCleaned: new Set(rows.map(r => r.locId)).size,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// Sheet readers
// ---------------------------------------------------------------------------

function readAttendance_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ATTENDANCE);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ATTENDANCE_HEADERS.length).getValues()
    .filter(r => r[0] instanceof Date)
    .map(r => ({
      ts: r[0].getTime(),
      date: Utilities.formatDate(r[0], tz, 'yyyy-MM-dd'),
      time: Utilities.formatDate(r[0], tz, 'HH:mm'),
      name: String(r[3]),
      locId: String(r[4]),
      locName: String(r[5]),
      fileId: String(r[7]),
    }));
}

function readTable_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
}

function isActive_(v) {
  return !/^(no|n|false|0|inactive)$/i.test(String(v == null ? '' : v).trim());
}

function getStaff_() {
  return readTable_(SHEETS.STAFF)
    .filter(r => String(r[0]).trim())
    .map(r => ({ name: String(r[0]).trim(), active: isActive_(r[1]) }));
}

function getLocations_() {
  return readTable_(SHEETS.LOCATIONS)
    .filter(r => String(r[0]).trim())
    .map(r => ({ id: String(r[0]).trim(), name: String(r[1] || r[0]).trim(), active: isActive_(r[2]) }));
}

function findLocation_(locId) {
  if (!locId) return null;
  const id = String(locId).trim();
  return getLocations_().find(l => l.active && l.id === id) || null;
}
