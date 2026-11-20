// Local dev server: serves public/ and api/* the way Vercel does.
//
//   npm run dev    → uses your real keys from .env.local
//   npm run demo   → no keys needed; fake in-memory Google Sheet + Cloudinary (admin PIN 1234)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.argv.includes('--demo');

loadEnvFile(path.join(ROOT, '.env.local'));
if (DEMO) installDemoServices();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (DEMO && url.pathname.startsWith('/demo-cdn/')) return serveDemoImage(url.pathname, res);

    if (url.pathname.startsWith('/api/')) {
      const file = path.join(ROOT, 'api', path.basename(url.pathname) + '.js');
      if (!fs.existsSync(file)) return notFound(res);
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(req, res);
    }

    // Static files with Vercel-style clean URLs (/admin → admin.html)
    let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (!path.extname(rel)) rel += '.html';
    const file = path.join(ROOT, 'public', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) return notFound(res);
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Server error');
  }
}).listen(PORT, () => {
  console.log(`\n  ${DEMO ? 'DEMO mode (fake Sheet + Cloudinary)' : 'Dev mode (real keys from .env.local)'}`);
  console.log(`  Worker form:  http://localhost:${PORT}/`);
  console.log(`  Dashboard:    http://localhost:${PORT}/admin${DEMO ? '   (PIN 1234)' : ''}\n`);
});

function notFound(res) {
  res.statusCode = 404;
  res.end('Not found');
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------------------------------------------------------------------------
// Demo mode: intercept outgoing calls to Google and Cloudinary with in-memory fakes
// ---------------------------------------------------------------------------

const demoTabs = {};
const demoImages = {};

function installDemoServices() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    ADMIN_PIN: '1234',
    SESSION_SECRET: 'demo-secret',
    SHEET_ID: 'demo-sheet',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'demo@demo.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'demo',
    CLOUDINARY_API_SECRET: 'demo',
  });

  const realFetch = globalThis.fetch;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = async (input, opts = {}) => {
    const url = String(input);

    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'demo', expires_in: 3600 });

    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/demo-sheet')) {
      const u = new URL(url);
      const p = decodeURIComponent(u.pathname.replace('/v4/spreadsheets/demo-sheet', ''));
      const body = opts.body ? JSON.parse(opts.body) : null;
      let m;
      const titles = Object.keys(demoTabs);
      if (p === '') return json({ sheets: titles.map((title, i) => ({ properties: { title, sheetId: i } })) });
      if (p === ':batchUpdate') {
        const replies = body.requests.map(r => {
          if (r.addSheet) {
            const title = r.addSheet.properties.title;
            demoTabs[title] = [];
            return { addSheet: { properties: { title, sheetId: Object.keys(demoTabs).indexOf(title) } } };
          }
          if (r.deleteDimension) {
            const { sheetId, startIndex, endIndex } = r.deleteDimension.range;
            demoTabs[titles[sheetId]].splice(startIndex, endIndex - startIndex);
          }
          return {};
        });
        return json({ replies });
      }
      if ((m = /^\/values\/([^!]+)!A:A$/.exec(p))) return json({ values: (demoTabs[m[1]] || []).map(r => [r[0]]) });
      if (p === '/values:batchGet') {
        return json({
          valueRanges: u.searchParams.getAll('ranges').map(r => {
            const [title, cells] = r.split('!');
            const rows = demoTabs[title] || [];
            return { values: cells === '1:1' ? rows.slice(0, 1) : rows.slice(1) };
          }),
        });
      }
      if ((m = /^\/values\/([^!]+)!A1:append$/.exec(p))) { demoTabs[m[1]].push(body.values[0]); return json({}); }
      if ((m = /^\/values\/([^!]+)!([A-Z])(\d+)$/.exec(p))) {
        const rows = demoTabs[m[1]] || (demoTabs[m[1]] = []);
        const col = m[2].charCodeAt(0) - 65;
        const row = Number(m[3]) - 1;
        if (opts.method === 'PUT') {
          const formulas = u.searchParams.get('valueInputOption') === 'USER_ENTERED';
          body.values.forEach((vals, i) => {
            const target = rows[row + i] || (rows[row + i] = []);
            vals.forEach((v, j) => { target[col + j] = formulas ? demoFormula(v) : v; });
          });
          return json({});
        }
        return json({ values: [[(rows[row] || [])[col] ?? '']] });
      }
      return json({ error: { message: 'Demo: unsupported call ' + p } }, 400);
    }

    if (url.startsWith('https://api.cloudinary.com/')) {
      const form = new URLSearchParams(String(opts.body));
      const id = `${form.get('folder')}/${form.get('public_id')}`;
      demoImages[id] = Buffer.from(form.get('file').split(',')[1], 'base64');
      return json({ public_id: id, secure_url: `http://localhost:${PORT}/demo-cdn/image/upload/${id}.jpg` });
    }

    return realFetch(input, opts);
  };
}

