const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SMS_PROVIDER = 'console';
process.env.OPD_PATIENTS_PER_SLOT = '2';
process.env.DATABASE_URL = '';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SUBMIT_RATE_LIMIT = '1000';
const { open } = require('../src/db');
const { createApp } = require('../src/server');
const { runReminders } = require('../src/reminders');
const sched = require('../src/scheduling');
const clinics = require('../src/clinics');
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
    email: 'juan.delacruz@example.com',
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

async function loginAs(username, password) {
  const res = await call('/admin/login', { method: 'POST', body: { username, password } });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], data: res.data };
}

test('user management: roles, deactivation, password reset, last admin', async () => {
  const admin = await login();
  const me = await call('/admin/me', { cookie: admin });
  assert.equal(me.data.role, 'ADMIN');

  // Create a staff user (username is case-insensitive, stored lowercase)
  let res = await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'Maria.S', full_name: 'Maria Santos', role: 'STAFF', password: 'short' } });
  assert.match(res.data.error, /8 characters/);
  res = await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'Maria.S', full_name: 'Maria Santos', role: 'STAFF', password: 'records123' } });
  assert.equal(res.status, 201);
  assert.equal(res.data.username, 'maria.s');
  assert.equal(res.data.full_name, 'MARIA SANTOS');
  const staffId = res.data.id;
  res = await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'maria.s', full_name: 'X', password: 'records123' } });
  assert.match(res.data.error, /taken/);

  // Staff can work on requests but not manage users or settings
  let staff = await loginAs('MARIA.S', 'records123');
  assert.equal(staff.status, 200);
  assert.equal((await call('/admin/records', { cookie: staff.cookie })).status, 200);
  assert.equal((await call('/admin/users', { cookie: staff.cookie })).status, 403);
  assert.equal((await call('/admin/closed-dates', { method: 'POST', cookie: staff.cookie, body: { date: '2026-12-25', reason: 'Christmas' } })).status, 403);

  // Changes are attributed to the staff member
  const { id: recId } = await db.one("SELECT id FROM record_requests ORDER BY id LIMIT 1");
  res = await call(`/admin/records/${recId}`, { method: 'PATCH', cookie: staff.cookie, body: { remarks: 'Checked', notify: false } });
  assert.equal(res.data.updated_by, 'maria.s');

  // Password reset signs the user out everywhere
  await call(`/admin/users/${staffId}/password`, { method: 'POST', cookie: admin, body: { password: 'newpass123' } });
  assert.equal((await call('/admin/me', { cookie: staff.cookie })).status, 401);
  staff = await loginAs('maria.s', 'newpass123');
  assert.equal(staff.status, 200);

  // Deactivation signs them out and blocks login
  await call(`/admin/users/${staffId}`, { method: 'PATCH', cookie: admin, body: { active: false } });
  assert.equal((await call('/admin/me', { cookie: staff.cookie })).status, 401);
  assert.equal((await loginAs('maria.s', 'newpass123')).status, 403);

  // The only admin can't demote or deactivate themselves
  const adminId = (await db.one("SELECT id FROM admins WHERE username = 'admin'")).id;
  res = await call(`/admin/users/${adminId}`, { method: 'PATCH', cookie: admin, body: { role: 'STAFF' } });
  assert.equal(res.status, 400);
  // ...and another admin can't remove the last remaining admin either
  await call(`/admin/users/${staffId}`, { method: 'PATCH', cookie: admin, body: { active: true, role: 'ADMIN' } });
  const second = await loginAs('maria.s', 'newpass123');
  res = await call(`/admin/users/${adminId}`, { method: 'PATCH', cookie: second.cookie, body: { active: false } });
  assert.equal(res.status, 200);
  res = await call(`/admin/users/${staffId}`, { method: 'PATCH', cookie: second.cookie, body: { role: 'STAFF' } });
  assert.match(res.data.error, /own role/);
  // restore for other tests
  await call(`/admin/users/${adminId}`, { method: 'PATCH', cookie: second.cookie, body: { active: true } });
  adminCookie = null;
});

test('per-user access: records-only and OPD-only staff', async () => {
  const admin = await login();
  const mk = (username, access) =>
    call('/admin/users', { method: 'POST', cookie: admin, body: { username, full_name: username, role: 'STAFF', password: 'password123', ...access } });

  assert.match((await mk('nobody', { can_records: false, can_opd: false })).data.error, /access/);
  assert.equal((await mk('rec.only', { can_records: true, can_opd: false })).status, 201);
  const opdUser = await mk('opd.only', { can_records: false, can_opd: true });
  assert.equal(opdUser.status, 201);

  const rec = (await loginAs('rec.only', 'password123')).cookie;
  const opd = (await loginAs('opd.only', 'password123')).cookie;

  // /me tells the browser which tabs to show
  assert.deepEqual((await call('/admin/me', { cookie: rec })).data.access, { records: true, opd: false, referrals: false, attendance: false });

  // Records-only user
  assert.equal((await call('/admin/records', { cookie: rec })).status, 200);
  assert.equal((await call('/admin/appointments', { cookie: rec })).status, 403);
  assert.equal((await call('/admin/appointments/1', { method: 'PATCH', cookie: rec, body: { status: 'CANCELLED' } })).status, 403);
  let stats = (await call('/admin/stats', { cookie: rec })).data;
  assert.ok('recordsPending' in stats && !('appointmentsToday' in stats));
  let sms = (await call('/admin/sms', { cookie: rec })).data.rows;
  assert.ok(sms.length > 0 && sms.every((m) => m.kind.startsWith('RECORD_')));

  // OPD-only user
  assert.equal((await call('/admin/appointments', { cookie: opd })).status, 200);
  assert.equal((await call('/admin/records', { cookie: opd })).status, 403);
  stats = (await call('/admin/stats', { cookie: opd })).data;
  assert.ok('appointmentsToday' in stats && !('recordsPending' in stats));
  sms = (await call('/admin/sms', { cookie: opd })).data.rows;
  assert.ok(sms.length > 0 && sms.every((m) => m.kind.startsWith('APPT_')));
  const recordSms = await db.one("SELECT id FROM sms_log WHERE kind LIKE 'RECORD_%' LIMIT 1");
  assert.equal((await call(`/admin/sms/${recordSms.id}/resend`, { method: 'POST', cookie: opd })).status, 404);

  // Granting access takes effect on the next request, without logging out
  await call(`/admin/users/${opdUser.data.id}`, { method: 'PATCH', cookie: admin, body: { can_records: true } });
  assert.equal((await call('/admin/records', { cookie: opd })).status, 200);

  // Administrators always have both
  assert.deepEqual((await call('/admin/me', { cookie: admin })).data.access, { records: true, opd: true, referrals: true, attendance: true });
});

