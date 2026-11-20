export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** JSON body — Vercel pre-parses it into req.body; fall back to reading the stream. */
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    for await (const chunk of req) raw += chunk;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Invalid request.');
  }
}

/** Trims, collapses whitespace and strips control characters from user-typed text. */
export function cleanText(value, maxLength = 60) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function queryParam(req, name) {
  return new URL(req.url, 'http://localhost').searchParams.get(name);
}

/** Wraps an API handler with a method check and uniform error responses. */
export function route(methods, fn) {
  return async (req, res) => {
    if (!methods.includes(req.method)) {
      return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: methods.join(', ') });
    }
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}
