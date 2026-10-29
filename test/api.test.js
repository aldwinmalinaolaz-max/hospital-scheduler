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
  assert.deepEqual((await call('/admin/me', { cookie: rec })).data.access, { records: true, opd: false });

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
  assert.deepEqual((await call('/admin/me', { cookie: admin })).data.access, { records: true, opd: true });
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

test('mobile normalisation', () => {
  assert.equal(u.normalizeMobile('0917-123-4567'), '+639171234567');
  assert.equal(u.normalizeMobile('639171234567'), '+639171234567');
  assert.equal(u.normalizeMobile('12345'), null);
});
