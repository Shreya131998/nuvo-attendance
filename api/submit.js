import crypto from 'node:crypto';
import { HttpError, readJson, route, sendJson } from '../lib/http.js';
import { appendRow, readTabs } from '../lib/sheets.js';
import { PHOTO_ROOT_FOLDER, uploadImage } from '../lib/cloudinary.js';
import { zonedNow } from '../lib/time.js';

const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB

const slug = s => String(s).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

export default route(['POST'], async (req, res) => {
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  const locId = String(body.locId || '').trim();
  const image = String(body.image || '');

  if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    throw new HttpError(400, 'Photo missing. Please take a photo.');
  }
  if (image.length > MAX_IMAGE_CHARS) throw new HttpError(413, 'Photo is too large. Please retake it.');

  const { staff, locations, attendance } = await readTabs('staff', 'locations', 'attendance');
  const loc = locations.find(l => l.active && l.id === locId);
  if (!loc) throw new HttpError(400, 'Please select the toilet you cleaned.');
  if (!staff.some(s => s.active && s.name === name)) throw new HttpError(400, 'Please select your name from the list.');

  // Server time only — the phone never decides when the work was done.
  const now = new Date();
  const { date, time } = zonedNow(now);
  const duplicate = attendance.some(r =>
    r.name === name && r.locId === loc.id && now.getTime() - r.ts < DUPLICATE_WINDOW_MS);

  const photo = await uploadImage(image, {
    folder: `${PHOTO_ROOT_FOLDER}/${date}`,
    publicId: [loc.id, slug(name), time.replace(/:/g, ''), crypto.randomBytes(4).toString('hex')].join('_'),
  });

  await appendRow('attendance', [now.toISOString(), date, time, name, loc.id, loc.name, photo.url, photo.publicId]);

  sendJson(res, 200, { name, locName: loc.name, date, time: time.slice(0, 5), duplicate });
});
