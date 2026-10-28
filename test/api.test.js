const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SMS_PROVIDER = 'console';
process.env.OPD_PATIENTS_PER_SLOT = '2';
process.env.DATABASE_URL = '';
process.env.CRON_SECRET = 'test-cron-secret';
const { open } = require('../src/db');
const { createApp } = require('../src/server');
const { runReminders } = require('../src/reminders');
const sched = require('../src/scheduling');
const u = require('../src/util');

let db;
let server;
let base;
const realLog = console.log;

before(async () => {
  console.log = () => {}; // silence console SMS provider
  // Set TEST_DATABASE_URL to run against a real (throwaway!) Postgres; it is wiped first.
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
  }
  db = await open(url ? { url } : { url: '', dataDir: 'memory' });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  server.close();
  await db.close();
  console.log = realLog;
});

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

const patient = {
  patient_last: 'Dela Cruz',
  patient_first: 'Juan',
  birthdate: '1990-05-14',
  mobile: '0917 123 4567',
  consent: true,
};

async function firstOpdSlot(dept = 'IM') {
  const { data } = await call(`/opd/dates?department=${dept}`);
  // pick a future date so all slots exist regardless of the current time
  const date = data.dates.find((d) => d.date > u.todayStr()).date;
  const { data: s } = await call(`/opd/slots?department=${dept}&date=${date}`);
  return { date, time: s.slots[0].time };
}

