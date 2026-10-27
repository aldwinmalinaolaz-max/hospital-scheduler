// SMS reminder job:
//   - OPD: the day before (at REMINDER_DAY_BEFORE_TIME) and REMINDER_HOURS_BEFORE hours before
//   - Records: morning of the pickup date, if the request is READY
// On a normal server it runs on an interval. On Vercel, an external scheduler calls
// GET /api/cron/reminders every few minutes instead.
const config = require('./config');
const msg = require('./messages');
const { sendSms } = require('./sms');
const u = require('./util');

const PICKUP_REMINDER_TIME = '07:00';

// Atomically claims a reminder flag so two overlapping runs never send the same SMS twice.
async function claim(db, table, flag, id) {
  return !!(await db.one(`UPDATE ${table} SET ${flag} = TRUE WHERE id = $1 AND ${flag} = FALSE RETURNING id`, [id]));
}

async function runReminders(db, now = new Date()) {
  const today = u.todayStr(now);
  const tomorrow = u.addDays(today, 1);
  let sent = 0;

  const appts = await db.query(
    `SELECT * FROM appointments WHERE status = 'BOOKED' AND appt_date IN ($1, $2)
     AND (reminded_day_before = FALSE OR reminded_hours_before = FALSE)`,
    [today, tomorrow],
  );

  for (const a of appts) {
    const apptAt = u.localDateTime(a.appt_date, a.appt_time);
    if (apptAt <= now) continue;
    const createdAt = new Date(a.created_at);

    if (!a.reminded_day_before) {
      const trigger = u.localDateTime(u.addDays(a.appt_date, -1), config.sms.dayBeforeTime);
      // Booked after the reminder time → the booking confirmation already covers it.
      if (now >= trigger && (await claim(db, 'appointments', 'reminded_day_before', a.id)) && createdAt < trigger) {
        await sendSms(db, { to: a.mobile, message: msg.apptDayBefore(a), kind: 'APPT_DAY_BEFORE', refNo: a.ref_no });
        sent++;
      }
    }

    if (!a.reminded_hours_before && config.sms.hoursBefore > 0) {
      const trigger = new Date(apptAt.getTime() - config.sms.hoursBefore * 3600e3);
      if (now >= trigger && (await claim(db, 'appointments', 'reminded_hours_before', a.id)) && createdAt < trigger) {
        await sendSms(db, { to: a.mobile, message: msg.apptHoursBefore(a), kind: 'APPT_HOURS_BEFORE', refNo: a.ref_no });
        sent++;
      }
    }
  }

  if (now >= u.localDateTime(today, PICKUP_REMINDER_TIME)) {
    const ready = await db.query(
      "SELECT * FROM record_requests WHERE status = 'READY' AND pickup_date = $1 AND reminded_pickup = FALSE",
      [today],
    );
    for (const r of ready) {
      if (!(await claim(db, 'record_requests', 'reminded_pickup', r.id))) continue;
      await sendSms(db, { to: r.mobile, message: msg.recordPickupToday(r), kind: 'RECORD_PICKUP_TODAY', refNo: r.ref_no });
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
