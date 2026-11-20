import { route, sendJson } from '../lib/http.js';
import { clearedCookie } from '../lib/auth.js';

export default route(['POST'], async (req, res) => {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie() });
});
