// Postgres access. Uses Supabase (or any Postgres) when DATABASE_URL is set;
// otherwise an embedded Postgres (PGlite) for local development and tests.
//
// Every driver is wrapped to the same small API:
//   db.query(sql, params) -> rows      db.one(sql, params) -> first row | undefined
//   db.exec(sql)                       db.tx(async (t) => …) -> runs fn in a transaction
const path = require('node:path');
const config = require('./config');
const { hashPassword } = require('./auth');
const { SEEDS } = require('./faq');
const directory = require('./directory');
const catalog = require('./catalog');
const clinics = require('./clinics');
const { todayStr } = require('./util');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS record_requests (
    id SERIAL PRIMARY KEY,
    ref_no TEXT NOT NULL UNIQUE,
    patient_last TEXT NOT NULL,
    patient_first TEXT NOT NULL,
    patient_middle TEXT,
    birthdate TEXT NOT NULL,
    hospital_no TEXT,
    admission_date TEXT,
    discharge_date TEXT,
    requester_name TEXT NOT NULL,
    requester_relation TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT,
    purpose TEXT NOT NULL,
    pickup_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    remarks TEXT,
    reminded_pickup BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_rr_pickup ON record_requests(pickup_date);

  CREATE TABLE IF NOT EXISTS record_request_items (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES record_requests(id) ON DELETE CASCADE,
    record_type TEXT NOT NULL,
    details TEXT,
    copies INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_rri_request ON record_request_items(request_id);

  CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    ref_no TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    appt_date TEXT NOT NULL,
    appt_time TEXT NOT NULL,
    patient_type TEXT NOT NULL,
    hospital_no TEXT,
    patient_last TEXT NOT NULL,
    patient_first TEXT NOT NULL,
    patient_middle TEXT,
    birthdate TEXT NOT NULL,
    sex TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT,
    complaint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'BOOKED',
    remarks TEXT,
    reminded_day_before BOOLEAN NOT NULL DEFAULT FALSE,
    reminded_hours_before BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_appt_slot ON appointments(department, appt_date, appt_time);

  CREATE TABLE IF NOT EXISTS sms_log (
    id SERIAL PRIMARY KEY,
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_no TEXT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS closed_dates (
    date TEXT PRIMARY KEY,
    reason TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );

  -- Staff accounts (table name kept as "admins" for existing databases)
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS full_name TEXT;
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'ADMIN';
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  -- Per-user access for Staff (Administrators always have both)
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS can_records BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS can_opd BOOLEAN NOT NULL DEFAULT TRUE;

  -- What the SMS gateway answered (reference id, its status, raw reply) for troubleshooting delivery
  ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS provider_ref TEXT;
  ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS provider_status TEXT;
  ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS provider_response TEXT;

  -- Patient's address, needed for the authorization letter when someone else requests
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS patient_address TEXT;

  -- Hardcopy (claimed at HHIMS) or digital copy (emailed after the requester's ID is verified)
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS copy_type TEXT NOT NULL DEFAULT 'HARDCOPY';
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_status TEXT;          -- PENDING | VERIFIED | REJECTED (digital only)
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_remarks TEXT;
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_checked_by TEXT;
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_checked_at TIMESTAMPTZ;
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS assigned_to TEXT;        -- staff username
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS emailed_by TEXT;

  -- Payment: total computed from the fees when the request is made; digital copies are paid online
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS amount_due NUMERIC(10, 2);
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS payment_ref TEXT;

  -- Which staff member last changed a request
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS updated_by TEXT;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_by TEXT;

  -- Supabase exposes the public schema through its REST API. Enabling RLS with no
  -- policies blocks that access; this server connects as the table owner and is unaffected.
  -- FAQ assistant: staff-written answers, and questions it could not answer
  CREATE TABLE IF NOT EXISTS faqs (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    link_url TEXT,
    link_label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS faq_unanswered (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Hospital Directory & Navigation
  CREATE TABLE IF NOT EXISTS maps (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    image BYTEA NOT NULL,
    mime TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 100,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS directory_entries (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Department',
    description TEXT,
    location TEXT,
    hours TEXT,
    phone TEXT,
    email TEXT,
    services TEXT,
    keywords TEXT NOT NULL DEFAULT '',
    opd_code TEXT,
    map_id INTEGER REFERENCES maps(id) ON DELETE SET NULL,
    pin_x REAL,
    pin_y REAL,
    sort_order INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Digital wayfinding on a map: points (gates, buildings, landmarks, junctions) and walkable paths
  ALTER TABLE maps ADD COLUMN IF NOT EXISTS width_m REAL;   -- real width the map image covers (for distances)
  CREATE TABLE IF NOT EXISTS way_points (
    id SERIAL PRIMARY KEY,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    name TEXT,                            -- empty for plain path junctions
    code TEXT,                            -- building no. on the map, e.g. 4A
    kind TEXT NOT NULL DEFAULT 'JUNCTION',-- GATE | BUILDING | LANDMARK | JUNCTION
    x REAL NOT NULL,                      -- % of the image width
    y REAL NOT NULL,                      -- % of the image height
    is_start BOOLEAN NOT NULL DEFAULT FALSE, -- offered as a starting point / "You are here" sign
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS way_paths (
    id SERIAL PRIMARY KEY,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    a_id INTEGER NOT NULL REFERENCES way_points(id) ON DELETE CASCADE,
    b_id INTEGER NOT NULL REFERENCES way_points(id) ON DELETE CASCADE,
    step_free BOOLEAN NOT NULL DEFAULT TRUE  -- FALSE when the way has stairs (not for wheelchairs)
  );
  CREATE INDEX IF NOT EXISTS idx_way_points_map ON way_points(map_id);
  CREATE INDEX IF NOT EXISTS idx_way_paths_map ON way_paths(map_id);

  -- The building / point on a map where a directory place is, for directions
  ALTER TABLE directory_entries ADD COLUMN IF NOT EXISTS way_point_id INTEGER REFERENCES way_points(id) ON DELETE SET NULL;

  CREATE TABLE IF NOT EXISTS guides (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    steps TEXT,
    requirements TEXT,
    office_id INTEGER REFERENCES directory_entries(id) ON DELETE SET NULL,
    link_url TEXT,
    link_label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Settings kept as JSON (e.g. which public services are turned on)
  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS site_info (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  -- OPD clinics and their monthly schedules (Admin → OPD Schedules)
  CREATE TABLE IF NOT EXISTS opd_clinics (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100
  );
  CREATE TABLE IF NOT EXISTS opd_schedules (
    clinic_code TEXT NOT NULL REFERENCES opd_clinics(code) ON DELETE CASCADE,
    month TEXT NOT NULL,                 -- YYYY-MM
    days TEXT NOT NULL DEFAULT '',       -- weekdays, 0=Sun … 6=Sat, comma-separated
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    slot_minutes INTEGER NOT NULL,
    per_slot INTEGER NOT NULL,
    closed_dates TEXT NOT NULL DEFAULT '', -- YYYY-MM-DD, comma-separated
    extra_dates TEXT NOT NULL DEFAULT '',
    note TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (clinic_code, month)
  );

  -- Valid ID and selfie-with-ID photos for digital copy requests (deleted automatically after the
  -- request is finished; see purgeIdPhotos). Only staff with Records access can view them.
  CREATE TABLE IF NOT EXISTS record_id_photos (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES record_requests(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                  -- ID | SELFIE
    image BYTEA NOT NULL,
    mime TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (request_id, kind)
  );

  -- Fee per copy for each document type (Admin → Settings)
  CREATE TABLE IF NOT EXISTS document_fees (
    record_type TEXT PRIMARY KEY,
    fee NUMERIC(10, 2) NOT NULL
  );

  -- Images staff can replace, e.g. the payment QR code (falls back to the file in public/img)
  CREATE TABLE IF NOT EXISTS site_images (
    key TEXT PRIMARY KEY,
    image BYTEA NOT NULL,
    mime TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Referrals from RHUs, barangay health centers and other hospitals
  CREATE TABLE IF NOT EXISTS facilities (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                   -- RHU | BHS | HOSPITAL | OTHER
    municipality TEXT,
    contact_person TEXT,
    phone TEXT,                           -- receives SMS when ZRMC responds
    email TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Logins for referring facilities: separate from hospital staff (admins), so a facility
  -- account can never reach the staff panel
  CREATE TABLE IF NOT EXISTS facility_users (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    session_version INTEGER NOT NULL DEFAULT 0,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    ref_no TEXT NOT NULL UNIQUE,
    facility_id INTEGER NOT NULL REFERENCES facilities(id),
    status TEXT NOT NULL DEFAULT 'SENT',  -- SENT | RECEIVED | ACCEPTED | REDIRECTED | ARRIVED | SEEN | CANCELLED
    urgency TEXT NOT NULL,                -- EMERGENCY | URGENT | ROUTINE
    department TEXT NOT NULL,             -- receiving service, e.g. an OPD clinic or the Emergency Room
    patient_last TEXT NOT NULL,
    patient_first TEXT NOT NULL,
    patient_middle TEXT,
    birthdate TEXT NOT NULL,
    sex TEXT NOT NULL,
    address TEXT NOT NULL,
    mobile TEXT,
    philhealth_no TEXT,
    reason TEXT NOT NULL,
    chief_complaint TEXT NOT NULL,
    history TEXT,
    working_diagnosis TEXT NOT NULL,
    treatment_given TEXT,
    bp TEXT, hr TEXT, rr TEXT, temp TEXT, o2sat TEXT, weight TEXT,
    referring_name TEXT NOT NULL,
    referring_designation TEXT,
    referring_contact TEXT,
    response_note TEXT,                   -- ZRMC's reply to the facility
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    feedback TEXT,                        -- return slip: findings / instructions after the patient was seen
    responded_by TEXT, responded_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ, seen_at TIMESTAMPTZ,
    exported_at TIMESTAMPTZ,              -- last exported for Bizbox
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_facility ON referrals(facility_id, created_at);
  CREATE TABLE IF NOT EXISTS referral_attachments (
    id SERIAL PRIMARY KEY,
    referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Staff permission for the Referrals tab (administrators always have it)
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS can_referrals BOOLEAN NOT NULL DEFAULT FALSE;

  -- Automatic ID check (OCR) for digital copies: text read from the ID photo and how it compares
  -- with the patient's name and birthdate. Advice for staff only; the text is deleted with the photos.
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_ocr_status TEXT;   -- MATCH | PARTIAL | MISMATCH | UNREADABLE
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_ocr_notes TEXT;    -- JSON array of mismatch notes
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_ocr_text TEXT;
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_ocr_by TEXT;       -- NULL = read on the requester's phone, else staff username
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS id_ocr_at TIMESTAMPTZ;

  -- Flag Ceremony Attendance: employees check in on their phones inside a GPS geofence
  -- (staff permission column keeps its original name)
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS can_attendance BOOLEAN NOT NULL DEFAULT FALSE;
  -- QR scanning at the flag ceremony venue: Administrators and HR staff only (needs can_attendance)
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS can_flag_scan BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    employee_no TEXT NOT NULL UNIQUE,
    last_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    position TEXT,
    department TEXT,
    pin_hash TEXT NOT NULL,
    failed_pins INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- The employee's division is kept in the "department" column; the unit is separate
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS unit TEXT;
  -- Employment type tag: PLANTILLA | JOB_ORDER (NULL = not tagged yet)
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type TEXT;
  -- Division names for the employee dropdown (Employees → Divisions & units)
  CREATE TABLE IF NOT EXISTS flag_divisions (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  -- FALSE for employees who are not expected at flag ceremonies (e.g. fixed night duty)
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS flag_required BOOLEAN NOT NULL DEFAULT TRUE;
  -- Bumped when the PIN is reset or the employee is deactivated: signs them out of every phone
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
  -- TRUE while the employee still has a PIN set by HR (the default); they must choose their own
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_must_change BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE TABLE IF NOT EXISTS flag_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,                   -- JSON, see DEFAULT_SETTINGS in flag.js
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS flag_ceremonies (
    id SERIAL PRIMARY KEY,
    ceremony_date TEXT NOT NULL,          -- YYYY-MM-DD, hospital time
    slot TEXT NOT NULL,                   -- W<weekday>-<start> for weekly ceremonies, M-<random> for special ones
    title TEXT NOT NULL,
    opens_at TEXT NOT NULL,               -- HH:MM check-in opens
    starts_at TEXT NOT NULL,              -- HH:MM ceremony starts; later check-ins are late
    closes_at TEXT NOT NULL,              -- HH:MM check-in closes
    source TEXT NOT NULL DEFAULT 'AUTO',  -- AUTO (weekly schedule) | MANUAL (added by staff)
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_reason TEXT,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ceremony_date, slot)
  );
  -- Notes for a ceremony (e.g. held indoors due to rain), and dates moved for holidays: the
  -- original stays cancelled with moved_to_date so the weekly schedule does not recreate it
  ALTER TABLE flag_ceremonies ADD COLUMN IF NOT EXISTS remarks TEXT;
  ALTER TABLE flag_ceremonies ADD COLUMN IF NOT EXISTS moved_to_date TEXT;
  ALTER TABLE flag_ceremonies ADD COLUMN IF NOT EXISTS moved_from_date TEXT;
  CREATE TABLE IF NOT EXISTS flag_checkins (
    id SERIAL PRIMARY KEY,
    ceremony_id INTEGER NOT NULL REFERENCES flag_ceremonies(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('ON_TIME', 'LATE', 'EXCUSED')),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT NOT NULL DEFAULT 'GPS',   -- GPS (employee's phone) | MANUAL (set by staff)
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, accuracy_m INTEGER, distance_m INTEGER,
    device_hash TEXT,                     -- one phone can check in only one employee per ceremony
    user_agent TEXT,
    remarks TEXT,                         -- reason for a manual entry or an excuse
    created_by TEXT,
    UNIQUE (ceremony_id, employee_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_flag_checkins_device ON flag_checkins(ceremony_id, device_hash) WHERE device_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_flag_checkins_emp ON flag_checkins(employee_id);
  CREATE TABLE IF NOT EXISTS flag_checkin_photos (
    checkin_id INTEGER PRIMARY KEY REFERENCES flag_checkins(id) ON DELETE CASCADE,
    image BYTEA NOT NULL,
    mime TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One-time content updates that have already been applied (see MIGRATIONS below)
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE record_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE record_request_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sms_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE closed_dates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
  ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE faq_unanswered ENABLE ROW LEVEL SECURITY;
  ALTER TABLE maps ENABLE ROW LEVEL SECURITY;
  ALTER TABLE way_points ENABLE ROW LEVEL SECURITY;
  ALTER TABLE way_paths ENABLE ROW LEVEL SECURITY;
  ALTER TABLE directory_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE guides ENABLE ROW LEVEL SECURITY;
  ALTER TABLE site_info ENABLE ROW LEVEL SECURITY;
  ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE opd_clinics ENABLE ROW LEVEL SECURITY;
  ALTER TABLE record_id_photos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE document_fees ENABLE ROW LEVEL SECURITY;
  ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
  ALTER TABLE facility_users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
  ALTER TABLE referral_attachments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE site_images ENABLE ROW LEVEL SECURITY;
  ALTER TABLE opd_schedules ENABLE ROW LEVEL SECURITY;
  ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flag_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flag_divisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flag_ceremonies ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flag_checkins ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flag_checkin_photos ENABLE ROW LEVEL SECURITY;
`;

function wrap(run, execRaw) {
  const api = {
    query: async (sql, params = []) => (await run(sql, params)).rows,
    one: async (sql, params = []) => (await run(sql, params)).rows[0],
    exec: execRaw,
  };
  return api;
}

function pgDriver(url) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX || 3), // keep small: each serverless instance has its own pool
    idleTimeoutMillis: 10_000,
  });
  const db = wrap((sql, p) => pool.query(sql, p), (sql) => pool.query(sql));
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap((sql, p) => client.query(sql, p), (sql) => client.query(sql)));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  return db;
}

function pgliteDriver(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = dataDir === 'memory' ? new PGlite() : new PGlite(dataDir);
  const db = wrap((sql, p) => pg.query(sql, p), (sql) => pg.exec(sql));
  db.tx = (fn) => pg.transaction((t) => fn(wrap((sql, p) => t.query(sql, p), (sql) => t.exec(sql))));
  db.close = () => pg.close();
  return db;
}

async function open({ url = config.databaseUrl, dataDir } = {}) {
  const db = url ? pgDriver(url) : pgliteDriver(dataDir || config.localDataDir || path.join(__dirname, '..', 'data', 'pglite'));

  // Several serverless instances may cold-start at once; serialise schema setup.
  await db.tx(async (t) => {
    await t.query("SELECT pg_advisory_xact_lock(hashtext('hospital-scheduler-schema'))");
    await t.exec(SCHEMA);
    await t.query(
      "INSERT INTO admins (username, password_hash, full_name, role) SELECT $1, $2, 'ADMINISTRATOR', 'ADMIN' WHERE NOT EXISTS (SELECT 1 FROM admins)",
      [config.admin.username.toLowerCase(), hashPassword(config.admin.password)],
    );
    // OPD clinics, starting with this month's schedule taken from the original fixed settings
    if (!(await t.one('SELECT 1 FROM opd_clinics LIMIT 1'))) {
      for (const { clinic: c, schedule: s } of clinics.seedRows(clinics.monthOf(todayStr()))) {
        await t.query('INSERT INTO opd_clinics (code, name, sort_order) VALUES ($1, $2, $3)', [c.code, c.name, c.sort_order]);
        await t.query(
          `INSERT INTO opd_schedules (clinic_code, month, days, start_time, end_time, slot_minutes, per_slot, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'system')`,
          [c.code, s.month, s.days, s.start_time, s.end_time, s.slot_minutes, s.per_slot],
        );
      }
    }
    // Fees per copy: add any document type that has no fee yet (keeps fees staff already changed)
    for (const type of catalog.RECORD_TYPES) {
      await t.query('INSERT INTO document_fees (record_type, fee) VALUES ($1, $2) ON CONFLICT (record_type) DO NOTHING', [type.code, type.fee ?? 0]);
    }
    // Starter directory entries and transaction guides, only when there are none yet
    if (!(await t.one('SELECT 1 FROM directory_entries LIMIT 1'))) {
      for (const e of directory.seedEntries()) {
        await t.query(
          `INSERT INTO directory_entries (name, category, description, hours, services, keywords, opd_code, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [e.name, e.category, e.description || null, e.hours || null, e.services || null, e.keywords || '', e.opd_code || null, e.sort_order],
        );
      }
    }
    if (!(await t.one('SELECT 1 FROM guides LIMIT 1'))) {
      for (const g of directory.seedGuides()) {
        await t.query(
          'INSERT INTO guides (title, summary, steps, requirements, link_url, link_label, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [g.title, g.summary, g.steps, g.requirements, g.link_url || null, g.link_label || null, g.sort_order],
        );
      }
    }
    // Starter FAQs, only when there are none yet (staff edit them in Admin → FAQs)
    if (!(await t.one('SELECT 1 FROM faqs LIMIT 1'))) {
      for (const [i, f] of SEEDS.entries()) {
        await t.query(
          'INSERT INTO faqs (question, answer, keywords, link_url, link_label, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
          [f.question, f.answer, f.keywords, f.link_url || null, f.link_label || null, (i + 1) * 10],
        );
      }
    }
    await runMigrations(t);
  });
  return db;
}

// One-time updates to content that was seeded by an earlier version. Each runs once per database
// and only touches text still matching the old starter wording, so staff edits are kept.
const OLD_OFFICE = 'Medical Records Section';
const MIGRATIONS = [
  {
    id: '2026-10-30-records-office-hhims',
    async run(t) {
      const { RECORDS_OFFICE: name, RECORDS_OFFICE_HOURS: hours } = catalog;
      await t.query(
        `UPDATE directory_entries SET name = $1, hours = $2, keywords = 'hhims, health information, ' || keywords
         WHERE name = $3`,
        [name, hours, OLD_OFFICE],
      );
      await t.query(
        `UPDATE faqs SET answer = $1, keywords = keywords || ', hhims, health information, saturday, holiday'
         WHERE answer = 'Documents can be claimed {office_days}, 8:00 AM – 5:00 PM, except holidays.'`,
        [`${name}:\n${hours.replace('; ', '\n')}`],
      );
      for (const [table, cols] of [['faqs', ['question', 'answer']], ['guides', ['summary', 'steps', 'requirements']], ['directory_entries', ['description']]]) {
        for (const col of cols) await t.query(`UPDATE ${table} SET ${col} = replace(${col}, $1, $2) WHERE ${col} LIKE '%' || $1 || '%'`, [OLD_OFFICE, name]);
      }
    },
  },
  {
    // Flag ceremonies have no "late": everyone who checks in while check-in is open is present
    id: '2026-11-12-flag-no-late',
    async run(t) {
      await t.query("UPDATE flag_checkins SET status = 'ON_TIME' WHERE status = 'LATE'");
    },
  },
  {
    // Division list (editable) with the new names; employees under the old names move to them
    id: '2026-11-13-flag-divisions',
    async run(t) {
      const flag = require('./flag');
      for (const [i, name] of flag.DEFAULT_DIVISIONS.entries()) {
        await t.query('INSERT INTO flag_divisions (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, (i + 1) * 10]);
      }
      for (const [old, name] of Object.entries(flag.OLD_DIVISION_NAMES)) {
        await t.query('UPDATE employees SET department = $1 WHERE department = $2', [name, old]);
      }
    },
  },  {
    // ZRMC campus map (from the Master Development Plan 2025) with its starting wayfinding network
    id: '2026-11-13-campus-wayfinding',
    async run(t) {
      await require('./wayfinding').seedCampus(t);
    },
  },  {
    // Every employee's PIN becomes the default PIN (123456); they set their own after signing in
    id: '2026-11-13-flag-default-pins',
    async run(t) {
      await t.query(
        `UPDATE employees SET pin_hash = $1, pin_must_change = TRUE, failed_pins = 0, locked_until = NULL,
           session_version = session_version + 1, updated_by = 'system', updated_at = now()`,
        [hashPassword(require('./config').flag.defaultPin)],
      );
    },
  },
];

async function runMigrations(t) {
  for (const m of MIGRATIONS) {
    if (await t.one('SELECT 1 FROM schema_migrations WHERE id = $1', [m.id])) continue;
    await m.run(t);
    await t.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
  }
}

// Serialise bookings that compete for the same capacity (date/slot) across instances.
const lock = (t, key) => t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

module.exports = { open, lock, SCHEMA, runMigrations };