test('patient-entered text is stored in capitals', async () => {
  const { date, time } = await firstOpdSlot('ENT');
  const res = await call('/appointments', {
    method: 'POST',
    body: { ...patient, patient_last: 'Reyes', patient_first: 'ana', department: 'ENT', appt_date: date, appt_time: time, patient_type: 'NEW', sex: 'F', complaint: 'ear pain', mobile: '09175550000' },
  });
  assert.equal(res.status, 201);
  const row = await db.one('SELECT patient_last, patient_first, complaint FROM appointments WHERE ref_no = $1', [res.data.ref_no]);
  assert.deepEqual(row, { patient_last: 'REYES', patient_first: 'ANA', complaint: 'EAR PAIN' });
});

test('UniSMS provider sends the expected request and logs failures', async () => {
  const config = require('../src/config');
  const { sendSms } = require('../src/sms');
  const saved = { ...config.sms };
  const realFetch = global.fetch;
  const calls = [];
  try {
    Object.assign(config.sms, { provider: 'unisms', unismsApiKey: 'sk_test_123', senderName: 'ZRMC' });
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ message: { reference_id: 'msg_1', status: 'sent' } }), { status: 200 });
    };
    assert.equal(await sendSms(db, { to: '+639171234567', message: 'Hello', kind: 'TEST' }), true);
    assert.equal(calls[0].url, 'https://unismsapi.com/api/sms');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('sk_test_123:').toString('base64')}`);
    assert.deepEqual(JSON.parse(calls[0].opts.body), { recipient: '+639171234567', content: 'Hello', sender_id: 'ZRMC' });

    const sent = await db.one('SELECT * FROM sms_log ORDER BY id DESC LIMIT 1');
    assert.equal(sent.provider_ref, 'msg_1');
    assert.equal(sent.provider_status, 'sent');

    // Without SMS_SENDER_NAME the default sender ID is still sent
    config.sms.senderName = '';
    await sendSms(db, { to: '+639171234567', message: 'Hi', kind: 'TEST' });
    assert.equal(JSON.parse(calls[1].opts.body).sender_id, 'UniSMS');

    // Check delivery asks UniSMS for the status of the saved reference
    const { checkDelivery } = require('../src/sms');
    global.fetch = async (url) => {
      calls.push({ url });
      return new Response('{"message":{"reference_id":"msg_1","status":"failed"}}', { status: 200 });
    };
    const checked = await checkDelivery(db, sent);
    assert.equal(calls.at(-1).url, 'https://unismsapi.com/api/sms/msg_1');
    assert.equal(checked.provider_status, 'failed');
    assert.equal(checked.status, 'FAILED');

    // Gateway errors are recorded in the SMS log instead of breaking the request
    global.fetch = async () => new Response('{"message":"Invalid API key"}', { status: 401 });
    assert.equal(await sendSms(db, { to: '+639171234567', message: 'Hello', kind: 'TEST' }), false);
    const last = await db.one('SELECT status, error, provider FROM sms_log ORDER BY id DESC LIMIT 1');
    assert.equal(last.status, 'FAILED');
    assert.equal(last.provider, 'unisms');
    assert.match(last.error, /UniSMS 401: .*Invalid API key/);
  } finally {
    Object.assign(config.sms, saved);
    global.fetch = realFetch;
  }
});

test('FAQ assistant answers common questions and logs unanswered ones', async () => {
  const { data } = await call('/faq');
  assert.ok(data.questions.length >= 10);

  const ask = async (message) => (await call('/faq/ask', { method: 'POST', body: { message } })).data;
  const cases = {
    'When can I claim my medical certificate?': 'When can I claim my documents?',
    'how many days before my records are ready': 'When can I claim my documents?',
    'kailan ko makukuha': 'When can I claim my documents?',
    'what do I need to bring?': 'What do I need to bring when claiming?',
    'can my wife claim it for me': 'Can someone else request or claim my records for me?',
    'I want to book an appointment with a doctor': 'How do I book an OPD appointment?',
    'what days is pediatrics open': 'What are the OPD clinic schedules?',
    'how do I cancel my appointment': 'How do I check or cancel my request or appointment?',
    'magkano ang bayad': 'How much do the documents cost?',
    "I didn't receive any text": "I didn't receive an SMS. What should I do?",
    'my father has chest pain': 'Is this for emergencies?',
  };
  for (const [message, expected] of Object.entries(cases)) {
    const r = await ask(message);
    assert.equal(r.question, expected, `"${message}" matched "${r.question}"`);
  }

  // Answers fill in values from the settings
  const claim = await ask('when can I claim');
  assert.match(claim.answer, /claimed 3 days after/);
  const sched = await ask('clinic schedule');
  assert.match(sched.answer, /Pediatrics: Monday to Friday/);
  assert.equal(sched.link.url, '/book-opd');

  const hours = await ask('what time is the records section open on saturday');
  assert.match(hours.answer, /HHIMS[\s\S]*Saturdays and Holidays, 8:00 AM – 4:00 PM \(No Noon Break\)/);

  // Unmatched questions get a fallback and are kept for staff
  const miss = await ask('do you have parking for motorcycles');
  assert.equal(miss.matched, false);
  assert.ok(miss.related.length > 0);
  assert.ok(await db.one("SELECT 1 FROM faq_unanswered WHERE message = 'do you have parking for motorcycles'"));
});

test('FAQ management is admin-only and validates links', async () => {
  const admin = await login();
  const staff = (await loginAs('rec.only', 'password123')).cookie;
  assert.equal((await call('/admin/faqs', { cookie: staff })).status, 403);

  let res = await call('/admin/faqs', { method: 'POST', cookie: admin, body: { question: 'Is there parking?', answer: 'Yes', link_url: 'javascript:alert(1)' } });
  assert.match(res.data.error, /link/);
  res = await call('/admin/faqs', { method: 'POST', cookie: admin, body: { question: 'Is there parking?', answer: 'Yes, at the back.', link_url: '//evil.example' } });
  assert.match(res.data.error, /link/);
  res = await call('/admin/faqs', {
    method: 'POST',
    cookie: admin,
    body: { question: 'Is there parking?', answer: 'Yes, behind {hospital}.', keywords: 'Parking, Motorcycle, park', sort_order: 5 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.keywords, 'parking, motorcycle, park');

  const r = (await call('/faq/ask', { method: 'POST', body: { message: 'where can I park my motorcycle' } })).data;
  assert.equal(r.question, 'Is there parking?');
  assert.equal(r.answer, 'Yes, behind Zamboanga Regional Medical Center.');

  // Hidden FAQs are not used
  await call(`/admin/faqs/${res.data.id}`, { method: 'PATCH', cookie: admin, body: { active: false } });
  assert.notEqual((await call('/faq/ask', { method: 'POST', body: { message: 'motorcycle parking' } })).data.question, 'Is there parking?');
});

test('hospital directory: public data, admin editing, maps with pins', async () => {
  let pub = (await call('/directory')).data;
  assert.ok(pub.entries.some((e) => e.name === 'Hospital Health Information Management Section (HHIMS)' && /Saturdays and Holidays, 8:00 AM – 4:00 PM/.test(e.hours)));
  assert.ok(pub.entries.some((e) => e.opd_code === 'PEDIA'));
  assert.ok(pub.guides.length >= 4);
  assert.match(pub.clinics.clinics.find((c) => c.code === 'SURG').schedule, /Mon, Wed, Fri, 8:00 AM/);
  assert.deepEqual(pub.contact, {}); // nothing invented: contact details start empty

  const admin = await login();
  const staff = (await loginAs('rec.only', 'password123')).cookie;
  assert.equal((await call('/admin/directory', { cookie: staff })).status, 403);

  // Contact details: https only for web links
  let res = await call('/admin/directory/contact', { method: 'PUT', cookie: admin, body: { facebook: 'javascript:alert(1)' } });
  assert.equal(res.status, 400);
  res = await call('/admin/directory/contact', { method: 'PUT', cookie: admin, body: { trunk_line: '(062) 000-0000', facebook: 'https://facebook.com/example' } });
  assert.equal(res.status, 200);

  // Map upload: a real 1x1 PNG is accepted; a fake "image" is not
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  res = await call('/admin/maps', { method: 'POST', cookie: admin, body: { title: 'Ground floor', image: `data:image/png;base64,${Buffer.from('<script>').toString('base64')}` } });
  assert.match(res.data.error, /PNG, JPG or WebP/);
  res = await call('/admin/maps', { method: 'POST', cookie: admin, body: { title: 'Ground floor', image: `data:image/png;base64,${png}` } });
  assert.equal(res.status, 201);
  const mapId = res.data.id;
  const img = await fetch(base + `/maps/${mapId}/image`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), png);

  // Entry with a pin on that map
  res = await call('/admin/directory/entries', {
    method: 'POST', cookie: admin,
    body: { name: 'Cashier', category: 'Office', location: 'Ground floor, near main entrance', map_id: mapId, pin_x: 42.5, pin_y: 60, phone: 'Local 101' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  res = await call('/admin/directory/entries', { method: 'POST', cookie: admin, body: { name: 'X', category: 'Spaceport' } });
  assert.match(res.data.error, /category/);
  res = await call('/admin/directory/guides', { method: 'POST', cookie: admin, body: { title: 'Paying bills', link_url: 'javascript:alert(1)' } });
  assert.match(res.data.error, /Links/);

  pub = (await call('/directory')).data;
  const cashier = pub.entries.find((e) => e.name === 'Cashier');
  assert.equal(cashier.map_id, mapId);
  assert.equal(cashier.pin_x, 42.5);
  assert.equal(pub.contact.trunk_line, '(062) 000-0000');
  assert.match(pub.maps[0].url, new RegExp(`^/api/maps/${mapId}/image\\?v=`));

  // Deleting the map keeps the entry but removes the pin
  await call(`/admin/maps/${mapId}`, { method: 'DELETE', cookie: admin });
  const after = (await call('/directory')).data.entries.find((e) => e.name === 'Cashier');
  assert.equal(after.map_id, null);
  assert.equal(after.pin_x, null);
});

test('authorization letter is filled in for representative requests', async () => {
  const JSZip = require('jszip');
  const body = {
    ...patient,
    patient_middle: 'santos',
    requester_name: 'Maria Dela Cruz',
    requester_relation: 'Spouse',
    email: 'maria@example.com',
    purpose: 'PhilHealth claim',
    items: [{ record_type: 'MEDICAL_CERTIFICATE' }, { record_type: 'CLINICAL_ABSTRACT' }, { record_type: 'OTHERS', details: 'Anesthesia record' }],
  };
  let res = await call('/records', { method: 'POST', body });
  assert.match(res.data.error, /address/);
  res = await call('/records', { method: 'POST', body: { ...body, patient_address: 'Brgy. Tetuan, Zamboanga City' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.letter_url, /^\/api\/records\/R-[\w-]+\/authorization-letter\?t=/);

  const text = async (r) => {
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    return (await zip.file('word/document.xml').async('string')).replace(/<[^>]+>/g, '');
  };
  const dl = await fetch(base.replace('/api', '') + res.data.letter_url);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /Authorization-Letter-R-/);
  const t = await text(dl);
  assert.match(t, /I, +JUAN SANTOS DELA CRUZ/);
  assert.match(t, /residing at +BRGY\. TETUAN, ZAMBOANGA CITY/);
  assert.match(t, /authorized +MARIA DELA CRUZ/);
  assert.match(t, /■ +Medical Certificate/);
  assert.match(t, /□ +Certificate of Confinement/);
  assert.match(t, /■ +Others: +Clinical Abstract \/ Discharge Summary, ANESTHESIA RECORD/);
  assert.ok(!t.includes('_____'), 'all blanks filled');

  // Wrong or missing signature → not found; patient's own requests have no letter
  assert.equal((await fetch(base + `/records/${res.data.ref_no}/authorization-letter?t=wrong`)).status, 404);
  const own = (await call('/track', { method: 'POST', body: { ref_no: (await db.one("SELECT ref_no FROM record_requests WHERE requester_relation LIKE 'Self%' AND mobile = '+639171234567' LIMIT 1")).ref_no, mobile: '09171234567' } })).data;
  assert.equal(own.letter_url, null);

  // Track page and staff panel can download it too
  const tracked = (await call('/track', { method: 'POST', body: { ref_no: res.data.ref_no, mobile: '09171234567' } })).data;
  assert.equal(tracked.letter_url, res.data.letter_url);
  const { id } = await db.one('SELECT id FROM record_requests WHERE ref_no = $1', [res.data.ref_no]);
  const staffDl = await fetch(base + `/admin/records/${id}/authorization-letter`, { headers: { Cookie: await login() } });
  assert.equal(staffDl.status, 200);
  assert.match(await text(staffDl), /MARIA DELA CRUZ/);
  assert.equal((await fetch(base + `/admin/records/${id}/authorization-letter`)).status, 401);
});

test('OPD schedules are set per clinic per month', async () => {
  const admin = await login();
  const put = (code, month, body) => call(`/admin/opd/schedules/${code}/${month}`, { method: 'PUT', cookie: admin, body });
  const jan1 = new Date(2027, 0, 1, 6); // Fri 1 Jan 2027, 6 AM: shows bookable dates up to 31 Jan

  // January 2027: Internal Medicine only on Tuesdays 1–3 PM, one patient per hour,
  // closed on the 12th, plus an extra clinic on Saturday the 16th
  let res = await put('IM', '2027-01', { days: [2], start_time: '25:00', end_time: '15:00', slot_minutes: 60, per_slot: 1 });
  assert.match(res.data.error, /Start time/);
  res = await put('IM', '2027-01', {
    days: [2], start_time: '13:00', end_time: '15:00', slot_minutes: 60, per_slot: 1,
    closed_dates: ['2027-01-12', '2027-02-02'], extra_dates: ['2027-01-16'], note: 'Dr. on leave Jan 12',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.closed_dates, ['2027-01-12']); // dates outside the month are ignored

  const dates = (await sched.opdDates(db, 'IM', jan1)).map((d) => d.date);
  assert.deepEqual(dates, ['2027-01-05', '2027-01-16', '2027-01-19', '2027-01-26']);
  const slots = await sched.opdSlots(db, 'IM', '2027-01-05', jan1);
  assert.deepEqual(slots.map((x) => [x.label, x.remaining]), [['1:00 PM', 1], ['2:00 PM', 1]]);

  // February not set yet → January's days and hours carry over, without January's date exceptions
  const feb = await clinics.scheduleFor(db, 'IM', '2027-02');
  assert.equal(feb.carried_over, true);
  assert.deepEqual(feb.days, [2]);
  assert.deepEqual(feb.closed_dates, []);
  let list = (await call('/admin/opd/schedules?month=2027-02', { cookie: admin })).data;
  assert.equal(list.clinics.find((c) => c.code === 'IM').schedule.source_month, '2027-01');

  // "Copy last month" publishes February for every clinic not yet set
  res = await call('/admin/opd/schedules/2027-02/copy-previous', { method: 'POST', cookie: admin });
  assert.ok(res.data.copied >= 8);
  list = (await call('/admin/opd/schedules?month=2027-02', { cookie: admin })).data;
  assert.ok(list.clinics.every((c) => !c.schedule || c.schedule.carried_over === false));

  // New clinic: listed but not bookable until it has a schedule; SMS uses its name
  res = await call('/admin/opd/clinics', { method: 'POST', cookie: admin, body: { name: 'Cardiology' } });
  assert.equal(res.status, 201);
  const code = res.data.code;
  let cat = (await call('/catalog')).data;
  assert.equal(cat.departments.find((d) => d.code === code).schedule, 'No clinic this month');
  assert.deepEqual(await sched.opdDates(db, code, jan1), []);
  await put(code, '2027-01', { days: [1, 3], start_time: '08:00', end_time: '10:00', slot_minutes: 30, per_slot: 3 });
  assert.equal((await sched.opdDates(db, code, jan1))[0].date, '2027-01-04');
  const named = await clinics.withClinicName(db, { department: code, ref_no: 'A-X', appt_date: '2027-01-04', appt_time: '08:00' });
  assert.match(require('../src/messages').apptBooked(named), /Cardiology, Mon, Jan 4, 2027 8:00 AM/);

  // Hiding a clinic removes it from booking
  await call(`/admin/opd/clinics/${code}`, { method: 'PATCH', cookie: admin, body: { active: false } });
  cat = (await call('/catalog')).data;
  assert.ok(!cat.departments.some((d) => d.code === code));
  assert.equal((await call(`/opd/dates?department=${code}`)).status, 400);

  // Records-only staff can't edit schedules
  const rec = (await loginAs('rec.only', 'password123')).cookie;
  assert.equal((await call('/admin/opd/schedules', { cookie: rec })).status, 403);

  // FAQ assistant reads the live schedules
  const answer = (await call('/faq/ask', { method: 'POST', body: { message: 'clinic schedule' } })).data.answer;
  assert.match(answer, /General Surgery: Mon, Wed, Fri/);
});

test('digital copies: ID photos, staff verification, assignment and sending by email', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const body = {
    ...patient,
    requester_name: 'Juan Dela Cruz',
    requester_relation: 'Self (patient)',
    email: 'juan.delacruz@example.com',
    purpose: 'Insurance claim',
    items: [{ record_type: 'MEDICAL_CERTIFICATE', copies: 2 }, { record_type: 'CLINICAL_ABSTRACT' }],
    copy_type: 'DIGITAL',
    payment_ref: '1234 567 890123',
  };
  const post = (b) => call('/records', { method: 'POST', body: b });

  assert.match((await post({ ...body, email: '' })).data.error, /Email/);
  assert.match((await post(body)).data.error, /valid ID/);
  assert.match((await post({ ...body, id_photo: png, selfie_photo: 'data:image/png;base64,PHNjcmlwdD4=' })).data.error, /selfie/);
  assert.match((await post({ ...body, id_photo: png, selfie_photo: png })).data.error, /payment receipt/);
  assert.match(
    (await post({ ...body, requester_relation: 'Spouse', requester_name: 'Maria', patient_address: 'X', id_photo: png, selfie_photo: png, receipt_photo: png })).data.error,
    /only available when the patient/,
  );

  let res = await post({ ...body, id_photo: png, selfie_photo: png, receipt_photo: png });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.copy_type, 'DIGITAL');
  assert.equal(res.data.amount_due, 2 * 30 + 50); // 2 × Medical Certificate (₱30) + Clinical Abstract (₱50)
  assert.equal(res.data.payment_ref, '1234 567 890123');
  assert.equal(res.data.id_status, 'PENDING');
  const ref = res.data.ref_no;
  const { id } = await db.one('SELECT id FROM record_requests WHERE ref_no = $1', [ref]);
  assert.match((await db.one("SELECT message FROM sms_log WHERE ref_no = $1 AND kind = 'RECORD_SUBMITTED'", [ref])).message, /digital copy.*verify your ID/);

  // Photos: staff with Records access only
  const admin = await login();
  assert.equal((await fetch(base + `/admin/records/${id}/id-photo/selfie`)).status, 401);
  const photo = await fetch(base + `/admin/records/${id}/id-photo/selfie`, { headers: { Cookie: admin } });
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + `/admin/records/${id}/id-photo/receipt`, { headers: { Cookie: admin } })).status, 200);

  // Can't prepare or release before the ID is verified
  assert.match((await call(`/admin/records/${id}`, { method: 'PATCH', cookie: admin, body: { status: 'READY' } })).data.error, /Verify/);
  assert.match((await call(`/admin/records/${id}/emailed`, { method: 'POST', cookie: admin })).data.error, /Verify/);

  // Reject → requester is told why and uploads new photos on the Track page
  assert.match((await call(`/admin/records/${id}/verify-id`, { method: 'POST', cookie: admin, body: { decision: 'REJECTED' } })).data.error, /reason/);
  res = await call(`/admin/records/${id}/verify-id`, { method: 'POST', cookie: admin, body: { decision: 'REJECTED', remarks: 'ID photo is blurry' } });
  assert.equal(res.data.id_status, 'REJECTED');
  assert.match((await db.one("SELECT message FROM sms_log WHERE ref_no = $1 AND kind = 'RECORD_ID_REJECTED'", [ref])).message, /ID photo is blurry/);
  const tracked = (await call('/track', { method: 'POST', body: { ref_no: ref, mobile: '09171234567' } })).data;
  assert.equal(tracked.id_remarks, 'ID photo is blurry');
  res = await call('/track/id-photos', { method: 'POST', body: { ref_no: ref, mobile: '09171234567', id_photo: png, selfie_photo: png, receipt_photo: png } });
  assert.equal(res.data.id_status, 'PENDING');

  // Approve → processing, assigned to the verifier, requester texted
  res = await call(`/admin/records/${id}/verify-id`, { method: 'POST', cookie: admin, body: { decision: 'VERIFIED' } });
  assert.equal(res.data.status, 'PROCESSING');
  assert.equal(res.data.assigned_to, 'admin');

  // Reassign to a records staff member; OPD-only staff can't be assigned
  await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'opd.x', full_name: 'X', role: 'STAFF', password: 'password123', can_records: false, can_opd: true } });
  assert.match((await call(`/admin/records/${id}`, { method: 'PATCH', cookie: admin, body: { assigned_to: 'opd.x' } })).data.error, /cannot be assigned/);
  res = await call(`/admin/records/${id}`, { method: 'PATCH', cookie: admin, body: { assigned_to: 'rec.only' } });
  assert.equal(res.data.assigned_to, 'rec.only');
  const rec = (await loginAs('rec.only', 'password123')).cookie;
  const mine = (await call('/admin/records?assigned=me&copy_type=DIGITAL', { cookie: rec })).data.rows;
  assert.deepEqual(mine.map((r) => r.ref_no), [ref]);
  assert.match((await call(`/admin/records/${id}`, { method: 'PATCH', cookie: rec, body: { status: 'RELEASED' } })).data.error, /Send by email/);

  // Sent from the hospital's email → released, requester texted (email masked)
  res = await call(`/admin/records/${id}/emailed`, { method: 'POST', cookie: rec });
  assert.equal(res.data.status, 'RELEASED');
  assert.equal(res.data.emailed_by, 'rec.only');
  assert.match((await db.one("SELECT message FROM sms_log WHERE ref_no = $1 AND kind = 'RECORD_EMAILED'", [ref])).message, /sent to ju\*\*\*@example\.com/);

  // Photos are deleted after the retention period
  const { purgeIdPhotos } = require('../src/idphotos');
  assert.equal(await purgeIdPhotos(db), 0);
  assert.equal(await purgeIdPhotos(db, new Date(Date.now() + 31 * 86400e3)), 3);
  assert.equal((await fetch(base + `/admin/records/${id}/id-photo/id`, { headers: { Cookie: admin } })).status, 404);
});

test('fees and payment QR are managed by administrators', async () => {
  let cat = (await call('/catalog')).data;
  assert.equal(cat.recordTypes.find((t) => t.code === 'MEDICO_LEGAL').fee, 30);
  assert.equal(cat.recordTypes.find((t) => t.code === 'LABORATORY_TEST').fee, 50);
  assert.equal(cat.payment.qr_url, '/img/payment-qr.jpg');

  const admin = await login();
  const rec = (await loginAs('rec.only', 'password123')).cookie;
  assert.equal((await call('/admin/fees', { method: 'PUT', cookie: rec, body: { fees: { OPTECH: 1 } } })).status, 403);
  assert.match((await call('/admin/fees', { method: 'PUT', cookie: admin, body: { fees: { OPTECH: -5 } } })).data.error, /OPTECH/);
  await call('/admin/fees', { method: 'PUT', cookie: admin, body: { fees: { OPTECH: 75 } } });
  cat = (await call('/catalog')).data;
  assert.equal(cat.recordTypes.find((t) => t.code === 'OPTECH').fee, 75);
  // Hardcopy requests also record the total payable
  const res = await call('/records', {
    method: 'POST',
    body: { ...patient, requester_name: 'Juan', requester_relation: 'Self (patient)', email: 'j@example.com', purpose: 'x', items: [{ record_type: 'OPTECH', copies: 3 }] },
  });
  assert.equal(res.data.amount_due, 225);
  assert.equal(res.data.copy_type, 'HARDCOPY');
  await call('/admin/fees', { method: 'PUT', cookie: admin, body: { fees: { OPTECH: 50 } } });

  // Replace the QR code with the hospital's own, then restore the default
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let info = (await call('/admin/payment-qr', { method: 'POST', cookie: admin, body: { image: png } })).data;
  assert.match(info.qr_url, /^\/api\/site-images\/payment-qr\?v=/);
  const qr = await fetch(base.replace('/api', '') + info.qr_url);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  await call('/admin/payment-note', { method: 'PUT', cookie: admin, body: { note: 'Pay via the official ZRMC GCash account.' } });
  assert.equal((await call('/catalog')).data.payment.note, 'Pay via the official ZRMC GCash account.');
  info = (await call('/admin/payment-qr', { method: 'DELETE', cookie: admin })).data;
  assert.equal(info.qr_url, '/img/payment-qr.jpg');
});

test('referrals from RHUs, health centers and hospitals', async () => {
  const admin = await login();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%test\n').toString('base64')}`;

  // Facilities and their accounts (managed by staff with Referrals access)
  let res = await call('/admin/facilities', { method: 'POST', cookie: admin, body: { name: 'Tetuan RHU', type: 'RHU', municipality: 'Zamboanga City', phone: '09170001111' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const rhu = res.data;
  assert.equal(rhu.name, 'TETUAN RHU');
  const other = (await call('/admin/facilities', { method: 'POST', cookie: admin, body: { name: 'Ayala BHS', type: 'BHS' } })).data;
  assert.equal((await call(`/admin/facilities/${rhu.id}/users`, { method: 'POST', cookie: admin, body: { username: 'admin', full_name: 'x', password: 'password123' } })).data.error, 'That username is already taken.');
  await call(`/admin/facilities/${rhu.id}/users`, { method: 'POST', cookie: admin, body: { username: 'rhu.nurse', full_name: 'Ana Nurse', password: 'password123' } });
  await call(`/admin/facilities/${other.id}/users`, { method: 'POST', cookie: admin, body: { username: 'bhs.mw', full_name: 'Midwife', password: 'password123' } });

  const fcall = (path, opts = {}) => call(`/facility${path}`, opts);
  const flogin = async (username) => {
    const r = await fcall('/login', { method: 'POST', body: { username, password: 'password123' } });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const fc = await flogin('rhu.nurse');
  const fc2 = await flogin('bhs.mw');

  // Facility and staff sessions are separate
  assert.equal((await call('/admin/me', { cookie: fc })).status, 401);
  assert.equal((await fcall('/me', { cookie: admin })).status, 401);
  // A staff account typed into the facility login is told where to go, without being signed in
  const wrongDoor = await fcall('/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(wrongDoor.status, 401);
  assert.match(wrongDoor.data.error, /staff account/i);
  assert.equal(wrongDoor.headers.get('set-cookie'), null);
  const badPw = await fcall('/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  assert.equal(badPw.data.error, 'Invalid username or password.');
  const me = (await fcall('/me', { cookie: fc })).data;
  assert.equal(me.facility.name, 'TETUAN RHU');
  assert.ok(me.departments.some((d) => d.code === 'ER') && me.departments.some((d) => d.code === 'IM'));

  // Sending a referral
  const body = {
    patient_last: 'Santos', patient_first: 'Pedro', birthdate: '1975-03-02', sex: 'M', address: 'Brgy. Tetuan, Zamboanga City',
    mobile: '09175556666', philhealth_no: '12-345678901-2', urgency: 'URGENT', department: 'IM',
    reason: 'For further evaluation', chief_complaint: '=HYPERLINK("http://x") chest heaviness', working_diagnosis: 'Hypertension, uncontrolled',
    bp: '170/100', hr: '96', referring_name: 'Dr. Reyes', referring_designation: 'MHO',
  };
  assert.match((await fcall('/referrals', { method: 'POST', cookie: fc, body: { ...body, working_diagnosis: '' } })).data.error, /diagnosis/);
  assert.match((await fcall('/referrals', { method: 'POST', cookie: fc, body: { ...body, attachments: [{ name: 'x.exe', data: 'data:application/octet-stream;base64,TVqQ' }] } })).data.error, /photos|PDF/);
  res = await fcall('/referrals', { method: 'POST', cookie: fc, body: { ...body, attachments: [{ name: 'ecg.png', data: png }, { name: 'labs.pdf', data: pdf }] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const r1 = res.data;
  assert.match(r1.ref_no, /^F-\d{6}-/);
  assert.equal(r1.status, 'SENT');
  assert.equal(r1.patient_last, 'SANTOS');
  assert.equal(r1.attachments.length, 2);
  const r2 = (await fcall('/referrals', { method: 'POST', cookie: fc, body: { ...body, patient_first: 'Maria', urgency: 'EMERGENCY', department: 'ER' } })).data;

  // Each facility sees only its own referrals
  assert.equal((await fcall('/referrals', { cookie: fc2 })).data.rows.length, 0);
  assert.equal((await fcall(`/referrals/${r1.id}`, { cookie: fc2 })).status, 404);
  assert.equal((await fcall(`/referrals/${r1.id}/attachments/${r1.attachments[1].id}`, { cookie: fc2 })).status, 404);
  const att = await fetch(`${base}/facility/referrals/${r1.id}/attachments/${r1.attachments[1].id}`, { headers: { Cookie: fc } });
  assert.equal(att.headers.get('content-type'), 'application/pdf');

  // Staff need the Referrals permission
  const rec = (await loginAs('rec.only', 'password123')).cookie;
  assert.equal((await call('/admin/referrals', { cookie: rec })).status, 403);
  await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'ref.desk', full_name: 'Referral Desk', role: 'STAFF', password: 'password123', can_records: false, can_opd: false, can_referrals: true } });
  const desk = (await loginAs('ref.desk', 'password123')).cookie;
  let inbox = (await call('/admin/referrals?status=OPEN', { cookie: desk })).data;
  assert.equal(inbox.open.n, 2);
  assert.equal(inbox.rows[0].ref_no, r2.ref_no, 'emergencies first');

  // Opening marks it received; accept with an OPD appointment
  assert.equal((await call(`/admin/referrals/${r1.id}`, { cookie: desk })).data.status, 'RECEIVED');
  assert.equal((await fcall(`/referrals/${r1.id}`, { cookie: fc })).data.status_label, 'Received by ZRMC');
  // A slot with room left (earlier tests filled some)
  const dates = (await call('/opd/dates?department=IM')).data.dates.filter((d) => d.date > u.todayStr() && d.remaining > 0);
  const date = dates[dates.length - 1].date;
  const time = (await call(`/opd/slots?department=IM&date=${date}`)).data.slots.find((x) => x.remaining > 0).time;
  res = await call(`/admin/referrals/${r1.id}/accept`, { method: 'POST', cookie: desk, body: { note: 'Proceed to OPD, bring referral slip', book: { clinic: 'IM', date, time } } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'ACCEPTED');
  assert.equal(res.data.appt_date, date);
  const appt = await db.one('SELECT * FROM appointments WHERE id = $1', [res.data.appointment_id]);
  assert.equal(appt.patient_last, 'SANTOS');
  assert.match(appt.remarks, /Referral F-/);
  const smsKinds = (await db.query('SELECT recipient FROM sms_log WHERE ref_no = $1', [r1.ref_no])).map((x) => x.recipient).sort();
  assert.deepEqual(smsKinds, ['+639170001111', '+639175556666']); // facility and patient
  assert.match((await call(`/admin/referrals/${r1.id}/accept`, { method: 'POST', cookie: desk, body: {} })).data.error, /already/);
  assert.equal((await fcall(`/referrals/${r1.id}/cancel`, { method: 'POST', cookie: fc })).status, 400);

  // Redirect needs a reason
  assert.match((await call(`/admin/referrals/${r2.id}/redirect`, { method: 'POST', cookie: desk, body: {} })).data.error, /reason/);
  assert.equal((await call(`/admin/referrals/${r2.id}/redirect`, { method: 'POST', cookie: desk, body: { note: 'No ICU bed; refer to another hospital' } })).data.status, 'REDIRECTED');

  // Arrived, seen with feedback for the return slip
  assert.equal((await call(`/admin/referrals/${r1.id}/arrived`, { method: 'POST', cookie: desk })).data.status, 'ARRIVED');
  res = await call(`/admin/referrals/${r1.id}/seen`, { method: 'POST', cookie: desk, body: { feedback: 'Started on amlodipine; follow up at RHU in 2 weeks' } });
  assert.equal(res.data.status, 'SEEN');
  assert.equal((await fcall(`/referrals/${r1.id}`, { cookie: fc })).data.feedback, 'STARTED ON AMLODIPINE; FOLLOW UP AT RHU IN 2 WEEKS');

  // Export for Bizbox: accepted referrals only, marked as exported; formulas neutralised
  const csv = await fetch(`${base}/admin/referrals/export.csv?only_new=1`, { headers: { Cookie: desk } });
  assert.match(csv.headers.get('content-disposition'), /ZRMC-referrals-/);
  const text = await csv.text();
  const lines = text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Referral No,Date Referred,Referring Facility/);
  assert.match(lines[1], new RegExp(r1.ref_no));
  assert.match(lines[1], /"'=HYPERLINK\(""HTTP:\/\/X""\) CHEST HEAVINESS"/);
  assert.ok((await db.one('SELECT exported_at FROM referrals WHERE id = $1', [r1.id])).exported_at);
  assert.equal((await (await fetch(`${base}/admin/referrals/export.csv?only_new=1`, { headers: { Cookie: desk } })).text()).trim().split('\r\n').length, 1);

  // Monthly report
  const rep = (await call('/admin/referrals/report', { cookie: desk })).data;
  const row = rep.by_facility.find((f) => f.name === 'TETUAN RHU');
  assert.deepEqual([row.total, row.accepted, row.redirected, row.emergency], [2, 1, 1, 1]);

  // Deactivating a facility user signs them out
  const users = (await call(`/admin/facilities/${rhu.id}/users`, { cookie: desk })).data.rows;
  await call(`/admin/facility-users/${users[0].id}`, { method: 'PATCH', cookie: desk, body: { active: false } });
  assert.equal((await fcall('/me', { cookie: fc })).status, 401);
});

test('attendance: kiosks, employees, time in/out, PIN lockout, corrections and DTR', async () => {
  const admin = await login();
  const att = require('../src/attendance');
  const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // Staff with only Attendance access
  const created = await call('/admin/users', {
    method: 'POST', cookie: admin,
    body: { username: 'hr.clerk', full_name: 'hr clerk', password: 'password123', role: 'STAFF', can_records: false, can_opd: false, can_attendance: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.can_attendance, true);
  const hr = (await call('/admin/login', { method: 'POST', body: { username: 'hr.clerk', password: 'password123' } })).headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await call('/admin/me', { cookie: hr })).data.access, { records: false, opd: false, referrals: false, attendance: true });
  assert.equal((await call('/admin/records', { cookie: hr })).status, 403);
  // ...and someone without it
  await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'opd.only', full_name: 'opd', password: 'password123', role: 'STAFF', can_records: false } });
  const opd = (await call('/admin/login', { method: 'POST', body: { username: 'opd.only', password: 'password123' } })).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/admin/attendance/employees', { cookie: opd })).status, 403);

  // Employees: one regular 08:00-17:00, one on a night shift 22:00-06:00, plus an import
  const e1 = await call('/admin/attendance/employees', {
    method: 'POST', cookie: hr,
    body: { employee_no: '2023-0001', last_name: 'dela cruz', first_name: 'juan', middle_name: 'santos', position: 'nurse ii', department: 'emergency room', pin: '1234' },
  });
  assert.equal(e1.status, 201);
  assert.equal(e1.data.pin, '1234');
  assert.equal(e1.data.shift_start, '08:00');
  assert.equal(e1.data.name, 'DELA CRUZ, JUAN S.');
  const e2 = await call('/admin/attendance/employees', {
    method: 'POST', cookie: hr,
    body: { employee_no: '2023-0002', last_name: 'reyes', first_name: 'ana', shift_start: '22:00', shift_end: '06:00', pin: '5678' },
  });
  assert.equal(e2.status, 201);
  assert.equal((await call('/admin/attendance/employees', { method: 'POST', cookie: hr, body: { employee_no: '2023-0001', last_name: 'x', first_name: 'y' } })).status, 400);
  const imp = await call('/admin/attendance/employees/import', {
    method: 'POST', cookie: hr,
    body: { csv: 'Employee No,Last,First,Middle,Position,Department\n2023-0003,SANTOS,MARIA,,MIDWIFE,OB WARD\n"2023-0004","LIM, JR.","PEDRO","",CLERK,HHIMS\n', shifting: true },
  });
  assert.equal(imp.status, 201);
  assert.equal(imp.data.rows.length, 2);
  assert.match(imp.data.rows[0].pin, /^\d{4}$/);
  assert.equal(imp.data.rows[1].last_name, 'LIM, JR.');
  assert.equal(imp.data.rows[1].shift_start, null);
  // A bad line imports nothing
  const badImp = await call('/admin/attendance/employees/import', { method: 'POST', cookie: hr, body: { csv: '2023-0005,A,B\n2023-0001,C,D' } });
  assert.equal(badImp.status, 400);
  assert.match(badImp.data.error, /Line 2/);
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM employees WHERE employee_no = '2023-0005'")).n, 0);

  // Punching needs a registered kiosk
  const notKiosk = await call('/attendance/punch', { method: 'POST', body: { employee_no: '2023-0001', pin: '1234', kind: 'IN' } });
  assert.equal(notKiosk.status, 401);
  assert.equal(notKiosk.data.setup, true);
  assert.equal((await call('/attendance/kiosk')).data.kiosk, null);
  assert.equal((await call('/attendance/kiosk', { method: 'POST', body: { username: 'opd.only', password: 'password123', name: 'x' } })).status, 403);
  assert.equal((await call('/attendance/kiosk', { method: 'POST', body: { username: 'hr.clerk', password: 'wrong', name: 'x' } })).status, 401);
  const setup = await call('/attendance/kiosk', { method: 'POST', body: { username: 'hr.clerk', password: 'password123', name: 'main lobby', require_photo: true } });
  assert.equal(setup.status, 201);
  const kc = setup.headers.get('set-cookie').split(';')[0];
  assert.match(setup.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await call('/attendance/kiosk', { cookie: kc })).data.kiosk.name, 'MAIN LOBBY');
  const punch = (body) => call('/attendance/punch', { method: 'POST', cookie: kc, body: { photo: PHOTO, ...body } });

  // Photo required on this kiosk
  assert.equal((await punch({ employee_no: '2023-0001', pin: '1234', kind: 'IN', photo: undefined })).status, 400);
  const in1 = await punch({ employee_no: '2023-0001', pin: '1234', kind: 'IN' });
  assert.equal(in1.status, 201);
  assert.equal(in1.data.name, 'JUAN DELA CRUZ');
  assert.equal(in1.data.duplicate, false);
  // Double tap is recorded once
  const again = await punch({ employee_no: '2023-0001', pin: '1234', kind: 'IN' });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM attendance_logs WHERE employee_id = $1', [e1.data.id])).n, 1);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM attendance_photos')).n, 1);
  // Time-out without a time-in gets a warning
  const orphan = await punch({ employee_no: '2023-0002', pin: '5678', kind: 'OUT' });
  assert.equal(orphan.status, 201);
  assert.match(orphan.data.warnings[0], /No time-in/);

  // Wrong PINs lock the employee no. (5 attempts by default); HR's PIN reset unlocks it
  for (let i = 0; i < 5; i++) assert.equal((await punch({ employee_no: '2023-0002', pin: '0000', kind: 'IN' })).status, 401);
  const locked = await punch({ employee_no: '2023-0002', pin: '5678', kind: 'IN' });
  assert.equal(locked.status, 423);
  assert.equal((await call('/admin/attendance/employees?q=reyes', { cookie: hr })).data.rows[0].locked, true);
  const reset = await call(`/admin/attendance/employees/${e2.data.id}/pin`, { method: 'POST', cookie: hr, body: {} });
  assert.match(reset.data.pin, /^\d{4}$/);
  assert.equal((await punch({ employee_no: '2023-0002', pin: reset.data.pin, kind: 'IN' })).status, 201);
  // Unknown employee and inactive employee
  assert.equal((await punch({ employee_no: 'NOPE', pin: '1234', kind: 'IN' })).status, 401);
  await call(`/admin/attendance/employees/${imp.data.rows[0].id}`, { method: 'PATCH', cookie: hr, body: { active: false } });
  assert.equal((await punch({ employee_no: '2023-0003', pin: imp.data.rows[0].pin, kind: 'IN' })).status, 403);

  // Employee changes their own PIN at the kiosk
  assert.equal((await call('/attendance/pin', { method: 'POST', cookie: kc, body: { employee_no: '2023-0001', pin: '1234', new_pin: '12' } })).status, 400);
  assert.equal((await call('/attendance/pin', { method: 'POST', cookie: kc, body: { employee_no: '2023-0001', pin: '1234', new_pin: '4321' } })).status, 200);

  // Today board
  const today = (await call('/admin/attendance/today', { cookie: hr })).data;
  const juan = today.rows.find((r) => r.employee_no === '2023-0001');
  assert.equal(juan.status, 'IN');
  assert.ok(juan.first_in);
  assert.ok(!today.rows.some((r) => r.employee_no === '2023-0003')); // inactive

  // Logs, photo, manual entry with reason, void with reason
  const logs = (await call('/admin/attendance/logs', { cookie: hr })).data.rows;
  const juanIn = logs.find((l) => l.employee_no === '2023-0001');
  assert.equal(juanIn.kiosk, 'MAIN LOBBY');
  assert.equal(juanIn.has_photo, true);
  const photo = await fetch(`${base}/admin/attendance/logs/${juanIn.id}/photo`, { headers: { Cookie: hr } });
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/admin/attendance/logs/${juanIn.id}/photo`, { headers: { Cookie: opd } })).status, 403);
  assert.equal((await call('/admin/attendance/logs', { method: 'POST', cookie: hr, body: { employee_id: e1.data.id, kind: 'IN', date: '2026-10-05', time: '08:00' } })).status, 400);
  const future = u.addDays(u.todayStr(), 2);
  assert.equal((await call('/admin/attendance/logs', { method: 'POST', cookie: hr, body: { employee_id: e1.data.id, kind: 'IN', date: future, time: '08:00', reason: 'x' } })).status, 400);
  const man = await call('/admin/attendance/logs', { method: 'POST', cookie: hr, body: { employee_id: e1.data.id, kind: 'OUT', date: '2026-10-05', time: '17:30', reason: 'kiosk down' } });
  assert.equal(man.status, 201);
  assert.equal(man.data.source, 'MANUAL');
  assert.equal(man.data.created_by, 'hr.clerk');
  assert.equal((await call(`/admin/attendance/logs/${man.data.id}/void`, { method: 'POST', cookie: hr, body: {} })).status, 400);
  const voided = await call(`/admin/attendance/logs/${man.data.id}/void`, { method: 'POST', cookie: hr, body: { reason: 'wrong date' } });
  assert.equal(voided.data.voided, true);
  assert.equal(voided.data.void_reason, 'WRONG DATE');

  // DTR for October 2026 built from back-dated entries
  const ins = async (empId, kind, date, time, source = 'MANUAL') =>
    db.query("INSERT INTO attendance_logs (employee_id, kind, logged_at, source, reason) VALUES ($1, $2, $3, $4, 'TEST')", [
      empId, kind, u.localDateTime(date, time).toISOString(), source,
    ]);
  // Juan: Oct 1 late 8:12, out 17:00; Oct 2 on time with lunch out/in, left 16:30 (30 min undertime); Oct 3 no time-out
  await ins(e1.data.id, 'IN', '2026-10-01', '08:12', 'KIOSK');
  await ins(e1.data.id, 'OUT', '2026-10-01', '17:00', 'KIOSK');
  await ins(e1.data.id, 'IN', '2026-10-02', '07:55', 'KIOSK');
  await ins(e1.data.id, 'OUT', '2026-10-02', '12:01', 'KIOSK');
  await ins(e1.data.id, 'IN', '2026-10-02', '12:58', 'KIOSK');
  await ins(e1.data.id, 'OUT', '2026-10-02', '16:30', 'KIOSK');
  await ins(e1.data.id, 'IN', '2026-10-05', '07:50', 'KIOSK');
  // Ana: night shift 22:00 Oct 1 to 06:05 Oct 2 counts for Oct 1
  await ins(e2.data.id, 'IN', '2026-10-01', '21:50', 'KIOSK');
  await ins(e2.data.id, 'OUT', '2026-10-02', '06:05', 'KIOSK');
  // Ana: last day of September night shift ending Oct 1 belongs to September
  await ins(e2.data.id, 'IN', '2026-09-30', '22:20', 'KIOSK');
  await ins(e2.data.id, 'OUT', '2026-10-01', '06:00', 'KIOSK');

  const dtr = (await call(`/admin/attendance/dtr?month=2026-10&employee_id=${e1.data.id}`, { cookie: hr })).data;
  const d = (n) => dtr.rows[0].days[n - 1];
  assert.equal(dtr.rows[0].days.length, 31);
  assert.deepEqual([d(1).am_in, d(1).pm_out, d(1).late, d(1).undertime], ['08:12', '17:00', 12, 0]);
  assert.deepEqual([d(2).am_in, d(2).am_out, d(2).pm_in, d(2).pm_out, d(2).late, d(2).undertime], ['07:55', '12:01', '12:58', '16:30', 0, 30]);
  assert.equal(d(3).remarks, 'SATURDAY');
  assert.match(d(5).remarks, /No time-out/);
  assert.equal(d(5).am_in, '07:50');
  assert.deepEqual(
    [dtr.rows[0].totals.days_present, dtr.rows[0].totals.late_count, dtr.rows[0].totals.late, dtr.rows[0].totals.undertime, dtr.rows[0].totals.missing],
    [3, 1, 12, 30, 1],
  );
  const ana = (await call(`/admin/attendance/dtr?month=2026-10&employee_id=${e2.data.id}`, { cookie: hr })).data.rows[0];
  assert.deepEqual([ana.days[0].pm_in, ana.days[0].pm_out, ana.days[0].late, ana.days[0].undertime], ['21:50', '06:05+1', 0, 0]);
  assert.equal(ana.days[0].worked, 8 * 60 + 15);
  assert.equal(ana.days[1].am_in, ''); // the 06:05 time-out is not a new day
  const sep = (await call(`/admin/attendance/dtr?month=2026-09&employee_id=${e2.data.id}`, { cookie: hr })).data.rows[0];
  assert.deepEqual([sep.days[29].pm_in, sep.days[29].pm_out, sep.days[29].late], ['22:20', '06:00+1', 20]);

  // Monthly summary CSV
  const csv = await fetch(`${base}/admin/attendance/summary.csv?month=2026-10`, { headers: { Cookie: hr } });
  assert.match(csv.headers.get('content-disposition'), /ZRMC-attendance-2026-10\.csv/);
  const lines = (await csv.text()).replace(/^﻿/, '').trim().split('\r\n');
  assert.match(lines[0], /^Employee No\.,Last Name/);
  assert.match(lines.find((l) => l.startsWith('2023-0001')), /,08:00-17:00,3,1,12,30,1,/);
  assert.match(lines.find((l) => l.startsWith('2023-0004')), /"LIM, JR\."/);

  // Removing a kiosk stops it working
  const kiosks = (await call('/admin/attendance/kiosks', { cookie: hr })).data.rows;
  assert.equal(kiosks[0].created_by, 'hr.clerk');
  await call(`/admin/attendance/kiosks/${kiosks[0].id}`, { method: 'PATCH', cookie: hr, body: { active: false } });
  assert.equal((await punch({ employee_no: '2023-0001', pin: '4321', kind: 'OUT' })).status, 401);

  // Old kiosk photos are purged
  assert.equal(await att.purgeAttendancePhotos(db, new Date(Date.now() + 91 * 86400e3)), 3);
});

test('mobile normalisation', () => {
  assert.equal(u.normalizeMobile('0917-123-4567'), '+639171234567');
  assert.equal(u.normalizeMobile('639171234567'), '+639171234567');
  assert.equal(u.normalizeMobile('12345'), null);
});
