// Postgres access. Uses Supabase (or any Postgres) when DATABASE_URL is set;
// otherwise an embedded Postgres (PGlite) for local development and tests.
//
// Every driver is wrapped to the same small API:
//   db.query(sql, params) -> rows      db.one(sql, params) -> first row | undefined
//   db.exec(sql)                       db.tx(async (t) => …) -> runs fn in a transaction
const path = require('node:path');
const config = require('./config');
const { hashPassword } = require('./auth');

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

  -- Which staff member last changed a request
  ALTER TABLE record_requests ADD COLUMN IF NOT EXISTS updated_by TEXT;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_by TEXT;

  -- Supabase exposes the public schema through its REST API. Enabling RLS with no
  -- policies blocks that access; this server connects as the table owner and is unaffected.
  ALTER TABLE record_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE record_request_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sms_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE closed_dates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
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
  });
  return db;
}

// Serialise bookings that compete for the same capacity (date/slot) across instances.
const lock = (t, key) => t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

module.exports = { open, lock, SCHEMA };
