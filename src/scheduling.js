// Availability rules for records pickup dates and OPD slots.
// `db` may be the shared connection or a transaction handle from db.tx().
const config = require('./config');
const catalog = require('./catalog');
const u = require('./util');

const ACTIVE_RECORD = "status NOT IN ('CANCELLED','REJECTED')";
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

// Earliest pickup date = N working days after today (today's requests are processed starting today).
function earliestPickupDateSync(recordCodes, closed, now) {
  const days = Math.max(1, ...recordCodes.map((c) => catalog.recordType(c)?.processingDays || 1));
  let d = u.todayStr(now);
  let counted = 0;
  while (counted < days) {
    d = u.addDays(d, 1);
    if (isOfficeDay(d, config.records.openSaturday, closed)) counted++;
  }
  return d;
}

async function earliestPickupDate(db, recordCodes, now = new Date()) {
  return earliestPickupDateSync(recordCodes, await closedDates(db), now);
}

async function pickupDates(db, recordCodes, now = new Date()) {
  const closed = await closedDates(db);
  const start = earliestPickupDateSync(recordCodes, closed, now);
  const end = u.addDays(u.todayStr(now), config.records.maxDaysAhead);
  const counts = new Map(
    (
      await db.query(
        `SELECT pickup_date, COUNT(*)::int AS n FROM record_requests
         WHERE pickup_date BETWEEN $1 AND $2 AND ${ACTIVE_RECORD} GROUP BY pickup_date`,
        [start, end],
      )
    ).map((r) => [r.pickup_date, r.n]),
  );
  const out = [];
  for (let d = start; d <= end; d = u.addDays(d, 1)) {
    if (!isOfficeDay(d, config.records.openSaturday, closed)) continue;
    out.push({ date: d, remaining: Math.max(0, config.records.dailyPickupCapacity - (counts.get(d) || 0)) });
  }
  return out;
}

async function checkPickupDate(db, recordCodes, dateStr, now = new Date()) {
  const avail = (await pickupDates(db, recordCodes, now)).find((x) => x.date === dateStr);
  if (!avail) return 'Selected pickup date is not available. Please choose another date.';
  if (avail.remaining <= 0) return 'Selected pickup date is fully booked. Please choose another date.';
  return null;
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

module.exports = { earliestPickupDate, pickupDates, checkPickupDate, slotTimes, opdDates, opdSlots, checkOpdSlot };
