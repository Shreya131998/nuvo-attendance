import { HttpError, readJson, route, sendJson } from '../lib/http.js';
import { pinMatches, sessionCookie } from '../lib/auth.js';

export default route(['POST'], async (req, res) => {
  const { pin } = await readJson(req);
  if (!pinMatches(pin)) {
    await new Promise(r => setTimeout(r, 1000)); // slow down guessing
    throw new HttpError(401, 'Wrong PIN.');
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() });
});
