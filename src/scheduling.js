// Availability rules for records pickup dates and OPD slots.
// `db` may be the shared connection or a transaction handle from db.tx().
const config = require('./config');
const catalog = require('./catalog');
const u = require('./util');

const ACTIVE_APPT = "status <> 'CANCELLED'";

async function closedDates(db) {
  return new Map((await db.query('SELECT date, reason FROM closed_dates')).map((r) => [r.date, r.reason]));
}

function isOfficeDay(dateStr, openSaturday, closed) {
  const dow = u.dayOfWeek(dateStr);
  if (dow === 0 || (dow === 6 && !openSaturday)) return false;
  return !closed.has(dateStr);
}

// ---------- Records ----------

// Claiming date = RECORDS_CLAIM_DAYS calendar days after the request,
// moved to the next working day if it falls on a weekend or holiday.
async function claimingDate(db, now = new Date()) {
  const closed = await closedDates(db);
  let d = u.addDays(u.todayStr(now), config.records.claimDays);
  while (!isOfficeDay(d, config.records.openSaturday, closed)) d = u.addDays(d, 1);
  return d;
}

// ---------- OPD ----------

function slotTimes() {
  const { startTime, endTime, slotMinutes } = config.opd;
  const out = [];
  for (let m = u.timeToMinutes(startTime); m + slotMinutes <= u.timeToMinutes(endTime); m += slotMinutes) {
    out.push(u.minutesToTime(m));
  }
  return out;
}

function isClinicDay(deptCode, dateStr, closed) {
  const dept = catalog.department(deptCode);
  if (!dept || !u.parseDate(dateStr)) return false;
  if (!dept.days.includes(u.dayOfWeek(dateStr))) return false;
  return isOfficeDay(dateStr, config.opd.openSaturday || dept.days.includes(6), closed);
}

function buildSlots(dateStr, counts, now) {
  return slotTimes()
    .filter((t) => u.localDateTime(dateStr, t) > now) // no past slots
    .map((t) => ({
      time: t,
      label: u.formatTime12(t),
      remaining: Math.max(0, config.opd.patientsPerSlot - (counts.get(`${dateStr} ${t}`) || 0)),
    }));
}

async function slotCounts(db, deptCode, from, to) {
  const rows = await db.query(
    `SELECT appt_date, appt_time, COUNT(*)::int AS n FROM appointments
     WHERE department = $1 AND appt_date BETWEEN $2 AND $3 AND ${ACTIVE_APPT}
     GROUP BY appt_date, appt_time`,
    [deptCode, from, to],
  );
  return new Map(rows.map((r) => [`${r.appt_date} ${r.appt_time}`, r.n]));
}

async function opdDates(db, deptCode, now = new Date()) {
  const closed = await closedDates(db);
  const today = u.todayStr(now);
  const end = u.addDays(today, config.opd.maxDaysAhead);
  const counts = await slotCounts(db, deptCode, today, end);
  const out = [];
  for (let d = today; d <= end; d = u.addDays(d, 1)) {
    if (!isClinicDay(deptCode, d, closed)) continue;
    const slots = buildSlots(d, counts, now);
    if (slots.length) out.push({ date: d, remaining: slots.reduce((s, x) => s + x.remaining, 0) });
  }
  return out;
}

async function opdSlots(db, deptCode, dateStr, now = new Date()) {
  if (!isClinicDay(deptCode, dateStr, await closedDates(db))) return [];
  return buildSlots(dateStr, await slotCounts(db, deptCode, dateStr, dateStr), now);
}

async function checkOpdSlot(db, deptCode, dateStr, timeStr, now = new Date()) {
  if (dateStr > u.addDays(u.todayStr(now), config.opd.maxDaysAhead)) return 'Selected date is too far ahead.';
  const slot = (await opdSlots(db, deptCode, dateStr, now)).find((s) => s.time === timeStr);
  if (!slot) return 'Selected schedule is not available. Please choose another date/time.';
  if (slot.remaining <= 0) return 'Selected time slot is fully booked. Please choose another time.';
  return null;
}

module.exports = { claimingDate, slotTimes, opdDates, opdSlots, checkOpdSlot };
