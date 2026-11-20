import crypto from 'node:crypto';
import { requireEnv } from './http.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const TABS = {
  attendance: {
    title: 'Attendance',
    headers: ['Timestamp', 'Date', 'Time', 'Name', 'Location ID', 'Location Name', 'Photo URL', 'Photo Public ID'],
  },
  staff: {
    title: 'Staff',
    headers: ['Name', 'Active', 'Hindi Name'],
    hindiCol: 'C',
    sample: [['Ramesh Kumar', 'Yes', 'रमेश कुमार'], ['Sunita Devi', 'Yes', 'सुनीता देवी']],
  },
  locations: {
    title: 'Locations',
    headers: ['Location ID', 'Location Name', 'Active', 'Hindi Name'],
    hindiCol: 'D',
    sample: [
      ['GF-GENTS', 'Ground Floor - Gents Toilet', 'Yes', 'भूतल - पुरुष शौचालय'],
      ['GF-LADIES', 'Ground Floor - Ladies Toilet', 'Yes', 'भूतल - महिला शौचालय'],
      ['F1-GENTS', 'First Floor - Gents Toilet', 'Yes', 'पहली मंज़िल - पुरुष शौचालय'],
    ],
  },
};

const TRANSLATE_TAB = '_Translate'; // hidden scratch tab used to run GOOGLETRANSLATE

// ---------------------------------------------------------------------------
// Google auth (service account JWT → access token), cached per function instance
// ---------------------------------------------------------------------------

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const email = requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const privateKey = requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google auth failed: ' + (json.error_description || json.error || res.status));

  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function sheetsFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}/${requireEnv('SHEET_ID')}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google Sheets error: ' + (json.error?.message || res.status));
  return json;
}

const range = r => encodeURIComponent(r);

// ---------------------------------------------------------------------------
// Tab setup — missing tabs are created (with headers and sample rows) on first use
// ---------------------------------------------------------------------------

let tabIds = null; // tab title → numeric sheetId (needed to delete rows)

