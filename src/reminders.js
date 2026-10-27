// Background job that sends SMS reminders:
//   - OPD: the day before (at REMINDER_DAY_BEFORE_TIME) and REMINDER_HOURS_BEFORE hours before
//   - Records: morning of the pickup date, if the request is READY
const config = require('./config');
const msg = require('./messages');
const { sendSms } = require('./sms');
const u = require('./util');

const PICKUP_REMINDER_TIME = '07:00';

async function runReminders(db, now = new Date()) {
  const today = u.todayStr(now);
  const tomorrow = u.addDays(today, 1);
  let sent = 0;

  const appts = db
    .prepare(
      `SELECT * FROM appointments WHERE status = 'BOOKED' AND appt_date IN (?, ?)
       AND (reminded_day_before = 0 OR reminded_hours_before = 0)`,
    )
    .all(today, tomorrow);

  for (const a of appts) {
    const apptAt = u.localDateTime(a.appt_date, a.appt_time);
    if (apptAt <= now) continue;
    const createdAt = new Date(a.created_at.replace(' ', 'T'));

    if (!a.reminded_day_before) {
      const trigger = u.localDateTime(u.addDays(a.appt_date, -1), config.sms.dayBeforeTime);
      if (now >= trigger) {
        // Booked after the reminder time → the booking confirmation already covers it.
        if (createdAt < trigger) {
          await sendSms(db, { to: a.mobile, message: msg.apptDayBefore(a), kind: 'APPT_DAY_BEFORE', refNo: a.ref_no });
          sent++;
        }
        db.prepare('UPDATE appointments SET reminded_day_before = 1 WHERE id = ?').run(a.id);
      }
    }

    if (!a.reminded_hours_before && config.sms.hoursBefore > 0) {
      const trigger = new Date(apptAt.getTime() - config.sms.hoursBefore * 3600e3);
      if (now >= trigger) {
        if (createdAt < trigger) {
          await sendSms(db, { to: a.mobile, message: msg.apptHoursBefore(a), kind: 'APPT_HOURS_BEFORE', refNo: a.ref_no });
          sent++;
        }
        db.prepare('UPDATE appointments SET reminded_hours_before = 1 WHERE id = ?').run(a.id);
      }
    }
  }

  if (now >= u.localDateTime(today, PICKUP_REMINDER_TIME)) {
    const ready = db
      .prepare(`SELECT * FROM record_requests WHERE status = 'READY' AND pickup_date = ? AND reminded_pickup = 0`)
      .all(today);
    for (const r of ready) {
      await sendSms(db, { to: r.mobile, message: msg.recordPickupToday(r), kind: 'RECORD_PICKUP_TODAY', refNo: r.ref_no });
      db.prepare('UPDATE record_requests SET reminded_pickup = 1 WHERE id = ?').run(r.id);
      sent++;
    }
  }

  return sent;
}

function startReminderScheduler(db) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminders(db);
    } catch (err) {
      console.error('Reminder job failed:', err);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, config.sms.schedulerIntervalSec * 1000);
}

module.exports = { runReminders, startReminderScheduler };
