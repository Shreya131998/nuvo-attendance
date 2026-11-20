import { route, sendJson } from '../lib/http.js';
import { readTabs } from '../lib/sheets.js';

// Data the worker form needs: active toilets and active staff names.
export default route(['GET'], async (req, res) => {
  const { staff, locations } = await readTabs('staff', 'locations');
  sendJson(res, 200, {
    locations: locations.filter(l => l.active).map(l => ({ id: l.id, name: l.name, nameHi: l.nameHi })),
    staff: staff.filter(s => s.active).map(s => ({ name: s.name, nameHi: s.nameHi })),
  });
});