async function ensureTabs() {
  if (tabIds) return tabIds;
  const meta = await sheetsFetch('?fields=sheets.properties(title,sheetId)');
  const ids = Object.fromEntries((meta.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
  const missing = Object.values(TABS).filter(t => !(t.title in ids));
  const existing = Object.values(TABS).filter(t => t.title in ids);

  const addRequests = missing.map(t => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } }));
  if (!(TRANSLATE_TAB in ids)) addRequests.push({ addSheet: { properties: { title: TRANSLATE_TAB, hidden: true } } });

  if (addRequests.length) {
    const reply = await sheetsFetch(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: addRequests }) });
    (reply.replies || []).forEach(r => { ids[r.addSheet.properties.title] = r.addSheet.properties.sheetId; });
    for (const t of missing) {
      await sheetsFetch(`/values/${range(`${t.title}!A1`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [t.headers, ...(t.sample || [])] }),
      });
    }
  }

  // Sheets created by an older version may lack newer columns (e.g. "Hindi Name") in the header row.
  if (existing.length) {
    const qs = existing.map(t => 'ranges=' + range(`${t.title}!1:1`)).join('&');
    const json = await sheetsFetch(`/values:batchGet?${qs}`);
    for (const [i, t] of existing.entries()) {
      const header = json.valueRanges?.[i]?.values?.[0] || [];
      if (header.length < t.headers.length) {
        await sheetsFetch(`/values/${range(`${t.title}!A1`)}?valueInputOption=RAW`, {
          method: 'PUT',
          body: JSON.stringify({ values: [t.headers] }),
        });
      }
    }
  }
  tabIds = ids;
  return ids;
}

// ---------------------------------------------------------------------------
// Readers / writers
// ---------------------------------------------------------------------------

const isActive = v => !/^(no|n|false|0|inactive)$/i.test(String(v ?? '').trim());

const parsers = {
  staff: rows => rows
    .filter(r => String(r[0] || '').trim())
    .map(r => ({ name: String(r[0]).trim(), active: isActive(r[1]), nameHi: String(r[2] || '').trim() })),
  locations: rows => rows
    .filter(r => String(r[0] || '').trim())
    .map(r => ({
      id: String(r[0]).trim(),
      name: String(r[1] || r[0]).trim(),
      active: isActive(r[2]),
      nameHi: String(r[3] || '').trim(),
    })),
  attendance: rows => rows
    .filter(r => r[0] && r[1])
    .map(r => ({
      ts: Date.parse(r[0]) || 0,
      date: String(r[1]),
      time: String(r[2] || '').slice(0, 5),
      name: String(r[3] || ''),
      locId: String(r[4] || ''),
      locName: String(r[5] || ''),
      photoUrl: String(r[6] || ''),
    })),
};

/** Reads the given tabs in one request, e.g. readTabs('staff', 'locations'). */
export async function readTabs(...keys) {
  await ensureTabs();
  const qs = keys.map(k => 'ranges=' + range(`${TABS[k].title}!A2:H`)).join('&');
  const json = await sheetsFetch(`/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE`);
  const out = {};
  keys.forEach((k, i) => { out[k] = parsers[k](json.valueRanges?.[i]?.values || []); });
  return out;
}

/** Appends one row to a tab, e.g. appendRow('staff', ['Asha', 'Yes']). RAW input: values are never treated as formulas. */
export async function appendRow(key, row) {
  await ensureTabs();
  await sheetsFetch(
    `/values/${range(`${TABS[key].title}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) },
  );
}

/** 0-based row index of the first data row whose column A equals `value`, or -1. */
async function findDataRow(title, value) {
  const json = await sheetsFetch(`/values/${range(`${title}!A:A`)}`);
  return (json.values || []).findIndex((r, i) => i > 0 && String(r[0] || '').trim() === value);
}

/** Deletes the first data row whose column A equals `value`. Returns false if no row matched. */
export async function deleteRowByFirstCell(key, value) {
  const ids = await ensureTabs();
  const { title } = TABS[key];
  const index = await findDataRow(title, value);
  if (index < 0) return false;
  await sheetsFetch(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ deleteDimension: { range: { sheetId: ids[title], dimension: 'ROWS', startIndex: index, endIndex: index + 1 } } }],
    }),
  });
  return true;
}

/**
 * Sets the Hindi name of a worker (key 'staff', matched by name) or location (key 'locations', matched by ID).
 * Returns false if no row matched.
 */
export async function setHindiName(key, firstCell, nameHi) {
  await ensureTabs();
  const { title, hindiCol } = TABS[key];
  const index = await findDataRow(title, firstCell);
  if (index < 0) return false;
  await sheetsFetch(`/values/${range(`${title}!${hindiCol}${index + 1}`)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[nameHi]] }),
  });
  return true;
}

/**
 * English → Hindi using the sheet's own GOOGLETRANSLATE function (free, no extra API key).
 * Writes the formula into a random cell of a hidden scratch tab and reads the result back.
 * Returns '' if Google doesn't produce a translation in time.
 */
export async function translateToHindi(text) {
  await ensureTabs();
  const cell = `${TRANSLATE_TAB}!A${1 + crypto.randomInt(1000)}`;
  const formula = `=GOOGLETRANSLATE("${text.replace(/"/g, '""')}", "en", "hi")`;
  await sheetsFetch(`/values/${range(cell)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[formula]] }),
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const json = await sheetsFetch(`/values/${range(cell)}`);
    const value = String(json.values?.[0]?.[0] ?? '').trim();
    if (value && !/^(loading|#)/i.test(value)) {
      return /[\u0900-\u097F]/.test(value) ? value : ''; // no Devanagari → Google left it untranslated
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return '';
}

export function sheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${requireEnv('SHEET_ID')}/edit`;
}
