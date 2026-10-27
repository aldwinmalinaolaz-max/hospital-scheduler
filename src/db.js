const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashPassword } = require('./auth');

function open(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS record_requests (
      id INTEGER PRIMARY KEY,
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
      reminded_pickup INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_rr_pickup ON record_requests(pickup_date);

    CREATE TABLE IF NOT EXISTS record_request_items (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES record_requests(id) ON DELETE CASCADE,
      record_type TEXT NOT NULL,
      details TEXT,
      copies INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
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
      reminded_day_before INTEGER NOT NULL DEFAULT 0,
      reminded_hours_before INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_appt_slot ON appointments(department, appt_date, appt_time);

    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY,
      recipient TEXT NOT NULL,
      message TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_no TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS closed_dates (
      date TEXT PRIMARY KEY,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
  `);

  const hasAdmin = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0;
  if (!hasAdmin) {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(
      config.admin.username,
      hashPassword(config.admin.password),
    );
  }
  return db;
}

// Run fn inside a transaction (node:sqlite is synchronous, so this is atomic per process).
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, tx };
