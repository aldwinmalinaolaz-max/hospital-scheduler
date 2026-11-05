// Valid ID, selfie-with-ID and payment receipt photos submitted for digital copy requests.
// They are personal data: only staff with Records access can view them, and they are deleted
// automatically once the request has been finished for ID_PHOTO_RETENTION_DAYS days.
const config = require('./config');
const { imageType } = require('./directory');

const KINDS = { ID: 'valid ID', SELFIE: 'selfie holding the valid ID', RECEIPT: 'payment receipt' };
const MAX_BYTES = 2 * 1024 * 1024;

// Photos arrive as data URLs (resized in the browser). Returns { buf, mime } or an error message.
function decodePhoto(dataUrl, label) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: `Please upload a photo of your ${label}.` };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_BYTES) return { error: `The photo of your ${label} is too large (max 2 MB).` };
  const mime = imageType(buf);
  if (!mime) return { error: `The photo of your ${label} must be a JPG, PNG or WebP image.` };
  return { buf, mime };
}

// Checks the photos in a request body ({ id_photo, selfie_photo, receipt_photo }); returns [photos, error]
function readPhotos(b) {
  const photos = {};
  for (const [kind, field] of [['ID', 'id_photo'], ['SELFIE', 'selfie_photo'], ['RECEIPT', 'receipt_photo']]) {
    const p = decodePhoto(b[field], KINDS[kind]);
    if (p.error) return [null, p.error];
    photos[kind] = p;
  }
  return [photos, null];
}

async function savePhotos(t, requestId, photos) {
  for (const [kind, p] of Object.entries(photos)) {
    await t.query(
      `INSERT INTO record_id_photos (request_id, kind, image, mime) VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id, kind) DO UPDATE SET image = excluded.image, mime = excluded.mime, created_at = now()`,
      [requestId, kind, p.buf, p.mime],
    );
  }
}

// Deletes photos of requests that were released, rejected or cancelled more than the retention period ago
async function purgeIdPhotos(db, now = new Date()) {
  const rows = await db.query(
    `DELETE FROM record_id_photos p USING record_requests r
     WHERE p.request_id = r.id AND r.status IN ('RELEASED', 'REJECTED', 'CANCELLED')
       AND r.updated_at < $1::timestamptz - ($2 || ' days')::interval
     RETURNING p.id`,
    [now.toISOString(), String(config.records.idPhotoRetentionDays)],
  );
  return rows.length;
}

module.exports = { KINDS, readPhotos, savePhotos, purgeIdPhotos };
