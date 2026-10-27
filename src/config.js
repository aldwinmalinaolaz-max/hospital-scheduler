const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// All dates/times in the system are hospital-local. Set TZ before any Date is used.
process.env.TZ = process.env.HOSPITAL_TZ || 'Asia/Manila';

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

module.exports = {
  port: int(env.PORT, 3000),
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'hospital.db'),
  hospitalName: env.HOSPITAL_NAME || 'General Hospital',
  sessionSecret: env.SESSION_SECRET || 'change-me-in-production',
  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || 'admin123',
  },

  // Records section office hours / pickup capacity
  records: {
    dailyPickupCapacity: int(env.RECORDS_DAILY_CAPACITY, 60),
    openSaturday: env.RECORDS_OPEN_SATURDAY === 'true',
    maxDaysAhead: int(env.RECORDS_MAX_DAYS_AHEAD, 30),
  },

  // OPD clinic slots
  opd: {
    startTime: env.OPD_START || '08:00',
    endTime: env.OPD_END || '12:00',
    slotMinutes: int(env.OPD_SLOT_MINUTES, 30),
    patientsPerSlot: int(env.OPD_PATIENTS_PER_SLOT, 4),
    openSaturday: env.OPD_OPEN_SATURDAY === 'true',
    maxDaysAhead: int(env.OPD_MAX_DAYS_AHEAD, 30),
  },

  sms: {
    provider: (env.SMS_PROVIDER || 'console').toLowerCase(), // console | semaphore | twilio
    senderName: env.SMS_SENDER_NAME || '',
    semaphoreApiKey: env.SEMAPHORE_API_KEY || '',
    twilioSid: env.TWILIO_ACCOUNT_SID || '',
    twilioToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
    // Reminders: day-before at a fixed local time, plus N hours before the appointment
    dayBeforeTime: env.REMINDER_DAY_BEFORE_TIME || '17:00',
    hoursBefore: int(env.REMINDER_HOURS_BEFORE, 2),
    schedulerIntervalSec: int(env.REMINDER_INTERVAL_SEC, 60),
  },
};
