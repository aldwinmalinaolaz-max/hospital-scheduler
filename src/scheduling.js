// Availability rules for records pickup dates and OPD slots.
const config = require('./config');
const catalog = require('./catalog');
const u = require('./util');

const ACTIVE_RECORD = "status NOT IN ('CANCELLED','REJECTED')";
const ACTIVE_APPT = "status NOT IN ('CANCELLED')";

function closedDates(db) {
  return new Map(db.prepare('SELECT date, reason FROM closed_dates').all().map((r) => [r.date, r.reason]));
}

function isOfficeDay(dateStr, openSaturday, closed) {
  const dow = u.dayOfWeek(dateStr);
  if (dow === 0 || (dow === 6 && !openSaturday)) return false;
  return !closed.has(dateStr);
}

// ---------- Records ----------

// Earliest pickup date = N working days after today (today's requests are processed starting today).
function earliestPickupDate(db, recordCodes, now = new Date()) {
  const days = Math.max(1, ...recordCodes.map((c) => catalog.recordType(c)?.processingDays || 1));
  const closed = closedDates(db);
  let d = u.todayStr(now);
  let counted = 0;
  while (counted < days) {
    d = u.addDays(d, 1);
    if (isOfficeDay(d, config.records.openSaturday, closed)) counted++;
  }
  return d;
}

function pickupCount(db, dateStr) {
  return db.prepare(`SELECT COUNT(*) AS n FROM record_requests WHERE pickup_date = ? AND ${ACTIVE_RECORD}`).get(dateStr).n;
}

function pickupDates(db, recordCodes, now = new Date()) {
  const closed = closedDates(db);
  const start = earliestPickupDate(db, recordCodes, now);
  const end = u.addDays(u.todayStr(now), config.records.maxDaysAhead);
  const out = [];
  for (let d = start; d <= end; d = u.addDays(d, 1)) {
    if (!isOfficeDay(d, config.records.openSaturday, closed)) continue;
    const remaining = config.records.dailyPickupCapacity - pickupCount(db, d);
    out.push({ date: d, remaining: Math.max(0, remaining) });
  }
  return out;
}

function checkPickupDate(db, recordCodes, dateStr, now = new Date()) {
  const avail = pickupDates(db, recordCodes, now).find((x) => x.date === dateStr);
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
  if (!dept) return false;
  if (!dept.days.includes(u.dayOfWeek(dateStr))) return false;
  return isOfficeDay(dateStr, config.opd.openSaturday || dept.days.includes(6), closed);
}

function opdDates(db, deptCode, now = new Date()) {
  const closed = closedDates(db);
  const today = u.todayStr(now);
  const end = u.addDays(today, config.opd.maxDaysAhead);
  const out = [];
  for (let d = today; d <= end; d = u.addDays(d, 1)) {
    if (!isClinicDay(deptCode, d, closed)) continue;
    const slots = opdSlots(db, deptCode, d, now);
    const remaining = slots.reduce((s, x) => s + x.remaining, 0);
    if (slots.length) out.push({ date: d, remaining });
  }
  return out;
}

function opdSlots(db, deptCode, dateStr, now = new Date()) {
  if (!u.parseDate(dateStr) || !isClinicDay(deptCode, dateStr, closedDates(db))) return [];
  const counts = new Map(
    db
      .prepare(`SELECT appt_time, COUNT(*) AS n FROM appointments WHERE department = ? AND appt_date = ? AND ${ACTIVE_APPT} GROUP BY appt_time`)
      .all(deptCode, dateStr)
      .map((r) => [r.appt_time, r.n]),
  );
  return slotTimes()
    .filter((t) => u.localDateTime(dateStr, t) > now) // no past slots
    .map((t) => ({
      time: t,
      label: u.formatTime12(t),
      remaining: Math.max(0, config.opd.patientsPerSlot - (counts.get(t) || 0)),
    }));
}

function checkOpdSlot(db, deptCode, dateStr, timeStr, now = new Date()) {
  const today = u.todayStr(now);
  if (dateStr > u.addDays(today, config.opd.maxDaysAhead)) return 'Selected date is too far ahead.';
  const slot = opdSlots(db, deptCode, dateStr, now).find((s) => s.time === timeStr);
  if (!slot) return 'Selected schedule is not available. Please choose another date/time.';
  if (slot.remaining <= 0) return 'Selected time slot is fully booked. Please choose another time.';
  return null;
}

module.exports = { earliestPickupDate, pickupDates, checkPickupDate, slotTimes, opdDates, opdSlots, checkOpdSlot };
