import { HttpError, cleanText, queryParam, readJson, route, sendJson } from '../lib/http.js';
import { isAdmin } from '../lib/auth.js';
import { appendRow, deleteRowByFirstCell, readTabs, setHindiName, translateToHindi } from '../lib/sheets.js';

/** "Ground Floor Gents" → "GROUND-FLOOR-GENTS", made unique against existing IDs. */
function makeId(name, existingIds) {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'LOCATION';
  let id = base;
  for (let n = 2; existingIds.has(id); n++) id = `${base}-${n}`;
  return id;
}

// Admin: list (GET), add (POST { name, nameHi }), set Hindi name (PATCH { id, nameHi })
// and remove (DELETE ?id=) toilets in the Locations tab.
export default route(['GET', 'POST', 'PATCH', 'DELETE'], async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(401, 'Please log in.');

  if (req.method === 'POST') {
    const body = await readJson(req);
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, 'Enter the location name.');
    const { locations } = await readTabs('locations');
    if (locations.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `${name} is already in the list.`);
    }
    // Admin's own Hindi wins; otherwise fall back to an automatic translation.
    const nameHi = cleanText(body.nameHi, 80) || await translateToHindi(name).catch(() => '');
    await appendRow('locations', [makeId(name, new Set(locations.map(l => l.id))), name, 'Yes', nameHi]);
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const id = cleanText(body.id);
    if (!(await setHindiName('locations', id, cleanText(body.nameHi, 80)))) {
      throw new HttpError(404, 'Location not found. Refresh and try again.');
    }
  }

  if (req.method === 'DELETE') {
    const id = cleanText(queryParam(req, 'id'));
    if (!(await deleteRowByFirstCell('locations', id))) throw new HttpError(404, 'Location not found. Refresh and try again.');
  }

  const { locations } = await readTabs('locations');
  sendJson(res, 200, { locations });
});