let adminCookie;
async function login() {
  if (adminCookie) return adminCookie;
  const res = await call('/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(res.status, 200);
  adminCookie = res.headers.get('set-cookie').split(';')[0];
  return adminCookie;
}

test('catalog lists all 8 record types', async () => {
  const { data } = await call('/catalog');
  assert.equal(data.recordTypes.length, 8);
  assert.ok(data.recordTypes.some((t) => t.code === 'MEDICO_LEGAL'));
  assert.ok(data.departments.length > 0);
});

test('claiming date is 3 days after request, moved to the next working day', async () => {
  const now = new Date(2026, 9, 30, 10); // Fri 30 Oct 2026
  assert.equal(await sched.claimingDate(db, now), '2026-11-02'); // Fri + 3 = Mon
  assert.equal(await sched.claimingDate(db, new Date(2026, 9, 26, 10)), '2026-10-29'); // Mon + 3 = Thu
  assert.equal(await sched.claimingDate(db, new Date(2026, 9, 28, 10)), '2026-11-02'); // Wed + 3 = Sat → Mon
  assert.equal(await sched.claimingDate(db, new Date(2026, 9, 29, 10)), '2026-11-02'); // Thu + 3 = Sun → Mon
  await db.query("INSERT INTO closed_dates VALUES ('2026-11-02', 'Test holiday')");
  assert.equal(await sched.claimingDate(db, now), '2026-11-03'); // Mon is a holiday → Tue
  await db.query("DELETE FROM closed_dates WHERE date = '2026-11-02'");
});

test('records request: validation, creation, SMS, tracking', async () => {
  const { data: claim } = await call('/records/claim-date');
  const body = {
    ...patient,
    requester_name: 'Juan Dela Cruz',
    requester_relation: 'Self (patient)',
    purpose: 'PhilHealth claim',
    pickup_date: '2020-01-01', // ignored: the server sets the claiming date
    items: [
      { record_type: 'CLINICAL_ABSTRACT', copies: 2 },
      { record_type: 'OTHERS', details: 'Operating room record' },
    ],
  };

  let res = await call('/records', { method: 'POST', body: { ...body, consent: false } });
  assert.equal(res.status, 400);
  res = await call('/records', { method: 'POST', body: { ...body, items: [{ record_type: 'OTHERS' }] } });
  assert.match(res.data.error, /specify/);

  res = await call('/records', { method: 'POST', body });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.ref_no, /^R-\d{6}-[A-Z0-9]{5}$/);
  assert.equal(res.data.items.length, 2);
  assert.equal(res.data.pickup_date, claim.date);
  const ref = res.data.ref_no;

  const sms = await db.query('SELECT * FROM sms_log WHERE ref_no = $1', [ref]);
  assert.equal(sms.length, 1);
  assert.equal(sms[0].recipient, '+639171234567');

  res = await call('/track', { method: 'POST', body: { ref_no: ref.toLowerCase(), mobile: '09171234567' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'PENDING');
  res = await call('/track', { method: 'POST', body: { ref_no: ref, mobile: '09999999999' } });
  assert.equal(res.status, 404);

  // Staff marks it READY → SMS sent; requester can no longer cancel
  const cookie = await login();
  const { id } = await db.one('SELECT id FROM record_requests WHERE ref_no = $1', [ref]);
  res = await call(`/admin/records/${id}`, { method: 'PATCH', cookie, body: { status: 'READY' } });
  assert.equal(res.status, 200);
  assert.ok(await db.one("SELECT 1 FROM sms_log WHERE ref_no = $1 AND kind = 'RECORD_READY'", [ref]));
  res = await call('/track/cancel', { method: 'POST', body: { ref_no: ref, mobile: '09171234567' } });
  assert.equal(res.status, 400);

  res = await call(`/admin/records/${id}`, { method: 'PATCH', cookie, body: { status: 'REJECTED' } });
  assert.match(res.data.error, /reason/);
});

test('OPD booking: capacity, duplicates, cancel frees slot', async () => {
  const { date, time } = await firstOpdSlot('IM');
  const book = (extra) =>
    call('/appointments', {
      method: 'POST',
      body: { ...patient, department: 'IM', appt_date: date, appt_time: time, patient_type: 'NEW', sex: 'M', complaint: 'Cough', ...extra },
    });

  const a1 = await book();
  assert.equal(a1.status, 201, JSON.stringify(a1.data));
  assert.match(a1.data.ref_no, /^A-/);
  assert.ok(await db.one("SELECT 1 FROM sms_log WHERE ref_no = $1 AND kind = 'APPT_BOOKED'", [a1.data.ref_no]));

  const dup = await book();
  assert.match(dup.data.error, /already has an appointment/);

  const a2 = await book({ patient_first: 'Maria', mobile: '09181112222' });
  assert.equal(a2.status, 201);
  const full = await book({ patient_first: 'Pedro', mobile: '09181113333' });
  assert.match(full.data.error, /fully booked/);

  const cancel = await call('/track/cancel', { method: 'POST', body: { ref_no: a2.data.ref_no, mobile: '09181112222' } });
  assert.equal(cancel.data.status, 'CANCELLED');
  const again = await book({ patient_first: 'Pedro', mobile: '09181113333' });
  assert.equal(again.status, 201);

  const closedDay = await call('/appointments', {
    method: 'POST',
    body: { ...patient, department: 'SURG', appt_date: '2026-11-03', appt_time: '08:00', patient_type: 'NEW', sex: 'M', complaint: 'x' }, // Tuesday; Surgery is M/W/F
  });
  assert.equal(closedDay.status, 400);
});

test('admin endpoints require login', async () => {
  assert.equal((await call('/admin/stats')).status, 401);
  assert.equal((await call('/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })).status, 401);
  const res = await call('/admin/stats', { cookie: await login() });
  assert.equal(res.status, 200);
  assert.ok(res.data.upcomingAppointments >= 1);
});

const insertAppt = (ref, date, time, createdAt, mobile) =>
  db.query(
    `INSERT INTO appointments (ref_no, department, appt_date, appt_time, patient_type, patient_last, patient_first, birthdate, sex, mobile, complaint, created_at)
     VALUES ($1, 'IM', $2, $3, 'OLD', 'Santos', 'Ana', '1980-01-01', 'F', $4, 'Follow-up', $5)`,
    [ref, date, time, mobile, createdAt],
  );
const smsKinds = async (ref) => (await db.query('SELECT kind FROM sms_log WHERE ref_no = $1 ORDER BY id', [ref])).map((r) => r.kind);

test('reminders: day-before and hours-before sent once each', async () => {
  await insertAppt('A-TEST-REM01', '2026-12-10', '09:00', new Date(2026, 11, 1, 10), '+639170000001');
  const kinds = () => smsKinds('A-TEST-REM01');

  await runReminders(db, new Date(2026, 11, 9, 16, 59)); // before 5 PM day-before
  assert.deepEqual(await kinds(), []);
  await runReminders(db, new Date(2026, 11, 9, 17, 0));
  assert.deepEqual(await kinds(), ['APPT_DAY_BEFORE']);
  await runReminders(db, new Date(2026, 11, 9, 18, 0));
  assert.deepEqual(await kinds(), ['APPT_DAY_BEFORE']);
  // Two overlapping runs (e.g. two cron calls) must not double-send
  await Promise.all([runReminders(db, new Date(2026, 11, 10, 7, 0)), runReminders(db, new Date(2026, 11, 10, 7, 0))]);
  assert.deepEqual(await kinds(), ['APPT_DAY_BEFORE', 'APPT_HOURS_BEFORE']);
  await runReminders(db, new Date(2026, 11, 10, 8, 0));
  assert.equal((await kinds()).length, 2);
});

test('reminders: same-day booking skips redundant reminders; records pickup reminder', async () => {
  await insertAppt('A-TEST-LATE1', '2026-12-11', '11:00', new Date(2026, 11, 11, 9, 30), '+639170000002');
  await runReminders(db, new Date(2026, 11, 11, 9, 31));
  assert.deepEqual(await smsKinds('A-TEST-LATE1'), []);

  await db.query(
    `INSERT INTO record_requests (ref_no, patient_last, patient_first, birthdate, requester_name, requester_relation, mobile, purpose, pickup_date, status)
     VALUES ('R-TEST-PICK1', 'Cruz', 'Lea', '1970-01-01', 'Lea Cruz', 'Self (patient)', '+639170000003', 'Personal', '2026-12-14', 'READY')`,
  );
  await runReminders(db, new Date(2026, 11, 14, 6, 59));
  await runReminders(db, new Date(2026, 11, 14, 7, 0));
  await runReminders(db, new Date(2026, 11, 14, 9, 0));
  assert.deepEqual(await smsKinds('R-TEST-PICK1'), ['RECORD_PICKUP_TODAY']);
});

test('cron endpoint requires the secret', async () => {
  assert.equal((await call('/cron/reminders')).status, 401);
  assert.equal((await call('/cron/reminders?key=wrong')).status, 401);
  const res = await fetch(`${base}/cron/reminders`, { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('concurrent bookings cannot overfill a slot', async () => {
  const { date, time } = await firstOpdSlot('FAMMED');
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      call('/appointments', {
        method: 'POST',
        body: { ...patient, patient_first: `P${n}`, mobile: `0917000000${n}`, department: 'FAMMED', appt_date: date, appt_time: time, patient_type: 'NEW', sex: 'F', complaint: 'x' },
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 2); // OPD_PATIENTS_PER_SLOT = 2
});

test('mobile normalisation', () => {
  assert.equal(u.normalizeMobile('0917-123-4567'), '+639171234567');
  assert.equal(u.normalizeMobile('639171234567'), '+639171234567');
  assert.equal(u.normalizeMobile('12345'), null);
});
