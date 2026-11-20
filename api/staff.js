import { HttpError, cleanText, queryParam, readJson, route, sendJson } from '../lib/http.js';
import { isAdmin } from '../lib/auth.js';
import { appendRow, deleteRowByFirstCell, readTabs, setHindiName, translateToHindi } from '../lib/sheets.js';

// Admin: list (GET), add (POST { name, nameHi }), set Hindi name (PATCH { name, nameHi })
// and remove (DELETE ?name=) workers in the Staff tab.
export default route(['GET', 'POST', 'PATCH', 'DELETE'], async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(401, 'Please log in.');

  if (req.method === 'POST') {
    const body = await readJson(req);
    const name = cleanText(body.name);
    if (!name) throw new HttpError(400, "Enter the worker's name.");
    const { staff } = await readTabs('staff');
    if (staff.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `${name} is already in the list.`);
    }
    // Admin's own Hindi wins; otherwise fall back to an automatic one.
    const nameHi = cleanText(body.nameHi) || await translateToHindi(name).catch(() => '');
    await appendRow('staff', [name, 'Yes', nameHi]);
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!(await setHindiName('staff', cleanText(body.name), cleanText(body.nameHi)))) {
      throw new HttpError(404, 'Worker not found. Refresh and try again.');
    }
  }

  if (req.method === 'DELETE') {
    const name = cleanText(queryParam(req, 'name'));
    if (!(await deleteRowByFirstCell('staff', name))) throw new HttpError(404, 'Worker not found. Refresh and try again.');
  }

  const { staff } = await readTabs('staff');
  sendJson(res, 200, { staff });
});
