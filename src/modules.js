// Public services that Administrators can turn on and off (Staff Panel -> Settings -> Public
// services). A turned-off module disappears from the public site and its public API refuses
// requests; the Staff Panel keeps working. Turning off a module also turns off its sub-modules.
const MODULES = [
  { key: 'records', name: 'Request Records', subs: [{ key: 'records.digital', name: 'Digital copies (emailed, with ID check and online payment)' }] },
  { key: 'opd', name: 'Book OPD Appointment', subs: [] },
  { key: 'track', name: 'Track / Cancel', subs: [{ key: 'track.cancel', name: 'Cancel a request or appointment online' }] },
  {
    key: 'directory',
    name: 'Hospital Directory',
    subs: [
      { key: 'directory.list', name: 'Departments, clinics & offices' },
      { key: 'directory.schedules', name: 'Clinic schedules & office hours' },
      { key: 'directory.requirements', name: 'Requirements for common transactions' },
      { key: 'directory.contact', name: 'Contact information' },
      { key: 'directory.wayfinding', name: 'Find your way (directions)' },
      { key: 'directory.maps', name: 'Building & service-area maps' },
    ],
  },
  { key: 'chat', name: 'FAQ assistant (chat)', subs: [] },
  { key: 'facility', name: 'Referral Portal (for health facilities)', subs: [] },
  { key: 'flag', name: 'Flag Ceremony check-in (employees)', subs: [] },
];
const ALL = MODULES.flatMap((m) => [m, ...m.subs]);
const KEYS = new Set(ALL.map((m) => m.key));
const nameOf = (key) => ALL.find((m) => m.key === key)?.name || key;

async function getSettings(db) {
  const row = await db.one("SELECT data FROM site_settings WHERE key = 'public_modules'");
  let s = {};
  try {
    s = row ? JSON.parse(row.data) : {};
  } catch {
    s = {};
  }
  return { disabled: (s.disabled || []).filter((k) => KEYS.has(k)), message: s.message || '' };
}

// Whether a module is on: it and its parent module are not turned off
const isOn = (settings, key) => !settings.disabled.includes(key) && !(key.includes('.') && settings.disabled.includes(key.split('.')[0]));

// { key: true|false } for every module, as the public pages use it
function effective(settings) {
  return Object.fromEntries(ALL.map((m) => [m.key, isOn(settings, m.key)]));
}

function offMessage(settings, key) {
  return `${nameOf(key)} is not available online right now.${settings.message ? ` ${settings.message}` : ''}`;
}

// Express middleware: answers 503 when the module is turned off
const requireModule = (db, key) => async (req, res, next) => {
  const s = await getSettings(db);
  if (isOn(s, key)) return next();
  res.status(503).json({ error: offMessage(s, key), module_off: key });
};

module.exports = { MODULES, KEYS, getSettings, isOn, effective, offMessage, requireModule };
