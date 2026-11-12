// Flag Ceremony Attendance: employees check in on their own phones during the check-in window,
// and the check-in counts only when the phone's GPS puts them inside the hospital's geofence.
// Times always come from the server clock (hospital time zone, see config.js).
const crypto = require('node:crypto');
const config = require('./config');
const { imageType } = require('./directory');
const u = require('./util');

const EMPLOYEE_COOKIE = 'hs_emp';
const DEVICE_COOKIE = 'hs_dev';
const MAX_PHOTO_BYTES = 600 * 1024;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Check-in results. ABSENT is never stored: it is an employee with no row for a ceremony that has closed.
// There is no "late": anyone who checks in while check-in is open is present.
const STATUSES = { ON_TIME: 'Present', EXCUSED: 'Excused', ABSENT: 'Absent' };

const DEFAULT_SETTINGS = {
  venue: 'ZRMC FLAGPOLE / MAIN GROUNDS',
  lat: null, // geofence centre; check-in stays off until staff set it
  lng: null,
  radius_m: 150,
  max_accuracy_m: 100, // GPS readings less precise than this are refused
  require_selfie: false,
  active_from: null, // weekly ceremonies are generated from this date on (set when the geofence is first saved)
  schedule: [{ weekday: 1, title: 'FLAG RAISING CEREMONY', opens: '07:00', starts: '08:00', closes: '09:00' }],
};

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const clean = (v, max = 120) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, max);
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// ---------- Settings ----------

async function getSettings(db) {
  const row = await db.one('SELECT data FROM flag_settings WHERE id = 1');
  let saved = {};
  try {
    saved = row ? JSON.parse(row.data) : {};
  } catch {
    saved = {};
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

const geofenceReady = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng);

function checkTimes(o, label) {
  for (const k of ['opens', 'starts', 'closes']) if (!TIME_RE.test(o[k] || '')) return `${label}: enter the check-in opening, start and closing times.`;
  if (!(o.opens <= o.starts && o.starts < o.closes)) return `${label}: check-in must open at or before the start time, and close after it.`;
  return null;
}

// Validates settings from the staff panel; returns [settings, error]
function cleanSettings(b, before) {
  const s = { ...before };
  s.venue = clean(b.venue, 120) || DEFAULT_SETTINGS.venue;
  const lat = num(b.lat);
  const lng = num(b.lng);
  if (Number.isNaN(lat) !== Number.isNaN(lng)) return [null, 'Enter both the latitude and the longitude of the venue.'];
  if (!Number.isNaN(lat)) {
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) return [null, 'The latitude or longitude is not valid.'];
    s.lat = Math.round(lat * 1e6) / 1e6;
    s.lng = Math.round(lng * 1e6) / 1e6;
  } else {
    s.lat = null;
    s.lng = null;
  }
  s.radius_m = Math.round(num(b.radius_m));
  if (!(s.radius_m >= 20 && s.radius_m <= 2000)) return [null, 'The geofence radius must be 20 to 2,000 meters.'];
  s.max_accuracy_m = Math.round(num(b.max_accuracy_m));
  if (!(s.max_accuracy_m >= 10 && s.max_accuracy_m <= 1000)) return [null, 'The required GPS accuracy must be 10 to 1,000 meters.'];
  delete s.grace_minutes; // no longer used (there is no late)
  s.require_selfie = b.require_selfie === true || b.require_selfie === 'on';
  if (!Array.isArray(b.schedule)) return [null, 'Invalid weekly schedule.'];
  if (b.schedule.length > 7) return [null, 'At most 7 weekly ceremonies.'];
  s.schedule = [];
  for (const item of b.schedule) {
    const w = Number(item.weekday);
    if (!(w >= 0 && w <= 6)) return [null, 'Choose the day of the week for each weekly ceremony.'];
    const x = { weekday: w, title: clean(item.title, 80) || 'FLAG CEREMONY', opens: item.opens, starts: item.starts, closes: item.closes };
    const err = checkTimes(x, `${WEEKDAYS[w]} ${x.title}`);
    if (err) return [null, err];
    if (s.schedule.some((y) => y.weekday === w && y.starts === x.starts)) return [null, `Two weekly ceremonies start on ${WEEKDAYS[w]} at the same time.`];
    s.schedule.push(x);
  }
  if (geofenceReady(s) && !s.active_from) s.active_from = u.todayStr();
  return [s, null];
}

// ---------- Ceremonies ----------

const slotOf = (item) => `W${item.weekday}-${item.starts}`;

// Creates the weekly ceremonies between two dates (inclusive), from the day the geofence was set up
async function ensureCeremonies(db, settings, from, to) {
  if (!settings.active_from || !settings.schedule.length) return;
  let d = from < settings.active_from ? settings.active_from : from;
  const values = [];
  const params = [];
  for (let i = 0; d <= to && i < 400; i++, d = u.addDays(d, 1)) {
    for (const item of settings.schedule) {
      if (u.dayOfWeek(d) !== item.weekday) continue;
      params.push(d, slotOf(item), item.title, item.opens, item.starts, item.closes);
      const n = params.length;
      values.push(`($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, 'AUTO')`);
    }
  }
  if (!values.length) return;
  await db.query(
    `INSERT INTO flag_ceremonies (ceremony_date, slot, title, opens_at, starts_at, closes_at, source) VALUES ${values.join(', ')}
     ON CONFLICT (ceremony_date, slot) DO NOTHING`,
    params,
  );
}

