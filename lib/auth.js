import crypto from 'node:crypto';
import { requireEnv } from './http.js';

const COOKIE = 'admin_session';
const MAX_AGE_SEC = 12 * 60 * 60;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Keyed on the PIN too, so changing ADMIN_PIN logs every existing session out.
function sign(value) {
  return crypto.createHmac('sha256', requireEnv('SESSION_SECRET') + requireEnv('ADMIN_PIN'))
    .update(value).digest('base64url');
}

export function pinMatches(pin) {
  return safeEqual(pin || '', requireEnv('ADMIN_PIN'));
}

export function sessionCookie() {
  const expires = String(Date.now() + MAX_AGE_SEC * 1000);
  return `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SEC}`;
}

export function clearedCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function isAdmin(req) {
  const cookies = Object.fromEntries(
    String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2),
  );
  const [expires, sig] = String(cookies[COOKIE] || '').split('.');
  if (!expires || !sig) return false;
  return safeEqual(sig, sign(expires)) && Number(expires) > Date.now();
}