// Stand-in for the sheet's GOOGLETRANSLATE: a small word list, enough to try the feature.
const DEMO_HINDI = [
  ['ground floor', 'भूतल'], ['first floor', 'पहली मंज़िल'], ['second floor', 'दूसरी मंज़िल'],
  ['third floor', 'तीसरी मंज़िल'], ['floor', 'मंज़िल'], ['gents', 'पुरुष'], ['men', 'पुरुष'],
  ['ladies', 'महिला'], ['women', 'महिला'], ['toilet', 'शौचालय'], ['washroom', 'शौचालय'],
  ['bathroom', 'स्नानघर'], ['staff', 'कर्मचारी'], ['office', 'कार्यालय'], ['main', 'मुख्य'],
  ['block', 'ब्लॉक'], ['canteen', 'कैंटीन'], ['and', 'और'],
  // A few common names, so worker names can be tried too
  ['ramesh', 'रमेश'], ['suresh', 'सुरेश'], ['mahesh', 'महेश'], ['mohan', 'मोहन'], ['raju', 'राजू'],
  ['sunita', 'सुनीता'], ['anita', 'अनीता'], ['geeta', 'गीता'], ['sita', 'सीता'], ['priya', 'प्रिया'],
  ['pooja', 'पूजा'], ['kumar', 'कुमार'], ['devi', 'देवी'], ['sharma', 'शर्मा'], ['verma', 'वर्मा'],
  ['singh', 'सिंह'], ['yadav', 'यादव'], ['gupta', 'गुप्ता'], ['lal', 'लाल'], ['das', 'दास'],
];

function demoFormula(value) {
  const m = /^=GOOGLETRANSLATE\("((?:[^"]|"")*)", "en", "hi"\)$/.exec(String(value));
  if (!m) return value;
  const known = DEMO_HINDI.reduce((s, [en, hi]) => s.replace(new RegExp(`\\b${en}\\b`, 'gi'), hi), m[1].replace(/""/g, '"'));
  return known.replace(/[A-Za-z]+/g, transliterate); // words not in the list: sound them out
}

// Rough English-spelling → Devanagari, e.g. "Shreya" → "श्रेया". Demo only; real Google does much better.
const CONSONANTS = [
  ['chh', 'छ'], ['ksh', 'क्ष'], ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'], ['th', 'थ'], ['dh', 'ध'],
  ['ph', 'फ'], ['bh', 'भ'], ['sh', 'श'], ['k', 'क'], ['g', 'ग'], ['j', 'ज'], ['t', 'त'], ['d', 'द'],
  ['n', 'न'], ['p', 'प'], ['b', 'ब'], ['m', 'म'], ['y', 'य'], ['r', 'र'], ['l', 'ल'], ['v', 'व'],
  ['w', 'व'], ['s', 'स'], ['h', 'ह'], ['f', 'फ़'], ['z', 'ज़'], ['q', 'क'], ['c', 'क'], ['x', 'क्स'],
];
const VOWELS = [ // [spelling, standalone letter, sign after a consonant]
  ['aa', 'आ', 'ा'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'], ['ee', 'ई', 'ी'], ['ii', 'ई', 'ी'], ['oo', 'ऊ', 'ू'],
  ['ou', 'औ', 'ौ'], ['a', 'अ', ''], ['e', 'ए', 'े'], ['i', 'इ', 'ि'], ['o', 'ओ', 'ो'], ['u', 'उ', 'ु'],
];

function transliterate(word) {
  const w = word.toLowerCase();
  let out = '';
  let afterConsonant = false;
  for (let i = 0; i < w.length;) {
    const c = CONSONANTS.find(([en]) => w.startsWith(en, i));
    if (c) {
      if (afterConsonant) out += '्'; // join consonant clusters: श + ् + र = श्र
      out += c[1];
      afterConsonant = true;
      i += c[0].length;
      continue;
    }
    const v = VOWELS.find(([en]) => w.startsWith(en, i));
    if (!v) { i++; continue; }
    const last = i + v[0].length === w.length;
    // A final "a" in names is usually long: Shreya → श्रेया, Priya → प्रिया
    out += afterConsonant ? (v[0] === 'a' && last ? 'ा' : v[2]) : v[1];
    afterConsonant = false;
    i += v[0].length;
  }
  return out;
}

function serveDemoImage(pathname, res) {
  const id = Object.keys(demoImages).find(k => pathname.endsWith(`/${k}.jpg`));
  if (!id) return notFound(res);
  res.setHeader('Content-Type', 'image/jpeg');
  res.end(demoImages[id]);
}