// After the weekly schedule changes, upcoming weekly ceremonies nobody has checked in to are rebuilt
async function resetUpcoming(db, now = new Date()) {
  await db.query(
    `DELETE FROM flag_ceremonies c WHERE c.source = 'AUTO' AND NOT c.cancelled
       AND (c.ceremony_date > $1 OR (c.ceremony_date = $1 AND c.opens_at > $2))
       AND NOT EXISTS (SELECT 1 FROM flag_checkins k WHERE k.ceremony_id = c.id)`,
    [u.todayStr(now), hhmm(now)],
  );
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Where a ceremony stands right now: UPCOMING, OPEN (check-in allowed) or CLOSED
function phase(c, now = new Date()) {
  const today = u.todayStr(now);
  if (c.ceremony_date > today) return 'UPCOMING';
  if (c.ceremony_date < today) return 'CLOSED';
  const t = hhmm(now);
  if (t < c.opens_at) return 'UPCOMING';
  return t < c.closes_at ? 'OPEN' : 'CLOSED';
}

function presentCeremony(c, now = new Date()) {
  return {
    id: c.id,
    date: c.ceremony_date,
    title: c.title,
    opens: c.opens_at,
    starts: c.starts_at,
    closes: c.closes_at,
    source: c.source,
    cancelled: c.cancelled,
    cancel_reason: c.cancel_reason,
    remarks: c.remarks || null,
    moved_to_date: c.moved_to_date || null,
    moved_from_date: c.moved_from_date || null,
    phase: c.cancelled ? 'CANCELLED' : phase(c, now),
  };
}


// ---------- Geofence ----------

// Great-circle distance in meters
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Checks a GPS reading against the geofence; returns { ok, distance, error }
function checkLocation(settings, b) {
  const lat = num(b.lat);
  const lng = num(b.lng);
  const accuracy = num(b.accuracy);
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180) || !(accuracy >= 0)) {
    return { ok: false, error: 'Your location could not be read. Turn on Location (GPS) on your phone and allow this site to use it.' };
  }
  const distance = Math.round(distanceM(settings.lat, settings.lng, lat, lng));
  const out = { lat, lng, accuracy: Math.round(accuracy), distance };
  if (accuracy > settings.max_accuracy_m) {
    return { ...out, ok: false, error: `Your GPS location is not precise enough (about ±${Math.round(accuracy)} m; ±${settings.max_accuracy_m} m needed). Turn on precise location, step outdoors or away from walls, wait a few seconds and try again.` };
  }
  if (distance > settings.radius_m) {
    return { ...out, ok: false, error: `You are about ${distance.toLocaleString('en-US')} m from the ceremony venue. Check-in only works within ${settings.radius_m} m of ${settings.venue}.` };
  }
  return { ...out, ok: true };
}

// ---------- Employees ----------

// Validates employee fields from the staff panel or a pasted list; returns [values, error]
function cleanEmployee(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('employee_no')) {
    out.employee_no = clean(b.employee_no, 30);
    if (!/^[A-Z0-9][A-Z0-9-]{0,29}$/.test(out.employee_no)) return [null, 'Employee no. must be letters, numbers or dashes (up to 30).'];
  }
  for (const [k, label] of [['last_name', 'last name'], ['first_name', 'first name']]) {
    if (!has(k)) continue;
    out[k] = clean(b[k], 60);
    if (!out[k]) return [null, `Please enter the employee's ${label}.`];
  }
  if (has('middle_name')) out.middle_name = clean(b.middle_name, 60) || null;
  if (has('position')) out.position = clean(b.position, 80) || null;
  // Division is stored in the department column
  if (has('division') || (partial && b.department !== undefined)) out.department = clean(b.division ?? b.department, 80) || null;
  if (has('unit')) out.unit = clean(b.unit, 80) || null;
  if (b.flag_required !== undefined) out.flag_required = !(b.flag_required === false || b.flag_required === 'false' || b.flag_required === '0');
  return [out, null];
}

const checkPin = (pin) => (/^\d{6}$/.test(String(pin || '')) ? null : 'The PIN must be exactly 6 digits.');
const randomPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const fullName = (e) => `${e.last_name}, ${e.first_name}${e.middle_name ? ` ${e.middle_name[0]}.` : ''}`;

function decodePhoto(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  const mime = imageType(buf);
  if (!mime || buf.length > MAX_PHOTO_BYTES) return null;
  return { buf, mime };
}

// ---------- CSV ----------

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`; // never let a cell run as a spreadsheet formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

// Parses a pasted employee list (from Excel or CSV): header row optional
const IMPORT_COLUMNS = ['employee_no', 'last_name', 'first_name', 'middle_name', 'position', 'division', 'unit'];
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  if (rows.length && /employee/i.test(rows[0][0] || '')) rows.shift();
  return rows.map((r) => Object.fromEntries(IMPORT_COLUMNS.map((k, i) => [k, (r[i] || '').trim()])));
}

async function purgeFlagPhotos(db, now = new Date()) {
  const rows = await db.query(
    "DELETE FROM flag_checkin_photos WHERE created_at < $1::timestamptz - ($2 || ' days')::interval RETURNING checkin_id",
    [now.toISOString(), String(config.flag.photoRetentionDays)],
  );
  return rows.length;
}

module.exports = {
  EMPLOYEE_COOKIE,
  DEVICE_COOKIE,
  STATUSES,
  WEEKDAYS,
  IMPORT_COLUMNS,
  DEFAULT_SETTINGS,
  hashToken,
  newToken,
  getSettings,
  geofenceReady,
  cleanSettings,
  checkTimes,
  ensureCeremonies,
  resetUpcoming,
  hhmm,
  phase,
  presentCeremony,
  distanceM,
  checkLocation,
  cleanEmployee,
  checkPin,
  randomPin,
  fullName,
  decodePhoto,
  toCsv,
  parseCsv,
  purgeFlagPhotos,
};
