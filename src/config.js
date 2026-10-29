const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
try {
  process.loadEnvFile(envFile);
} catch {
  // no .env file (e.g. on Vercel, where settings come from the dashboard)
}

// All dates/times in the system are hospital-local. Set TZ before any Date is used.
process.env.TZ = process.env.HOSPITAL_TZ || 'Asia/Manila';

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

module.exports = {
  port: int(env.PORT, 3000),
  // Supabase/Postgres connection string. Leave empty to use a local embedded database.
  databaseUrl: env.DATABASE_URL || '',
  localDataDir: env.LOCAL_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite'),
  // Shared secret for the /api/cron/reminders endpoint (sent as "Authorization: Bearer …" or ?key=)
  cronSecret: env.CRON_SECRET || '',
  hospitalName: env.HOSPITAL_NAME || 'Zamboanga Regional Medical Center',
  sessionSecret: env.SESSION_SECRET || 'change-me-in-production',
  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || 'admin123',
  },

  // Records section office hours / pickup capacity
  records: {
    // Documents may be claimed this many calendar days after the request,
    // moved to the next working day if that falls on a weekend or holiday.
    claimDays: int(env.RECORDS_CLAIM_DAYS, 3),
    openSaturday: env.RECORDS_OPEN_SATURDAY === 'true',
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
    provider: (env.SMS_PROVIDER || 'console').toLowerCase(), // console | unisms | semaphore | twilio
    // Registered sender ID / sender name (optional; the gateway's default is used when empty)
    senderName: env.SMS_SENDER_NAME || '',
    unismsApiKey: env.UNISMS_API_KEY || '',
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
