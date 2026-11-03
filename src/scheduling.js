// Availability rules for records pickup dates and OPD slots.
// `db` may be the shared connection or a transaction handle from db.tx().
const config = require('./config');
const clinics = require('./clinics');
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
// Days, hours, slot length and capacity come from each clinic's monthly schedule (src/clinics.js).

function buildSlots(dateStr, sched, counts, now) {
  return clinics
    .slotTimes(sched)
    .filter((t) => u.localDateTime(dateStr, t) > now) // no past slots
    .map((t) => ({
      time: t,
      label: u.formatTime12(t),
      remaining: Math.max(0, sched.per_slot - (counts.get(`${dateStr} ${t}`) || 0)),
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

// Effective schedule per month for the months a date range touches
async function monthSchedules(db, deptCode, from, to) {
  const out = new Map();
  for (let m = clinics.monthOf(from); m <= clinics.monthOf(to); m = clinics.monthOf(u.addDays(`${m}-28`, 7))) {
    out.set(m, await clinics.scheduleFor(db, deptCode, m));
  }
  return out;
}

async function opdDates(db, deptCode, now = new Date()) {
  if (!(await clinics.getClinic(db, deptCode))) return [];
  const closed = await closedDates(db);
  const today = u.todayStr(now);
  const end = u.addDays(today, config.opd.maxDaysAhead);
  const scheds = await monthSchedules(db, deptCode, today, end);
  const counts = await slotCounts(db, deptCode, today, end);
  const out = [];
  for (let d = today; d <= end; d = u.addDays(d, 1)) {
    const sched = scheds.get(clinics.monthOf(d));
    if (!clinics.isOpen(sched, d, closed)) continue;
    const slots = buildSlots(d, sched, counts, now);
    if (slots.length) out.push({ date: d, remaining: slots.reduce((sum, x) => sum + x.remaining, 0) });
  }
  return out;
}

async function opdSlots(db, deptCode, dateStr, now = new Date()) {
  if (!u.parseDate(dateStr) || !(await clinics.getClinic(db, deptCode))) return [];
  const sched = await clinics.scheduleFor(db, deptCode, clinics.monthOf(dateStr));
  if (!clinics.isOpen(sched, dateStr, await closedDates(db))) return [];
  return buildSlots(dateStr, sched, await slotCounts(db, deptCode, dateStr, dateStr), now);
}

async function checkOpdSlot(db, deptCode, dateStr, timeStr, now = new Date()) {
  if (dateStr > u.addDays(u.todayStr(now), config.opd.maxDaysAhead)) return 'Selected date is too far ahead.';
  const slot = (await opdSlots(db, deptCode, dateStr, now)).find((s) => s.time === timeStr);
  if (!slot) return 'Selected schedule is not available. Please choose another date/time.';
  if (slot.remaining <= 0) return 'Selected time slot is fully booked. Please choose another time.';
  return null;
}

module.exports = { claimingDate, opdDates, opdSlots, checkOpdSlot };
