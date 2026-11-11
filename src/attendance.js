// Attendance Monitoring: hospital employees time in and out at registered kiosk devices.
// Times always come from the server clock. Records are turned into daily time records (DTR,
// CSC Form No. 48) by pairing each time-in with the next time-out, so night shifts that end
// the next morning count for the day they started.
const crypto = require('node:crypto');
const config = require('./config');
const { imageType } = require('./directory');
const u = require('./util');

const KIOSK_COOKIE = 'hs_kiosk';
const MAX_SHIFT_HOURS = 20; // a time-out more than this long after the time-in is not paired with it
const DUPLICATE_MINUTES = 5; // the same punch again within this window is treated as a double tap
const MAX_PHOTO_BYTES = 400 * 1024;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const clean = (v, max = 120) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, max);

// Validates employee fields from the staff panel or a CSV row; returns [values, error]
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
  if (has('department')) out.department = clean(b.department, 80) || null;
  if (has('shift_start') || has('shift_end') || has('shifting')) {
    const shifting = b.shifting === true || b.shifting === 'on' || b.shifting === '1';
    if (shifting) {
      out.shift_start = null;
      out.shift_end = null;
    } else {
      out.shift_start = String(b.shift_start || config.attendance.shiftStart);
      out.shift_end = String(b.shift_end || config.attendance.shiftEnd);
      if (!TIME_RE.test(out.shift_start) || !TIME_RE.test(out.shift_end)) return [null, 'Official hours must be times like 08:00 and 17:00.'];
      if (out.shift_start === out.shift_end) return [null, 'Official hours must start and end at different times.'];
    }
  }
  return [out, null];
}

function checkPin(pin) {
  return /^\d{4,6}$/.test(String(pin || '')) ? null : 'The PIN must be 4 to 6 digits.';
}
const randomPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

const fullName = (e) => `${e.last_name}, ${e.first_name}${e.middle_name ? ` ${e.middle_name[0]}.` : ''}`;

function decodePhoto(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  const mime = imageType(buf);
  if (!mime || buf.length > MAX_PHOTO_BYTES) return null;
  return { buf, mime };
}

// ---------- Time helpers (hospital local time; process TZ is set in config.js) ----------

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const minutesBetween = (a, b) => Math.round((b - a) / 60000);

// The official start and end of an employee's shift on a given day (end may be the next day)
function shiftOn(emp, dateStr) {
  if (!emp.shift_start || !emp.shift_end) return null;
  const start = u.localDateTime(dateStr, emp.shift_start);
  const endDate = emp.shift_end > emp.shift_start ? dateStr : u.addDays(dateStr, 1);
  return { start, end: u.localDateTime(endDate, emp.shift_end) };
}

// Pairs time-ins with time-outs. Logs must be one employee's, oldest first, without voided entries.
function pairSessions(logs) {
  const sessions = [];
  let open = null;
  for (const log of logs) {
    const t = new Date(log.logged_at);
    if (log.kind === 'IN') {
      if (open) sessions.push({ in: open, out: null });
      open = { ...log, t };
    } else if (open && t - open.t <= MAX_SHIFT_HOURS * 3600e3) {
      sessions.push({ in: open, out: { ...log, t } });
      open = null;
    } else {
      if (open) sessions.push({ in: open, out: null });
      open = null;
      sessions.push({ in: null, out: { ...log, t } });
    }
  }
  if (open) sessions.push({ in: open, out: null });
  for (const s of sessions) s.date = u.toDateStr((s.in || s.out).t);
  return sessions;
}

