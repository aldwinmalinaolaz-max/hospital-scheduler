// Staff panel: referrals from RHUs, barangay health centers and other hospitals.
// Registered on the admin router after sign-in (see routes/admin.js); needs the Referrals permission.
const ref = require('../referrals');
const sched = require('../scheduling');
const clinics = require('../clinics');
const auth = require('../auth');
const { sendSms } = require('../sms');
const { lock } = require('../db');
const u = require('../util');

module.exports = function registerReferralRoutes(router, { db, requireAccess, ValidationError, whereClause }) {
  const can = requireAccess('referrals');

  async function load(id) {
    const r = /^\d+$/.test(String(id)) && (await db.one(`${ref.SELECT} WHERE r.id = $1`, [Number(id)]));
    if (!r) {
      const err = new ValidationError('Referral not found.');
      err.status = 404;
      throw err;
    }
    return r;
  }
  const reload = async (id) => ref.present(db, await load(id));
  const OPEN = ['SENT', 'RECEIVED'];

  // ---------- Inbox ----------

  router.get('/referrals', can, async (req, res) => {
    const conds = [];
    const q = req.query;
    if (q.status === 'OPEN') conds.push(["r.status IN ('SENT','RECEIVED')"]);
    else if (q.status) conds.push(['r.status = ?', String(q.status)]);
    if (q.urgency) conds.push(['r.urgency = ?', String(q.urgency)]);
    if (q.facility_id) conds.push(['r.facility_id = ?', Number(q.facility_id)]);
    if (q.from) conds.push(['r.created_at >= ?::date', String(q.from)]);
    if (q.to) conds.push(["r.created_at < ?::date + interval '1 day'", String(q.to)]);
    if (q.q) {
      const s = `%${String(q.q).trim()}%`;
      conds.push(['(r.ref_no ILIKE ? OR r.patient_last ILIKE ? OR r.patient_first ILIKE ? OR r.working_diagnosis ILIKE ? OR f.name ILIKE ?)', s, s, s, s, s]);
    }
    const { where, params } = whereClause(conds);
    // Emergencies first, then the oldest unanswered
    const rows = await db.query(
      `${ref.SELECT} ${where}
       ORDER BY CASE WHEN r.status IN ('SENT','RECEIVED') THEN 0 ELSE 1 END,
         CASE r.urgency WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, r.created_at DESC
       LIMIT 500`,
      params,
    );
    const open = await db.one("SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE urgency = 'EMERGENCY')::int AS emergency FROM referrals WHERE status IN ('SENT','RECEIVED')");
    res.json({ rows: await Promise.all(rows.map((r) => ref.present(db, r, { attachments: false }))), open });
  });

  router.get('/referrals/options', can, async (req, res) => {
    res.json({
      facilities: await db.query('SELECT id, name, type, active FROM facilities ORDER BY name'),
      departments: await ref.departments(db),
      clinics: (await clinics.listClinics(db)).map(({ code, name }) => ({ code, name })),
      urgency: ref.URGENCY,
      statuses: ref.STATUSES,
      facility_types: ref.FACILITY_TYPES,
      export_columns: ref.EXPORT_COLUMNS.map(([h]) => h),
    });
  });

  // ---------- Export for Bizbox and report ----------

  router.get('/referrals/export.csv', can, async (req, res) => {
    const q = req.query;
    const conds = [["r.status IN ('ACCEPTED','ARRIVED','SEEN')"]];
    if (q.from) conds.push(['r.created_at >= ?::date', String(q.from)]);
    if (q.to) conds.push(["r.created_at < ?::date + interval '1 day'", String(q.to)]);
    if (q.only_new === '1') conds.push(['r.exported_at IS NULL']);
    const { where, params } = whereClause(conds);
    const rows = await db.query(`${ref.SELECT} ${where} ORDER BY r.created_at`, params);
    const csvRows = await Promise.all(rows.map(async (r) => ({ ...r, department_name: await ref.departmentName(db, r.department) })));
    if (rows.length) await db.query('UPDATE referrals SET exported_at = now() WHERE id = ANY($1::int[])', [rows.map((r) => r.id)]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ZRMC-referrals-${u.todayStr()}.csv"`);
    res.end(ref.toCsv(csvRows));
  });

  router.get('/referrals/report', can, async (req, res) => {
    const month = String(req.query.month || u.todayStr().slice(0, 7));
    if (!clinics.validMonth(month)) throw new ValidationError('Invalid month.');
    const range = [`${month}-01`];
    const byFacility = await db.query(
      `SELECT f.name, f.type, COUNT(r.id)::int AS total,
         COUNT(r.id) FILTER (WHERE r.status IN ('ACCEPTED','ARRIVED','SEEN'))::int AS accepted,
         COUNT(r.id) FILTER (WHERE r.status = 'REDIRECTED')::int AS redirected,
         COUNT(r.id) FILTER (WHERE r.urgency = 'EMERGENCY')::int AS emergency
       FROM referrals r JOIN facilities f ON f.id = r.facility_id
       WHERE r.created_at >= $1::date AND r.created_at < $1::date + interval '1 month'
       GROUP BY f.name, f.type ORDER BY total DESC, f.name`,
      range,
    );
    const byDept = await db.query(
      `SELECT department, COUNT(*)::int AS total FROM referrals
       WHERE created_at >= $1::date AND created_at < $1::date + interval '1 month' GROUP BY department ORDER BY total DESC`,
      range,
    );
    const byStatus = await db.query(
      `SELECT status, COUNT(*)::int AS total FROM referrals
       WHERE created_at >= $1::date AND created_at < $1::date + interval '1 month' GROUP BY status`,
      range,
    );
    res.json({
      month,
      by_facility: byFacility.map((f) => ({ ...f, type_label: ref.FACILITY_TYPES[f.type] || f.type })),
      by_department: await Promise.all(byDept.map(async (d) => ({ ...d, name: await ref.departmentName(db, d.department) }))),
      by_status: byStatus.map((s) => ({ ...s, label: ref.STATUSES[s.status] || s.status })),
    });
  });

  // Opening a referral marks it received, so the facility sees that ZRMC has it
  router.get('/referrals/:id', can, async (req, res) => {
    const r = await load(req.params.id);
    if (r.status === 'SENT') {
      await db.query("UPDATE referrals SET status = 'RECEIVED', updated_at = now() WHERE id = $1 AND status = 'SENT'", [r.id]);
    }
    res.json(await reload(r.id));
  });

  router.get('/referrals/:id/attachments/:aid', can, async (req, res) => {
    const a = await db.one('SELECT filename, mime, data FROM referral_attachments WHERE id = $1 AND referral_id = $2', [Number(req.params.aid), Number(req.params.id)]);
    if (!a) return res.status(404).json({ error: 'Attachment not found.' });
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', `inline; filename="${a.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(a.data));
  });

  // ---------- Responding ----------

  async function notifyAccepted(r) {
    const phone = r.facility_phone && u.normalizeMobile(r.facility_phone);
    if (phone) await sendSms(db, { to: phone, message: ref.sms.toFacilityAccepted(r), kind: 'REFERRAL_ACCEPTED', refNo: r.ref_no });
    if (r.mobile) await sendSms(db, { to: r.mobile, message: ref.sms.toPatientAccepted(r), kind: 'REFERRAL_ACCEPTED', refNo: r.ref_no });
  }

  // Accept, optionally booking an OPD slot for the patient right away
  router.post('/referrals/:id/accept', can, async (req, res) => {
    const r = await load(req.params.id);
    if (!OPEN.includes(r.status)) throw new ValidationError('This referral has already been answered.');
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    const book = req.body?.book;
    await db.tx(async (t) => {
      let apptId = null;
      if (book?.clinic) {
        const clinic = await clinics.getClinic(t, book.clinic);
        if (!clinic) throw new ValidationError('Choose an OPD clinic for the appointment.');
        const mobile = r.mobile || (r.facility_phone && u.normalizeMobile(r.facility_phone));
        if (!mobile) throw new ValidationError("To book an appointment, the patient's or the facility's mobile number is needed for reminders.");
        await lock(t, `opd:${clinic.code}:${book.date}`);
        const err = await sched.checkOpdSlot(t, clinic.code, String(book.date || ''), String(book.time || ''));
        if (err) throw new ValidationError(err);
        let apptRef;
        do apptRef = u.makeRef('A');
        while (await t.one('SELECT 1 FROM appointments WHERE ref_no = $1', [apptRef]));
        const appt = await t.one(
          `INSERT INTO appointments (ref_no, department, appt_date, appt_time, patient_type, patient_last, patient_first, patient_middle,
             birthdate, sex, mobile, complaint, remarks, updated_by)
           VALUES ($1, $2, $3, $4, 'NEW', $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [apptRef, clinic.code, book.date, book.time, r.patient_last, r.patient_first, r.patient_middle, r.birthdate, r.sex, mobile,
            r.chief_complaint, `Referral ${r.ref_no} from ${r.facility_name}`, req.user.username],
        );
        apptId = appt.id;
      }
      await t.query(
        `UPDATE referrals SET status = 'ACCEPTED', response_note = $1, appointment_id = $2, responded_by = $3, responded_at = now(), updated_at = now()
         WHERE id = $4`,
        [note, apptId, req.user.username, r.id],
      );
    });
    const after = await reload(r.id);
    if (req.body?.notify !== false) await notifyAccepted(after);
    res.json(after);
  });

  router.post('/referrals/:id/redirect', can, async (req, res) => {
    const r = await load(req.params.id);
    if (!OPEN.includes(r.status)) throw new ValidationError('This referral has already been answered.');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!note) throw new ValidationError('Please give the reason and where the patient should go instead.');
    await db.query(
      `UPDATE referrals SET status = 'REDIRECTED', response_note = $1, responded_by = $2, responded_at = now(), updated_at = now() WHERE id = $3`,
      [note, req.user.username, r.id],
    );
    const after = await reload(r.id);
    const phone = after.facility_phone && u.normalizeMobile(after.facility_phone);
    if (phone && req.body?.notify !== false) {
      await sendSms(db, { to: phone, message: ref.sms.toFacilityRedirected(after), kind: 'REFERRAL_REDIRECTED', refNo: after.ref_no });
    }
    res.json(after);
  });

  router.post('/referrals/:id/arrived', can, async (req, res) => {
    const r = await load(req.params.id);
    if (!['ACCEPTED', 'SENT', 'RECEIVED'].includes(r.status)) throw new ValidationError('Only accepted referrals can be marked as arrived.');
    await db.query(
      `UPDATE referrals SET status = 'ARRIVED', arrived_at = now(), responded_by = COALESCE(responded_by, $1),
         responded_at = COALESCE(responded_at, now()), updated_at = now() WHERE id = $2`,
      [req.user.username, r.id],
    );
    res.json(await reload(r.id));
  });

  // Seen: the feedback goes on the return slip for the referring facility
  router.post('/referrals/:id/seen', can, async (req, res) => {
    const r = await load(req.params.id);
    if (!['ACCEPTED', 'ARRIVED'].includes(r.status)) throw new ValidationError('Mark the patient as arrived first.');
    const feedback = String(req.body?.feedback || '').trim().toUpperCase().slice(0, 3000) || null;
    await db.query(
      "UPDATE referrals SET status = 'SEEN', seen_at = now(), arrived_at = COALESCE(arrived_at, now()), feedback = $1, updated_at = now() WHERE id = $2",
      [feedback, r.id],
    );
    res.json(await reload(r.id));
  });

  // ---------- Facilities and their accounts ----------

  function cleanFacility(b, before = {}) {
    const v = (k) => (b[k] !== undefined ? b[k] : before[k]);
    const name = String(v('name') || '').trim().toUpperCase().slice(0, 150);
    if (!name) throw new ValidationError('Please enter the facility name.');
    const type = String(v('type') || '');
    if (!ref.FACILITY_TYPES[type]) throw new ValidationError('Please choose the facility type.');
    const phone = String(v('phone') || '').trim().slice(0, 30) || null;
    if (phone && !u.normalizeMobile(phone)) throw new ValidationError('Facility mobile number is not valid (it receives SMS when ZRMC responds).');
    return [
      name, type, String(v('municipality') || '').trim().toUpperCase().slice(0, 100) || null,
      String(v('contact_person') || '').trim().toUpperCase().slice(0, 120) || null, phone,
      String(v('email') || '').trim().slice(0, 120) || null, v('active') ?? true,
    ];
  }

  router.get('/facilities', can, async (req, res) => {
    const rows = await db.query(
      `SELECT f.*, (SELECT COUNT(*)::int FROM facility_users fu WHERE fu.facility_id = f.id AND fu.active) AS users,
         (SELECT COUNT(*)::int FROM referrals r WHERE r.facility_id = f.id) AS referrals
       FROM facilities f ORDER BY f.active DESC, f.name`,
    );
    res.json({ rows: rows.map((f) => ({ ...f, type_label: ref.FACILITY_TYPES[f.type] })) });
  });

  router.post('/facilities', can, async (req, res) => {
    const row = await db.one(
      'INSERT INTO facilities (name, type, municipality, contact_person, phone, email, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      cleanFacility(req.body || {}),
    );
    res.status(201).json(row);
  });

  router.patch('/facilities/:id', can, async (req, res) => {
    const before = await db.one('SELECT * FROM facilities WHERE id = $1', [Number(req.params.id)]);
    if (!before) return res.status(404).json({ error: 'Facility not found.' });
    res.json(
      await db.one(
        'UPDATE facilities SET name = $1, type = $2, municipality = $3, contact_person = $4, phone = $5, email = $6, active = $7 WHERE id = $8 RETURNING *',
        [...cleanFacility(req.body || {}, before), before.id],
      ),
    );
  });

  router.get('/facilities/:id/users', can, async (req, res) => {
    const rows = await db.query(
      'SELECT id, username, full_name, active, last_login_at FROM facility_users WHERE facility_id = $1 ORDER BY active DESC, username',
      [Number(req.params.id)],
    );
    res.json({ rows: rows.map((r) => ({ ...r, last_login_at: u.toStamp(r.last_login_at) })) });
  });

  router.post('/facilities/:id/users', can, async (req, res) => {
    const facility = await db.one('SELECT id FROM facilities WHERE id = $1', [Number(req.params.id)]);
    if (!facility) return res.status(404).json({ error: 'Facility not found.' });
    const b = req.body || {};
    const username = String(b.username || '').trim().toLowerCase();
    const fullName = String(b.full_name || '').trim().toUpperCase().slice(0, 120);
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new ValidationError('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
    if (!fullName) throw new ValidationError('Please enter the full name.');
    if (String(b.password || '').length < 8) throw new ValidationError('Password must be at least 8 characters.');
    const taken = (await db.one('SELECT 1 FROM facility_users WHERE lower(username) = $1', [username])) || (await db.one('SELECT 1 FROM admins WHERE lower(username) = $1', [username]));
    if (taken) throw new ValidationError('That username is already taken.');
    const row = await db.one(
      'INSERT INTO facility_users (facility_id, username, full_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, active',
      [facility.id, username, fullName, auth.hashPassword(b.password)],
    );
    res.status(201).json(row);
  });

  router.patch('/facility-users/:id', can, async (req, res) => {
    const before = await db.one('SELECT * FROM facility_users WHERE id = $1', [Number(req.params.id)]);
    if (!before) return res.status(404).json({ error: 'User not found.' });
    const fullName = req.body?.full_name !== undefined ? String(req.body.full_name).trim().toUpperCase().slice(0, 120) : before.full_name;
    const active = req.body?.active ?? before.active;
    const row = await db.one(
      `UPDATE facility_users SET full_name = $1, active = $2,
         session_version = session_version + CASE WHEN $2 <> active THEN 1 ELSE 0 END WHERE id = $3
       RETURNING id, username, full_name, active`,
      [fullName, !!active, before.id],
    );
    res.json(row);
  });

  router.post('/facility-users/:id/password', can, async (req, res) => {
    if (String(req.body?.password || '').length < 8) throw new ValidationError('Password must be at least 8 characters.');
    const row = await db.one(
      'UPDATE facility_users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING id',
      [auth.hashPassword(req.body.password), Number(req.params.id)],
    );
    if (!row) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true });
  });
};
