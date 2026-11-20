import crypto from 'node:crypto';
import { requireEnv } from './http.js';

export const PHOTO_ROOT_FOLDER = process.env.CLOUDINARY_FOLDER || 'cleaning-attendance';

/** Uploads a data-URI image with a signed request. Returns { url, publicId }. */
export async function uploadImage(dataUri, { folder, publicId }) {
  const cloudName = requireEnv('CLOUDINARY_CLOUD_NAME');
  const apiKey = requireEnv('CLOUDINARY_API_KEY');
  const apiSecret = requireEnv('CLOUDINARY_API_SECRET');

  const params = { folder, public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: new URLSearchParams({ ...params, file: dataUri, api_key: apiKey, signature }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Cloudinary upload failed: ' + (json.error?.message || res.status));
  return { url: json.secure_url, publicId: json.public_id };
}

/** Inserts a Cloudinary transformation into a delivery URL, e.g. 'c_fill,w_160,h_160'. */
export function transformUrl(url, transformation) {
  return url.includes('/image/upload/') ? url.replace('/image/upload/', `/image/upload/${transformation}/`) : url;
}
