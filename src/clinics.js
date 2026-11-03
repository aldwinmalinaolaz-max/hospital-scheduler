// OPD clinics and their monthly schedules (managed in Admin → OPD Schedules).
//
// Each clinic has one schedule row per month (opd_schedules). When a month has not been set yet,
// the latest earlier month carries over, so booking keeps working until staff publish the new month.
const config = require('./config');
const catalog = require('./catalog');
const u = require('./util');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthOf = (dateStr) => dateStr.slice(0, 7);
const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function fromRow(row, month) {
  return {
    clinic_code: row.clinic_code,
    month,
    source_month: row.month, // differs from `month` when carried over
    carried_over: row.month !== month,
    days: list(row.days).map(Number),
    start_time: row.start_time,
    end_time: row.end_time,
    slot_minutes: row.slot_minutes,
    per_slot: row.per_slot,
    // Date exceptions belong to the month they were set for; they don't carry over
    closed_dates: row.month === month ? list(row.closed_dates) : [],
    extra_dates: row.month === month ? list(row.extra_dates) : [],
    note: row.month === month ? row.note || '' : '',
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

async function listClinics(db, { activeOnly = true } = {}) {
  return db.query(`SELECT * FROM opd_clinics ${activeOnly ? 'WHERE active' : ''} ORDER BY sort_order, name`);
}

async function getClinic(db, code, { activeOnly = true } = {}) {
  if (!code) return null;
  const c = await db.one('SELECT * FROM opd_clinics WHERE code = $1', [String(code)]);
  return c && (!activeOnly || c.active) ? c : null;
}

async function clinicNames(db) {
  return new Map((await db.query('SELECT code, name FROM opd_clinics')).map((c) => [c.code, c.name]));
}

// Effective schedule of one clinic for a month (or null if the clinic has never been scheduled)
async function scheduleFor(db, code, month) {
  const row = await db.one('SELECT * FROM opd_schedules WHERE clinic_code = $1 AND month <= $2 ORDER BY month DESC LIMIT 1', [code, month]);
  return row ? fromRow(row, month) : null;
}

// Effective schedules of all clinics for a month: Map(code → schedule)
async function schedulesForMonth(db, month) {
  const rows = await db.query(
    `SELECT DISTINCT ON (clinic_code) * FROM opd_schedules WHERE month <= $1 ORDER BY clinic_code, month DESC`,
    [month],
  );
  return new Map(rows.map((r) => [r.clinic_code, fromRow(r, month)]));
}

// Is the clinic open on this date? Extra dates open the clinic even on a holiday;
// otherwise hospital-wide closed dates (Settings) apply.
function isOpen(s, dateStr, closedHolidays) {
  if (!s || !u.parseDate(dateStr)) return false;
  if (s.extra_dates.includes(dateStr)) return true;
  if (s.closed_dates.includes(dateStr) || closedHolidays.has(dateStr)) return false;
  return s.days.includes(u.dayOfWeek(dateStr));
}

function slotTimes(s) {
  const out = [];
  for (let m = u.timeToMinutes(s.start_time); m + s.slot_minutes <= u.timeToMinutes(s.end_time); m += s.slot_minutes) {
    out.push(u.minutesToTime(m));
  }
  return out;
}

function dayRange(days) {
  const d = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
  if (d.join() === '1,2,3,4,5') return 'Monday to Friday';
  if (d.join() === '1,2,3,4,5,6') return 'Monday to Saturday';
  return d.map((x) => DAY_NAMES[x]).join(', ');
}

const hoursText = (s) => `${u.formatTime12(s.start_time)} – ${u.formatTime12(s.end_time)}`;
function describe(s) {
  if (!s || (!s.days.length && !s.extra_dates.length)) return 'No clinic this month';
  return s.days.length ? `${dayRange(s.days)}, ${hoursText(s)}` : `${s.extra_dates.length} scheduled day(s), ${hoursText(s)}`;
}

function cleanSchedule(b) {
  const days = [...new Set((Array.isArray(b.days) ? b.days : list(b.days)).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
  const time = (t, label) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''))) throw new Error(`${label} must be a time like 08:00.`);
    return t;
  };
  const start = time(b.start_time, 'Start time');
  const end = time(b.end_time, 'End time');
  const slot = parseInt(b.slot_minutes, 10);
  const perSlot = parseInt(b.per_slot, 10);
  if (!(slot >= 5 && slot <= 240)) throw new Error('Slot length must be 5 to 240 minutes.');
  if (!(perSlot >= 1 && perSlot <= 200)) throw new Error('Patients per slot must be 1 to 200.');
  if (u.timeToMinutes(end) - u.timeToMinutes(start) < slot) throw new Error('End time must be at least one slot after the start time.');
  const dates = (v, month) =>
    [...new Set(Array.isArray(v) ? v : list(v))].map(String).filter((d) => u.parseDate(d) && monthOf(d) === month).sort();
  return { days, start, end, slot, perSlot, dates, note: String(b.note || '').trim().slice(0, 300) };
}

// Default schedule used when the clinics are first created (from the original fixed settings)
function seedRows(month) {
  return catalog.DEPARTMENTS.map((d, i) => ({
    clinic: { code: d.code, name: d.name, sort_order: (i + 1) * 10 },
    schedule: {
      month,
      days: d.days.join(','),
      start_time: config.opd.startTime,
      end_time: config.opd.endTime,
      slot_minutes: config.opd.slotMinutes,
      per_slot: config.opd.patientsPerSlot,
    },
  }));
}

// Adds department_name (from the clinics table) to an appointment row
async function withClinicName(db, appt) {
  const c = await getClinic(db, appt.department, { activeOnly: false });
  return { ...appt, department_name: c?.name || appt.department };
}

// Values for FAQ answers ({opd_hours}, {clinic_schedule}) from this month's schedules
async function faqValues(db, now = new Date()) {
  const month = monthOf(u.todayStr(now));
  const [all, scheds] = await Promise.all([listClinics(db), schedulesForMonth(db, month)]);
  const hours = new Set(all.map((c) => scheds.get(c.code)).filter(Boolean).map(hoursText));
  return {
    opd_hours: hours.size === 1 ? [...hours][0] : 'the hours shown for each clinic',
    clinic_schedule: all
      .map((c) => {
        const s = scheds.get(c.code);
        return `• ${c.name}: ${describe(s)}${s?.note ? ` (${s.note})` : ''}`;
      })
      .join('\n'),
  };
}

module.exports = {
  withClinicName,
  faqValues,
  monthOf,
  validMonth,
  listClinics,
  getClinic,
  clinicNames,
  scheduleFor,
  schedulesForMonth,
  isOpen,
  slotTimes,
  describe,
  dayRange,
  hoursText,
  cleanSchedule,
  seedRows,
};
