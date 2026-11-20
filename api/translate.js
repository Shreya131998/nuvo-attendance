import { HttpError, cleanText, queryParam, route, sendJson } from '../lib/http.js';
import { isAdmin } from '../lib/auth.js';
import { translateToHindi } from '../lib/sheets.js';

// Admin: suggest a Hindi translation for an English location name (GET ?text=).
export default route(['GET'], async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(401, 'Please log in.');
  const text = cleanText(queryParam(req, 'text'), 80);
  if (!text) throw new HttpError(400, 'Enter some text to translate.');
  sendJson(res, 200, { hi: await translateToHindi(text) });
});