// One DTR line: AM/PM arrival and departure, tardiness and undertime, hours worked
function dtrDay(emp, dateStr, sessions) {
  const day = { date: dateStr, am_in: '', am_out: '', pm_in: '', pm_out: '', late: 0, undertime: 0, worked: 0, remarks: [] };
  if (!sessions.length) return day;
  const fmt = (x) => (x ? `${hhmm(x.t)}${u.toDateStr(x.t) !== dateStr ? '+1' : ''}` : '');
  if (sessions.length === 1) {
    const [s] = sessions;
    if (s.in) day[s.in.t.getHours() < 12 ? 'am_in' : 'pm_in'] = fmt(s.in);
    if (s.out) day[s.out.t.getHours() < 12 && u.toDateStr(s.out.t) === dateStr && (!s.in || s.in.t.getHours() < 12) ? 'am_out' : 'pm_out'] = fmt(s.out);
  } else {
    const first = sessions[0];
    const last = sessions[sessions.length - 1];
    day.am_in = fmt(first.in);
    day.am_out = fmt(first.out);
    day.pm_in = fmt(last.in);
    day.pm_out = fmt(last.out);
    if (sessions.length > 2) day.remarks.push(`${sessions.length} time-ins`);
  }
  for (const s of sessions) {
    if (s.in && s.out) day.worked += minutesBetween(s.in.t, s.out.t);
    // A time-in without a time-out is only missing once the shift can no longer be running
    if (!s.out) day.remarks.push(Date.now() - s.in.t < MAX_SHIFT_HOURS * 3600e3 ? 'On duty' : 'No time-out');
    if (!s.in) day.remarks.push('No time-in');
    if (s.in?.source === 'MANUAL' || s.out?.source === 'MANUAL') day.manual = true;
  }
  const shift = shiftOn(emp, dateStr);
  const firstIn = sessions.find((s) => s.in)?.in;
  const lastOut = [...sessions].reverse().find((s) => s.out)?.out;
  if (shift && firstIn) {
    const late = minutesBetween(shift.start, firstIn.t);
    // Ignore time-ins far from the official start (e.g. an extra duty shift)
    if (late > config.attendance.graceMinutes && late < 8 * 60) day.late = late;
  }
  if (shift && lastOut && firstIn) {
    const early = minutesBetween(lastOut.t, shift.end);
    if (early > 0 && early < 12 * 60) day.undertime = early;
  }
  if (day.manual) day.remarks.push('Manual entry');
  return day;
}

// Builds a month of DTR lines for one employee from their logs (which may extend past the month)
function dtrMonth(emp, month, logs) {
  const sessions = pairSessions(logs);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = [];
  const totals = { days_present: 0, late_count: 0, late: 0, undertime: 0, worked: 0, missing: 0 };
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const day = dtrDay(emp, date, sessions.filter((s) => s.date === date));
    const dow = new Date(y, m - 1, d).getDay();
    if (!day.am_in && !day.pm_in && !day.am_out && !day.pm_out && (dow === 0 || dow === 6)) day.remarks.push(dow === 0 ? 'SUNDAY' : 'SATURDAY');
    day.remarks = day.remarks.join('; ');
    if (sessions.some((s) => s.date === date && s.in)) totals.days_present++;
    if (day.late) totals.late_count++;
    totals.late += day.late;
    totals.undertime += day.undertime;
    totals.worked += day.worked;
    totals.missing += (day.remarks.match(/No time-(in|out)/g) || []).length;
    days.push(day);
  }
  return { days, totals };
}

// Fetches the logs needed for a month (with a day either side for night shifts)
async function logsForMonth(db, employeeIds, month) {
  const from = u.localDateTime(`${month}-01`, '00:00');
  from.setDate(from.getDate() - 1);
  const [y, m] = month.split('-').map(Number);
  const to = new Date(y, m, 2); // 2nd day of the next month
  const rows = await db.query(
    `SELECT id, employee_id, kind, logged_at, source FROM attendance_logs
     WHERE employee_id = ANY($1::int[]) AND voided_at IS NULL AND logged_at >= $2 AND logged_at < $3
     ORDER BY logged_at`,
    [employeeIds, from.toISOString(), to.toISOString()],
  );
  const byEmp = new Map(employeeIds.map((id) => [id, []]));
  for (const r of rows) byEmp.get(r.employee_id).push(r);
  return byEmp;
}

const fmtMinutes = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '0');

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`; // never let a cell run as a spreadsheet formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

// Parses a pasted employee list: header row optional; columns as in IMPORT_COLUMNS
const IMPORT_COLUMNS = ['employee_no', 'last_name', 'first_name', 'middle_name', 'position', 'department'];
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');
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

async function purgeAttendancePhotos(db, now = new Date()) {
  const rows = await db.query(
    "DELETE FROM attendance_photos WHERE created_at < $1::timestamptz - ($2 || ' days')::interval RETURNING log_id",
    [now.toISOString(), String(config.attendance.photoRetentionDays)],
  );
  return rows.length;
}

module.exports = {
  KIOSK_COOKIE,
  MAX_SHIFT_HOURS,
  DUPLICATE_MINUTES,
  IMPORT_COLUMNS,
  hashToken,
  newToken,
  cleanEmployee,
  checkPin,
  randomPin,
  fullName,
  decodePhoto,
  hhmm,
  shiftOn,
  pairSessions,
  dtrDay,
  dtrMonth,
  logsForMonth,
  fmtMinutes,
  toCsv,
  parseCsv,
  purgeAttendancePhotos,
};
