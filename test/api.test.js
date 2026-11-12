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

test('automatic ID check (OCR text) against the patient details', async () => {
  const m = require('../public/js/idmatch');
  const p = { last: 'Dela Cruz', first: 'Juan', middle: 'Santos', birthdate: '1990-05-14' };
  const philsys = 'REPUBLIKA NG PILIPINAS Philippine Identification Card Apelyido/Last Name DELA CRUZ Mga Pangalan/Given Names JUAN Gitnang Apelyido/Middle Name SANTOS Petsa ng Kapanganakan/Date of Birth MAY 14, 1990';
  assert.equal(m.check(philsys, p).status, 'MATCH');
  // Driver's license: joined surname, OCR reads O as 0, numeric dates incl. expiry
  const lto = 'LAND TRANSPORTATION OFFICE DRIVERS LICENSE Last Name. First Name. Middle Name DELACRUZ, JUAN SANT0S Date of Birth 1990/05/14 Expiration Date 2031/05/14';
  assert.equal(m.check(lto, p).status, 'MATCH');
  assert.deepEqual(m.findDates(lto), ['1990-05-14', '2031-05-14']);
  assert.deepEqual(m.findDates('BIRTH 14 MAY 1990 / 05-14-1990 / 1990 MAY 14'), ['1990-05-14']);
  // One wrong letter in a long name is tolerated; a different name is not
  assert.equal(m.check(philsys.replace('JUAN', 'JUAM').replace('DELA CRUZ', 'DELA CRUS'), { ...p, first: 'Juan' }).found.last, true);
  const other = m.check('UNIFIED MULTI-PURPOSE ID SURNAME REYES GIVEN NAME ANA MIDDLE NAME LOPEZ DATE OF BIRTH 1985/02/03', p);
  assert.equal(other.status, 'MISMATCH');
  assert.deepEqual(other.notes.slice(0, 2), ['Last name "DELA CRUZ" was not found on the ID.', 'First name "JUAN" was not found on the ID.']);
  assert.match(other.notes[3], /Birthdate May 14, 1990 was not found on the ID\. Date read on the ID: February 3, 1985\./);
  const wrongDob = m.check('POSTAL IDENTITY CARD DELA CRUZ JUAN SANTOS 15 MAY 1990 VALID UNTIL 12/31/2027', p);
  assert.equal(wrongDob.status, 'PARTIAL');
  assert.deepEqual(wrongDob.notes, ['Birthdate May 14, 1990 was not found on the ID. Date read on the ID: May 15, 1990.']);
  assert.equal(m.check('ab 12 x', p).status, 'UNREADABLE');
  // Accents and Ñ
  assert.equal(m.check('PHILIPPINE PASSPORT SURNAME PENA GIVEN NAMES JOSE MARIA DATE OF BIRTH 02 JAN 1980', { last: 'Peña', first: 'José María', birthdate: '1980-01-02' }).status, 'MATCH');

  // Stored with the request, recomputed by the server from the text
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const body = {
    ...patient,
    patient_middle: 'santos',
    requester_name: 'Juan Dela Cruz',
    requester_relation: 'Self (patient)',
    email: 'juan@example.com',
    purpose: 'Insurance claim',
    items: [{ record_type: 'MEDICAL_CERTIFICATE' }],
    copy_type: 'DIGITAL',
    id_photo: png,
    selfie_photo: png,
    receipt_photo: png,
  };
  let res = await call('/records', { method: 'POST', body: { ...body, id_ocr_text: 'POSTAL IDENTITY CARD DELA CRUZ JUAN SANTOS 15 MAY 1990 VALID UNTIL 12/31/2027' } });
  assert.equal(res.status, 201);
  const ref = res.data.ref_no;
  let row = await db.one('SELECT * FROM record_requests WHERE ref_no = $1', [ref]);
  assert.equal(row.id_ocr_status, 'PARTIAL');
  assert.deepEqual(JSON.parse(row.id_ocr_notes), ['Birthdate May 14, 1990 was not found on the ID. Date read on the ID: May 15, 1990.']);
  assert.equal(row.id_ocr_by, null);
  // No text (OCR not available on the phone): not checked
  res = await call('/records', { method: 'POST', body });
  assert.equal((await db.one('SELECT id_ocr_status FROM record_requests WHERE ref_no = $1', [res.data.ref_no])).id_ocr_status, null);

  // Staff list shows the result; staff re-check with their own OCR
  const admin = await login();
  const listed = (await call(`/admin/records?q=${ref}`, { cookie: admin })).data.rows.find((r) => r.ref_no === ref);
  assert.equal(listed.id_ocr_status, 'PARTIAL');
  assert.match(listed.id_ocr_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal((await call(`/admin/records/${row.id}/id-ocr`, { method: 'POST', cookie: admin, body: { text: '' } })).status, 400);
  res = await call(`/admin/records/${row.id}/id-ocr`, { method: 'POST', cookie: admin, body: { text: philsys } });
  assert.equal(res.data.id_ocr_status, 'MATCH');
  assert.equal(res.data.id_ocr_by, 'admin');
  const opd = (await loginAs('opd.x', 'password123')).cookie;
  assert.equal((await call(`/admin/records/${row.id}/id-ocr`, { method: 'POST', cookie: opd, body: { text: philsys } })).status, 403);

  // Track page: check a new ID before re-uploading (nothing saved), then the upload replaces the result
  assert.equal((await call('/track/id-check', { method: 'POST', body: { ref_no: ref, mobile: '00000000000', text: philsys } })).status, 404);
  const pre = (await call('/track/id-check', { method: 'POST', body: { ref_no: ref, mobile: '09171234567', text: 'SURNAME REYES GIVEN NAME ANA MIDDLE NAME LOPEZ DATE OF BIRTH 1985/02/03' } })).data;
  assert.equal(pre.status, 'MISMATCH');
  assert.equal((await db.one('SELECT id_ocr_status FROM record_requests WHERE id = $1', [row.id])).id_ocr_status, 'MATCH');
  await call(`/admin/records/${row.id}/verify-id`, { method: 'POST', cookie: admin, body: { decision: 'REJECTED', remarks: 'ID does not match' } });
  res = await call('/track/id-photos', { method: 'POST', body: { ref_no: ref, mobile: '09171234567', id_photo: png, selfie_photo: png, receipt_photo: png, id_ocr_text: lto } });
  row = await db.one('SELECT * FROM record_requests WHERE id = $1', [row.id]);
  assert.equal(row.id_ocr_status, 'MATCH');
  assert.equal(row.id_ocr_by, null);

  // The text read from the ID is deleted with the photos
  await db.query("UPDATE record_requests SET status = 'CANCELLED' WHERE id = $1", [row.id]);
  const { purgeIdPhotos } = require('../src/idphotos');
  await purgeIdPhotos(db, new Date(Date.now() + 31 * 86400e3));
  row = await db.one('SELECT * FROM record_requests WHERE id = $1', [row.id]);
  assert.equal(row.id_ocr_text, null);
  assert.equal(row.id_ocr_status, 'MATCH'); // the result stays for the record
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

test('flag ceremony: geofence check-in, PINs, one phone per employee, excuses and summary', async () => {
  const admin = await login();
  const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const VENUE = { lat: 6.9076, lng: 122.079 };
  const today = u.todayStr();

  // A browser-like cookie jar per phone
  const phone = () => {
    const jar = new Map();
    return async (path, { method = 'GET', body } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const c of res.headers.getSetCookie()) {
        const [kv, ...attrs] = c.split(';');
        const [k, v] = kv.split('=');
        if (attrs.some((a) => /max-age=0$/i.test(a.trim()))) jar.delete(k);
        else jar.set(k, v);
      }
      return { status: res.status, data: await res.json() };
    };
  };

  // Staff with only Flag Ceremony access, and someone without it
  const created = await call('/admin/users', {
    method: 'POST', cookie: admin,
    body: { username: 'hr.clerk', full_name: 'hr clerk', password: 'password123', role: 'STAFF', can_records: false, can_opd: false, can_attendance: true },
  });
  assert.equal(created.status, 201);
  const hr = (await call('/admin/login', { method: 'POST', body: { username: 'hr.clerk', password: 'password123' } })).headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await call('/admin/me', { cookie: hr })).data.access, { records: false, opd: false, referrals: false, attendance: true });
  assert.equal((await call('/admin/records', { cookie: hr })).status, 403);
  await call('/admin/users', { method: 'POST', cookie: admin, body: { username: 'opd.only', full_name: 'opd', password: 'password123', role: 'STAFF', can_records: false } });
  const opd = (await call('/admin/login', { method: 'POST', body: { username: 'opd.only', password: 'password123' } })).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/admin/flag/employees', { cookie: opd })).status, 403);
  assert.equal((await call('/admin/flag/options', { cookie: opd })).status, 403);

  // Not set up yet: no geofence, no ceremonies
  assert.equal((await call('/flag/me')).data.ready, false);
  const opts = (await call('/admin/flag/options', { cookie: hr })).data;
  assert.equal(opts.ready, false);
  assert.equal(opts.settings.schedule[0].weekday, 1);
  assert.equal((await call(`/admin/flag/ceremonies?month=${today.slice(0, 7)}`, { cookie: hr })).data.rows.length, 0);

  // Settings
  const settings = { venue: 'zrmc flagpole', lat: VENUE.lat, lng: VENUE.lng, radius_m: 150, max_accuracy_m: 100, require_selfie: false, schedule: opts.settings.schedule };
  const put = (b) => call('/admin/flag/settings', { method: 'PUT', cookie: hr, body: { ...settings, ...b } });
  assert.equal((await put({ radius_m: 5 })).status, 400);
  assert.equal((await put({ lat: 95 })).status, 400);
  assert.equal((await put({ lng: '' })).status, 400);
  assert.equal((await put({ schedule: [{ weekday: 1, title: 'x', opens: '08:00', starts: '07:00', closes: '09:00' }] })).status, 400);
  const saved = await put({});
  assert.equal(saved.status, 200);
  assert.equal(saved.data.ready, true);
  assert.equal(saved.data.settings.venue, 'ZRMC FLAGPOLE');
  assert.equal(saved.data.settings.active_from, today);

  // Weekly ceremonies appear from today on, on Mondays
  const month = (await call(`/admin/flag/ceremonies?month=${today.slice(0, 7)}`, { cookie: hr })).data;
  assert.ok(month.rows.every((c) => c.date >= today && u.dayOfWeek(c.date) === 1 && c.title === 'FLAG RAISING CEREMONY' && c.starts === '08:00'));

  // Employees
  const addEmp = (body) => call('/admin/flag/employees', { method: 'POST', cookie: hr, body });
  assert.equal((await addEmp({ employee_no: '2023-0001', last_name: 'dela cruz', first_name: 'juan', pin: '1234' })).status, 400); // 6 digits
  const e1 = await addEmp({ employee_no: '2023-0001', last_name: 'dela cruz', first_name: 'juan', middle_name: 'santos', division: 'nursing service', unit: 'emergency room', pin: '123456' });
  assert.equal(e1.status, 201);
  assert.equal(e1.data.pin, '123456');
  assert.equal(e1.data.flag_required, true);
  assert.equal(e1.data.division, 'NURSING'); // "nursing service" is read as the NURSING division
  assert.match((await addEmp({ employee_no: '2023-0099', last_name: 'x', first_name: 'y', division: 'radiology' })).data.error, /Division must be one of: ADMINISTRATIVE, FINANCE, MEDICAL, NURSING, OMCC/);
  assert.equal((await addEmp({ employee_no: '2023-0098', last_name: 'x', first_name: 'y', division: 'office of the medical center chief' })).data.division, 'OMCC');
  await db.query("DELETE FROM employees WHERE employee_no = '2023-0098'");
  assert.equal(e1.data.unit, 'EMERGENCY ROOM');
  assert.equal((await addEmp({ employee_no: '2023-0001', last_name: 'x', first_name: 'y' })).status, 400);
  const imp = await call('/admin/flag/employees/import', {
    method: 'POST', cookie: hr,
    body: { csv: 'Employee No,Last,First,Middle,Position,Division,Unit\n2023-0002,Reyes,Ana,,Nurse II,Nursing Service,Pediatrics\n"2023-0003","Santos","Maria Clara","","Clerk","Medical Service","HHIMS"\n' },
  });
  assert.equal(imp.status, 201);
  assert.equal(imp.data.rows.length, 2);
  assert.match(imp.data.rows[0].pin, /^\d{6}$/);
  assert.equal(imp.data.rows[1].name, 'SANTOS, MARIA CLARA');
  assert.deepEqual([imp.data.rows[1].division, imp.data.rows[1].unit], ['MEDICAL', 'HHIMS']);
  const optsAfter = (await call('/admin/flag/options', { cookie: hr })).data;
  assert.deepEqual(optsAfter.division_choices, ['ADMINISTRATIVE', 'FINANCE', 'MEDICAL', 'NURSING', 'OMCC']);
  assert.deepEqual(optsAfter.divisions, optsAfter.division_choices);
  assert.deepEqual(optsAfter.units, ['EMERGENCY ROOM', 'HHIMS', 'PEDIATRICS']);
  assert.equal((await call('/admin/flag/employees?division=NURSING', { cookie: hr })).data.rows.length, 2);
  assert.equal((await call('/admin/flag/employees?q=pediatrics', { cookie: hr })).data.rows[0].employee_no, '2023-0002');
  assert.equal((await call('/admin/flag/employees/import', { method: 'POST', cookie: hr, body: { csv: '2023-0009,A,B\n2023-0001,C,D' } })).status, 400);
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM employees WHERE employee_no = '2023-0009'")).n, 0);
  const [ana, maria] = imp.data.rows;
  // A division saved before the dropdown existed stays when other details are edited, but can't be typed in anew
  await db.query("UPDATE employees SET department = 'ANCILLARY' WHERE id = $1", [maria.id]);
  assert.equal((await call(`/admin/flag/employees/${maria.id}`, { method: 'PATCH', cookie: hr, body: { position: 'clerk ii', division: 'ANCILLARY' } })).data.division, 'ANCILLARY');
  assert.ok((await call('/admin/flag/options', { cookie: hr })).data.divisions.includes('ANCILLARY')); // still filterable
  assert.equal((await call(`/admin/flag/employees/${ana.id}`, { method: 'PATCH', cookie: hr, body: { division: 'ANCILLARY' } })).status, 400);
  await call(`/admin/flag/employees/${maria.id}`, { method: 'PATCH', cookie: hr, body: { division: 'medical' } });

  // Sign-in, wrong PINs and lockout
  const p1 = phone();
  assert.equal((await p1('/flag/me')).data.employee, null);
  assert.equal((await p1('/flag/login', { method: 'POST', body: { employee_no: '2023-0001', pin: '000000' } })).status, 401);
  assert.equal((await p1('/flag/login', { method: 'POST', body: { employee_no: 'nobody', pin: '123456' } })).status, 401);
  const p2 = phone();
  for (let i = 0; i < 5; i++) assert.equal((await p2('/flag/login', { method: 'POST', body: { employee_no: ana.employee_no, pin: '999999' } })).status, ana.pin === '999999' ? 200 : 401);
  assert.equal((await p2('/flag/login', { method: 'POST', body: { employee_no: ana.employee_no, pin: ana.pin } })).status, 423);
  assert.equal((await call('/admin/flag/employees?q=reyes', { cookie: hr })).data.rows[0].locked, true);
  const reset = await call(`/admin/flag/employees/${ana.id}/pin`, { method: 'POST', cookie: hr, body: {} });
  assert.match(reset.data.pin, /^\d{6}$/);
  assert.equal((await p2('/flag/login', { method: 'POST', body: { employee_no: ana.employee_no, pin: reset.data.pin } })).status, 200);
  assert.equal((await p1('/flag/login', { method: 'POST', body: { employee_no: '2023-0001', pin: '123456' } })).status, 200);
  const me1 = (await p1('/flag/me')).data;
  assert.equal(me1.employee.name, 'DELA CRUZ, JUAN S.');
  assert.deepEqual(me1.center, VENUE);

  // A special ceremony open now (check-in 00:00–23:59, starts 23:58: on time)
  const addCer = (body) => call('/admin/flag/ceremonies', { method: 'POST', cookie: hr, body });
  assert.equal((await addCer({ date: u.addDays(today, -1), title: 'x', opens: '07:00', starts: '08:00', closes: '09:00' })).status, 400);
  assert.equal((await addCer({ date: today, title: 'x', opens: '09:00', starts: '08:00', closes: '10:00' })).status, 400);
  const open = (await addCer({ date: today, title: 'special flag raising', opens: '00:00', starts: '23:58', closes: '23:59' })).data;
  assert.equal(open.phase, 'OPEN');
  assert.equal(open.title, 'SPECIAL FLAG RAISING');
  const todayList = (await p1('/flag/me')).data.today_ceremonies;
  assert.ok(todayList.some((c) => c.id === open.id && c.phase === 'OPEN' && !c.mine));

  const checkin = (p, id, loc, extra = {}) => p('/flag/checkin', { method: 'POST', body: { ceremony_id: id, ...loc, ...extra } });
  const here = { lat: VENUE.lat + 0.0003, lng: VENUE.lng, accuracy: 15 }; // about 33 m away
  assert.equal((await phone()('/flag/checkin', { method: 'POST', body: { ceremony_id: open.id, ...here } })).status, 401); // not signed in
  const far = await checkin(p1, open.id, { lat: VENUE.lat + 0.01, lng: VENUE.lng, accuracy: 10 });
  assert.equal(far.status, 422);
  assert.match(far.data.error, /1,112 m from the ceremony venue/);
  const fuzzy = await checkin(p1, open.id, { ...here, accuracy: 500 });
  assert.equal(fuzzy.status, 422);
  assert.match(fuzzy.data.error, /not precise enough/);
  assert.equal((await checkin(p1, open.id, {})).status, 422);
  const ok = await checkin(p1, open.id, here);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.mine.status, 'ON_TIME');
  const again = await checkin(p1, open.id, here);
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  const row = await db.one('SELECT * FROM flag_checkins WHERE ceremony_id = $1 AND employee_id = $2', [open.id, e1.data.id]);
  assert.equal(row.source, 'GPS');
  assert.equal(row.distance_m, 33);
  assert.equal(row.accuracy_m, 15);

  // The same phone cannot check in a second employee for the same ceremony
  await p1('/flag/logout', { method: 'POST' });
  assert.equal((await p1('/flag/me')).data.employee, null);
  assert.equal((await p1('/flag/login', { method: 'POST', body: { employee_no: maria.employee_no, pin: maria.pin } })).status, 200);
  const buddy = await checkin(p1, open.id, here);
  assert.equal(buddy.status, 409);
  assert.match(buddy.data.error, /already used to check in employee no\. 2023-0001/);
  // Ana on her own phone is fine
  assert.equal((await checkin(p2, open.id, here)).status, 201);

  // No "late": checking in after the start time (check-in still open) is present
  const lateCer = (await addCer({ date: today, title: 'after start test', opens: '00:00', starts: '00:00', closes: '23:59' })).data;
  const afterStart = await checkin(p1, lateCer.id, here);
  assert.equal(afterStart.data.mine.status, 'ON_TIME');
  assert.equal(afterStart.data.mine.label, 'Present');

  // Selfie required
  assert.equal((await put({ require_selfie: true })).status, 200);
  const selfieCer = (await addCer({ date: today, title: 'selfie test', opens: '00:00', starts: '23:58', closes: '23:59' })).data;
  assert.equal((await checkin(p2, selfieCer.id, here)).status, 400);
  assert.equal((await checkin(p2, selfieCer.id, here, { photo: 'data:image/png;base64,AAAA' })).status, 400);
  const withSelfie = await checkin(p2, selfieCer.id, here, { photo: PHOTO });
  assert.equal(withSelfie.status, 201);
  assert.equal((await put({ require_selfie: false })).status, 200);

  // Not open yet, cancelled
  const tomorrow = (await addCer({ date: u.addDays(today, 1), title: 'tomorrow', opens: '07:00', starts: '08:00', closes: '09:00' })).data;
  assert.equal(tomorrow.phase, 'UPCOMING');
  const early = await checkin(p2, tomorrow.id, here);
  assert.equal(early.status, 409);
  assert.match(early.data.error, /Check-in opens at 7:00 AM on/);
  assert.equal((await call(`/admin/flag/ceremonies/${tomorrow.id}`, { method: 'PATCH', cookie: hr, body: { cancelled: true } })).status, 400); // reason needed
  assert.equal((await call(`/admin/flag/ceremonies/${tomorrow.id}`, { method: 'PATCH', cookie: hr, body: { cancelled: true, cancel_reason: 'holiday' } })).data.phase, 'CANCELLED');
  assert.match((await checkin(p2, tomorrow.id, here)).data.error, /cancelled: HOLIDAY/);
  assert.equal((await call(`/admin/flag/ceremonies/${tomorrow.id}`, { method: 'PATCH', cookie: hr, body: { cancelled: false } })).data.phase, 'UPCOMING');
  // Only excuses before a ceremony
  assert.equal((await call(`/admin/flag/ceremonies/${tomorrow.id}/mark`, { method: 'POST', cookie: hr, body: { employee_id: ana.id, status: 'ON_TIME', remarks: 'x' } })).status, 400);
  assert.equal((await call(`/admin/flag/ceremonies/${tomorrow.id}/mark`, { method: 'POST', cookie: hr, body: { employee_id: ana.id, status: 'EXCUSED', remarks: 'approved leave' } })).status, 200);
  const nextForAna = (await p2('/flag/me')).data.next.find((c) => c.id === tomorrow.id);
  assert.equal(nextForAna.mine.status, 'EXCUSED');

  // A ceremony that has closed (last week): absent, excused, marked present by staff
  const past = u.addDays(today, -7);
  const closed = await db.one(
    "INSERT INTO flag_ceremonies (ceremony_date, slot, title, opens_at, starts_at, closes_at, source) VALUES ($1, 'M-test', 'PAST CEREMONY', '07:00', '08:00', '09:00', 'MANUAL') RETURNING id",
    [past],
  );
  await db.query("UPDATE employees SET created_at = now() - interval '30 days'");
  assert.match((await checkin(p1, closed.id, here)).data.error, /Check-in closed at 9:00 AM/);
  const mark = (body) => call(`/admin/flag/ceremonies/${closed.id}/mark`, { method: 'POST', cookie: hr, body });
  assert.equal((await mark({ employee_id: ana.id, status: 'EXCUSED' })).status, 400); // reason needed
  assert.equal((await mark({ employee_id: ana.id, status: 'EXCUSED', remarks: 'on duty at er' })).status, 200);
  assert.equal((await mark({ employee_id: maria.id, status: 'ON_TIME', remarks: 'gps not working, seen by hr' })).status, 200);
  let roster = (await call(`/admin/flag/ceremonies/${closed.id}`, { cookie: hr })).data;
  const st = (id) => roster.rows.find((r) => r.id === id);
  assert.equal(st(e1.data.id).status, 'ABSENT');
  assert.equal(st(ana.id).status, 'EXCUSED');
  assert.equal(st(ana.id).remarks, 'ON DUTY AT ER');
  assert.equal(st(maria.id).status, 'ON_TIME');
  assert.equal(st(maria.id).source, 'MANUAL');
  assert.equal(st(maria.id).time, '08:00');
  assert.equal(st(maria.id).marked_by, 'hr.clerk');
  // Staff entries can be cleared; phone check-ins cannot
  assert.equal((await mark({ employee_id: maria.id, status: 'CLEAR' })).status, 200);
  roster = (await call(`/admin/flag/ceremonies/${closed.id}`, { cookie: hr })).data;
  assert.equal(st(maria.id).status, 'ABSENT');
  assert.equal((await call(`/admin/flag/ceremonies/${open.id}/mark`, { method: 'POST', cookie: hr, body: { employee_id: e1.data.id, status: 'CLEAR' } })).status, 400);

  // Today's roster shows phone check-ins with distance and the selfie
  const todayRoster = (await call(`/admin/flag/ceremonies/${selfieCer.id}`, { cookie: hr })).data;
  const anaToday = todayRoster.rows.find((r) => r.id === ana.id);
  assert.equal(anaToday.source, 'GPS');
  assert.equal(anaToday.distance_m, 33);
  assert.equal(anaToday.has_photo, true);
  assert.equal(todayRoster.rows.find((r) => r.id === maria.id).status, 'NOT_YET');
  const photo = await fetch(`${base}/admin/flag/checkins/${anaToday.checkin_id}/photo`, { headers: { Cookie: hr } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/admin/flag/checkins/${anaToday.checkin_id}/photo`, { headers: { Cookie: opd } })).status, 403);

  // Month list counts
  const list = (await call(`/admin/flag/ceremonies?month=${past.slice(0, 7)}`, { cookie: hr })).data;
  const pastRow = list.rows.find((c) => c.id === closed.id);
  assert.equal(pastRow.excused, 1);
  assert.equal(pastRow.absent, 2);

  // CSV
  const csv = await fetch(`${base}/admin/flag/ceremonies/${closed.id}/export.csv`, { headers: { Cookie: hr } });
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM so Excel reads UTF-8
  const csvText = csvBytes.toString('utf8');
  assert.match(csvText, /Date,Ceremony,Employee No\./);
  assert.match(csvText, /2023-0002,REYES,ANA,,NURSE II,NURSING,PEDIATRICS,Excused,,STAFF \(hr\.clerk\),,ON DUTY AT ER/);

  // Summary over the closed ceremony only (today's are still open)
  const sum = (await call(`/admin/flag/summary?from=${past}&to=${today}`, { cookie: hr })).data;
  assert.equal(sum.ceremonies >= 1, true);
  const juanSum = sum.rows.find((r) => r.employee.id === e1.data.id);
  const anaSum = sum.rows.find((r) => r.employee.id === ana.id);
  const closedHeld = sum.ceremonies;
  assert.equal(juanSum.held, closedHeld);
  assert.equal(anaSum.excused, 1);
  const sumCsv = await (await fetch(`${base}/admin/flag/summary.csv?from=${past}&to=${today}`, { headers: { Cookie: hr } })).text();
  assert.match(sumCsv, /Attendance %/);

  // Staff can only mark present or excused; there is no late
  assert.equal((await call(`/admin/flag/ceremonies/${lateCer.id}/mark`, { method: 'POST', cookie: hr, body: { employee_id: ana.id, status: 'LATE', remarks: 'x' } })).status, 400);
  // Old "late" check-ins are turned into present by a one-time update
  await db.query("UPDATE flag_checkins SET status = 'LATE' WHERE ceremony_id = $1", [lateCer.id]);
  await db.query("DELETE FROM schema_migrations WHERE id = '2026-11-12-flag-no-late'");
  await db.tx((t) => require('../src/db').runMigrations(t));
  assert.equal((await db.one('SELECT status FROM flag_checkins WHERE ceremony_id = $1', [lateCer.id])).status, 'ON_TIME');

  // Employee changes their PIN: wrong current PIN, bad new PIN, then OK (this phone stays signed in)
  assert.equal((await p2('/flag/pin', { method: 'POST', body: { pin: '000000', new_pin: '654321' } })).status, 401);
  assert.equal((await p2('/flag/pin', { method: 'POST', body: { pin: reset.data.pin, new_pin: '12' } })).status, 400);
  assert.equal((await p2('/flag/pin', { method: 'POST', body: { pin: reset.data.pin, new_pin: '654321' } })).status, 200);
  assert.equal((await p2('/flag/me')).data.employee.employee_no, '2023-0002');
  assert.equal((await phone()('/flag/login', { method: 'POST', body: { employee_no: '2023-0002', pin: '654321' } })).status, 200);

  // Deactivating signs the employee out of their phone
  assert.equal((await call(`/admin/flag/employees/${ana.id}`, { method: 'PATCH', cookie: hr, body: { active: false } })).data.active, false);
  assert.equal((await p2('/flag/me')).data.employee, null);
  assert.equal((await p2('/flag/login', { method: 'POST', body: { employee_no: '2023-0002', pin: '654321' } })).status, 403);

  // Changing the weekly schedule rebuilds upcoming weekly ceremonies that nobody has checked in to
  await put({ schedule: [{ weekday: 1, title: 'flag raising', opens: '06:30', starts: '07:30', closes: '08:30' }] });
  const nextMonth = u.addDays(today, 35).slice(0, 7);
  const rebuilt = (await call(`/admin/flag/ceremonies?month=${nextMonth}`, { cookie: hr })).data.rows.filter((c) => c.source === 'AUTO');
  assert.ok(rebuilt.length >= 4);
  assert.ok(rebuilt.every((c) => c.starts === '07:30' && c.title === 'FLAG RAISING'));

  // Selfies are purged after the retention period
  const { purgeFlagPhotos } = require('../src/flag');
  assert.equal(await purgeFlagPhotos(db, new Date(Date.now() + 91 * 86400e3)), 1);
});

test('flag ceremony: move a date for a holiday, remarks for bad weather', async () => {
  const admin = await login();
  const today = u.todayStr();
  const flagApi = (path, body, method = 'POST') => call(`/admin/flag${path}`, { method, cookie: admin, body });
  // Runs after the main flag ceremony test: the venue is set up already
  assert.equal((await call('/admin/flag/options', { cookie: admin })).data.ready, true);
  const emp = (await flagApi('/employees', { employee_no: 'MV-0001', last_name: 'cruz', first_name: 'pedro', pin: '246810' })).data;

  // A ceremony next week, with an excuse already recorded
  const d1 = u.addDays(today, 7);
  const d2 = u.addDays(today, 8);
  const cer = (await flagApi('/ceremonies', { date: d1, title: 'holiday test ceremony', opens: '07:00', starts: '08:00', closes: '09:00' })).data;
  assert.equal((await flagApi(`/ceremonies/${cer.id}/mark`, { employee_id: emp.id, status: 'EXCUSED', remarks: 'approved leave' })).status, 200);

  // Validation
  assert.match((await flagApi(`/ceremonies/${cer.id}/move`, { date: d2 })).data.error, /reason/);
  assert.match((await flagApi(`/ceremonies/${cer.id}/move`, { date: d1, reason: 'x' })).data.error, /different date/);
  assert.match((await flagApi(`/ceremonies/${cer.id}/move`, { date: u.addDays(today, -1), reason: 'x' })).data.error, /passed/);
  assert.equal((await flagApi('/ceremonies/999999/move', { date: d2, reason: 'x' })).status, 404);

  // Move it: new date carries the excuse; the old date stays, marked as moved
  const moved = await flagApi(`/ceremonies/${cer.id}/move`, { date: d2, reason: 'holiday: bonifacio day', starts: '08:30', closes: '09:30' });
  assert.equal(moved.status, 201, JSON.stringify(moved.data));
  assert.equal(moved.data.date, d2);
  assert.equal(moved.data.moved_from_date, d1);
  assert.equal(moved.data.starts, '08:30');
  assert.equal(moved.data.opens, '07:00');
  const list = async (date) => (await call(`/admin/flag/ceremonies?month=${date.slice(0, 7)}`, { cookie: admin })).data.rows;
  const old = (await list(d1)).find((c) => c.id === cer.id);
  assert.equal(old.cancelled, true);
  assert.equal(old.moved_to_date, d2);
  assert.equal(old.cancel_reason, 'HOLIDAY: BONIFACIO DAY');
  const roster = (await call(`/admin/flag/ceremonies/${moved.data.id}`, { cookie: admin })).data;
  assert.equal(roster.rows.find((r) => r.id === emp.id).status, 'EXCUSED');
  // The moved-from date cannot be restored or moved again, and a second copy on the same date is refused
  assert.match((await flagApi(`/ceremonies/${cer.id}`, { cancelled: false }, 'PATCH')).data.error, /moved to/);
  assert.match((await flagApi(`/ceremonies/${cer.id}/move`, { date: u.addDays(today, 9), reason: 'x' })).data.error, /already moved/);
  const other = (await flagApi('/ceremonies', { date: u.addDays(today, 10), title: 'holiday test ceremony', opens: '07:00', starts: '08:00', closes: '09:00' })).data;
  assert.match((await flagApi(`/ceremonies/${other.id}/move`, { date: d2, reason: 'x' })).data.error, /already a HOLIDAY TEST CEREMONY/);

  // Employees see the move
  const ph = await call('/flag/login', { method: 'POST', body: { employee_no: 'MV-0001', pin: '246810' } });
  const cookie = ph.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const tryOld = await call('/flag/checkin', { method: 'POST', cookie, body: { ceremony_id: cer.id, lat: 6.9076, lng: 122.079, accuracy: 10 } });
  assert.match(tryOld.data.error, /moved to .*\(HOLIDAY: BONIFACIO DAY\)/);
  const me = (await call('/flag/me', { cookie })).data;
  assert.ok(me.next.some((c) => c.id === moved.data.id && c.moved_from_date === d1));

  // Remarks: on their own (any time) or with the times; blank removes them
  let r = await flagApi(`/ceremonies/${moved.data.id}`, { remarks: 'held at the main lobby due to rain' }, 'PATCH');
  assert.equal(r.data.remarks, 'HELD AT THE MAIN LOBBY DUE TO RAIN');
  assert.equal(r.data.starts, '08:30'); // times untouched
  r = await flagApi(`/ceremonies/${moved.data.id}`, { title: 'holiday test ceremony', opens: '07:00', starts: '08:00', closes: '09:00', remarks: 'delayed due to rain' }, 'PATCH');
  assert.equal(r.data.remarks, 'DELAYED DUE TO RAIN');
  assert.equal(r.data.starts, '08:00');
  assert.equal((await call('/flag/me', { cookie })).data.next.find((c) => c.id === moved.data.id).remarks, 'DELAYED DUE TO RAIN');
  // A ceremony that already happened can still get remarks
  const past = await db.one(
    "INSERT INTO flag_ceremonies (ceremony_date, slot, title, opens_at, starts_at, closes_at, source) VALUES ($1, 'M-wx', 'PAST WX', '07:00', '08:00', '09:00', 'MANUAL') RETURNING id",
    [u.addDays(today, -3)],
  );
  assert.equal((await flagApi(`/ceremonies/${past.id}`, { remarks: 'shortened due to bad weather' }, 'PATCH')).data.remarks, 'SHORTENED DUE TO BAD WEATHER');
  assert.match((await flagApi(`/ceremonies/${past.id}/move`, { date: d2, reason: 'x' })).data.error, /not started yet/);
  assert.equal((await flagApi(`/ceremonies/${moved.data.id}`, { remarks: '' }, 'PATCH')).data.remarks, null);
});

test('mobile normalisation', () => {
  assert.equal(u.normalizeMobile('0917-123-4567'), '+639171234567');
  assert.equal(u.normalizeMobile('639171234567'), '+639171234567');
  assert.equal(u.normalizeMobile('12345'), null);
});
