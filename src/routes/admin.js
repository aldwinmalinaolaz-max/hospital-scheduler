const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const sched = require('../scheduling');
const msg = require('../messages');
const auth = require('../auth');
const { sendSms, checkDelivery } = require('../sms');
const { lock } = require('../db');
const u = require('../util');
const { ValidationError, rateLimit, sendLetter } = require('./public');
const letter = require('../letter');
const faq = require('../faq');
const directory = require('../directory');
const clinics = require('../clinics');
const registerReferralRoutes = require('./adminReferrals');
const registerFlagRoutes = require('./adminFlag');
const payments = require('../payments');
const idphotos = require('../idphotos');
const wayfinding = require('../wayfinding');

const COOKIE = 'hs_admin';

// Builds "WHERE a AND b" with $n placeholders from [sql-with-?, value] pairs
function whereClause(conds) {
  const params = [];
  const parts = conds.map(([sql, ...vals]) =>
    sql.replace(/\?/g, () => {
      params.push(vals.shift());
      return `$${params.length}`;
    }),
  );
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

const stamp = (row) => ({
  ...row,
  created_at: u.toStamp(row.created_at),
  updated_at: u.toStamp(row.updated_at),
  ...(row.id_ocr_at !== undefined ? { id_ocr_at: u.toStamp(row.id_ocr_at) } : {}),
});

module.exports = function adminRoutes(db) {
  const router = express.Router();
  // Image uploads (maps, payment QR) need a larger body limit; see server.js
  const bigJson = express.json({ limit: '6mb' });

  const sessionCookie = (req, user) =>
    `${COOKIE}=${auth.createToken(user.username, user.session_version, config.sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
      auth.SESSION_HOURS * 3600
    }${req.secure ? '; Secure' : ''}`;

  router.post('/login', rateLimit({ windowMs: 10 * 60e3, max: config.loginRateLimit }), async (req, res) => {
    const { username, password } = req.body || {};
    const user = await db.one('SELECT * FROM admins WHERE lower(username) = lower($1)', [String(username || '').trim()]);
    if (!user || !auth.verifyPassword(String(password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.active) return res.status(403).json({ error: 'This account has been deactivated. Please contact an administrator.' });
    await db.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [user.id]);
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    res.json({ username: user.username });
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Everything below requires a signed-in, active user whose session hasn't been revoked
  router.use(async (req, res, next) => {
    const token = auth.readToken(auth.parseCookies(req.headers.cookie)[COOKIE], config.sessionSecret);
    const user = token && (await db.one('SELECT * FROM admins WHERE username = $1', [token.username]));
    if (!user || !user.active || user.session_version !== token.version) return res.status(401).json({ error: 'Please log in.' });
    req.user = user;
    next();
  });

  const adminOnly = (req, res, next) =>
    req.user.role === 'ADMIN' ? next() : res.status(403).json({ error: 'Only administrators can do this.' });

  // Which sections a user may work in. Administrators have everything.
  const access = (user) => ({
    records: user.role === 'ADMIN' || user.can_records,
    opd: user.role === 'ADMIN' || user.can_opd,
    referrals: user.role === 'ADMIN' || user.can_referrals,
    attendance: user.role === 'ADMIN' || user.can_attendance,
    // QR scanning at the venue: Administrators and HR staff only
    flag_scan: user.role === 'ADMIN' || (user.can_attendance && user.can_flag_scan),
  });
  const SECTION_NAMES = { records: 'Records Requests', opd: 'OPD Appointments', referrals: 'Referrals', attendance: 'Flag Ceremony Attendance', flag_scan: 'flag ceremony QR scanning (Administrators and HR only)' };
  const requireAccess = (section) => (req, res, next) =>
    access(req.user)[section] ? next() : res.status(403).json({ error: `You don't have access to ${SECTION_NAMES[section]}.` });

  router.get('/me', (req, res) =>
    res.json({ username: req.user.username, full_name: req.user.full_name, role: req.user.role, access: access(req.user) }),
  );

  router.post('/password', async (req, res) => {
    const { current, next: newPassword } = req.body || {};
    if (!auth.verifyPassword(String(current || ''), req.user.password_hash)) throw new ValidationError('Current password is incorrect.');
    checkPassword(newPassword);
    // Signs out other devices; this one gets a fresh cookie
    const user = await db.one(
      'UPDATE admins SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING *',
      [auth.hashPassword(newPassword), req.user.id],
    );
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    res.json({ ok: true });
  });

  // ---------- Users (administrators only) ----------

  const ROLES = ['ADMIN', 'STAFF'];
  const publicUser = (row) => ({
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    active: row.active,
    can_records: row.can_records,
    can_referrals: row.can_referrals,
    can_attendance: row.can_attendance,
    can_flag_scan: row.can_flag_scan,
    can_opd: row.can_opd,
    last_login_at: row.last_login_at ? u.toStamp(row.last_login_at) : null,
    created_at: u.toStamp(row.created_at),
  });

  // Staff need at least one section; Administrators always get all of them
  function checkAccess(role, canRecords, canOpd, canReferrals = false, canAttendance = false) {
    if (role === 'ADMIN') return { canRecords: true, canOpd: true, canReferrals: true, canAttendance: true };
    if (!canRecords && !canOpd && !canReferrals && !canAttendance) {
      throw new ValidationError('Give the user access to at least one section: Records Requests, OPD Appointments, Referrals or Flag Ceremony Attendance.');
    }
    return { canRecords: !!canRecords, canOpd: !!canOpd, canReferrals: !!canReferrals, canAttendance: !!canAttendance };
  }

  function checkPassword(pw) {
    if (String(pw || '').length < 8) throw new ValidationError('Password must be at least 8 characters.');
  }

  // Refuse changes that would leave nobody able to manage users
  async function ensureAnotherAdmin(t, exceptId) {
    const n = (await t.one("SELECT COUNT(*)::int AS n FROM admins WHERE role = 'ADMIN' AND active AND id <> $1", [exceptId])).n;
    if (!n) throw new ValidationError('There must always be at least one active administrator.');
  }

  router.get('/users', adminOnly, async (req, res) => {
    res.json({ rows: (await db.query('SELECT * FROM admins ORDER BY active DESC, role, username')).map(publicUser) });
  });

  router.post('/users', adminOnly, async (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim().toLowerCase();
    const fullName = String(b.full_name || '').trim().toUpperCase().slice(0, 120);
    const role = String(b.role || 'STAFF');
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new ValidationError('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
    if (!fullName) throw new ValidationError('Please enter the full name.');
    if (!ROLES.includes(role)) throw new ValidationError('Invalid role.');
    checkPassword(b.password);
    const { canRecords, canOpd, canReferrals, canAttendance } = checkAccess(
      role, b.can_records ?? true, b.can_opd ?? true, b.can_referrals ?? false, b.can_attendance ?? false,
    );
    if (await db.one('SELECT 1 FROM admins WHERE lower(username) = $1', [username])) throw new ValidationError('That username is already taken.');
    const user = await db.one(
      `INSERT INTO admins (username, password_hash, full_name, role, can_records, can_opd, can_referrals, can_attendance, can_flag_scan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [username, auth.hashPassword(b.password), fullName, role, canRecords, canOpd, canReferrals, canAttendance, role !== 'ADMIN' && canAttendance && !!b.can_flag_scan],
    );
    res.status(201).json(publicUser(user));
  });

  router.patch('/users/:id', adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const user = await db.tx(async (t) => {
      const before = await t.one('SELECT * FROM admins WHERE id = $1 FOR UPDATE', [id]);
      if (!before) return null;
      const fullName = b.full_name !== undefined ? String(b.full_name).trim().toUpperCase().slice(0, 120) : before.full_name;
      const role = b.role ?? before.role;
      const active = b.active ?? before.active;
      if (!fullName) throw new ValidationError('Please enter the full name.');
      if (!ROLES.includes(role)) throw new ValidationError('Invalid role.');
      if (id === req.user.id && (role !== before.role || active !== before.active)) {
        throw new ValidationError('You cannot change your own role or deactivate your own account.');
      }
      if (before.role === 'ADMIN' && before.active && (role !== 'ADMIN' || !active)) await ensureAnotherAdmin(t, id);
      const { canRecords, canOpd, canReferrals, canAttendance } = checkAccess(
        role, b.can_records ?? before.can_records, b.can_opd ?? before.can_opd, b.can_referrals ?? before.can_referrals,
        b.can_attendance ?? before.can_attendance,
      );
      // Deactivating or changing role signs the user out so it takes effect immediately.
      // (Access changes apply on the user's next request without signing them out.)
      const revoke = role !== before.role || active !== before.active;
      return t.one(
        `UPDATE admins SET full_name = $1, role = $2, active = $3, can_records = $4, can_opd = $5, can_referrals = $8, can_attendance = $9,
          can_flag_scan = $10, session_version = session_version + CASE WHEN $6 THEN 1 ELSE 0 END WHERE id = $7 RETURNING *`,
        [fullName, role, !!active, canRecords, canOpd, revoke, id, canReferrals, canAttendance,
          role !== 'ADMIN' && canAttendance && !!(b.can_flag_scan ?? before.can_flag_scan)],
      );
    });
    if (!user) return res.status(404).json({ error: 'Not found.' });
    res.json(publicUser(user));
  });

  router.post('/users/:id/password', adminOnly, async (req, res) => {
    checkPassword(req.body?.password);
    const user = await db.one(
      'UPDATE admins SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING *',
      [auth.hashPassword(req.body.password), Number(req.params.id)],
    );
    if (!user) return res.status(404).json({ error: 'Not found.' });
    if (user.id === req.user.id) res.setHeader('Set-Cookie', sessionCookie(req, user));
    res.json({ ok: true });
  });

  router.get('/stats', async (req, res) => {
    const today = u.todayStr();
    const s = await db.one(
      `SELECT
        (SELECT COUNT(*)::int FROM appointments WHERE appt_date = $1 AND status <> 'CANCELLED') AS "appointmentsToday",
        (SELECT COUNT(*)::int FROM appointments WHERE appt_date = $1 AND status IN ('CHECKED_IN','COMPLETED')) AS "checkedInToday",
        (SELECT COUNT(*)::int FROM appointments WHERE appt_date > $1 AND status = 'BOOKED') AS "upcomingAppointments",
        (SELECT COUNT(*)::int FROM record_requests WHERE status IN ('PENDING','PROCESSING')) AS "recordsPending",
        (SELECT COUNT(*)::int FROM record_requests WHERE status = 'READY') AS "recordsReady",
        (SELECT COUNT(*)::int FROM record_requests WHERE copy_type = 'DIGITAL' AND id_status = 'PENDING' AND status NOT IN ('CANCELLED','REJECTED')) AS "idsToCheck",
        (SELECT COUNT(*)::int FROM referrals WHERE status IN ('SENT','RECEIVED')) AS "referralsOpen",
        (SELECT COUNT(*)::int FROM referrals WHERE status IN ('SENT','RECEIVED') AND urgency = 'EMERGENCY') AS "referralsEmergency",
        (SELECT COUNT(*)::int FROM record_requests WHERE pickup_date = $1 AND status NOT IN ('CANCELLED','REJECTED')) AS "pickupsToday",
        (SELECT COUNT(*)::int FROM sms_log WHERE status = 'FAILED' AND created_at >= now() - interval '7 days') AS "smsFailed"`,
      [today],
    );
    // Only report numbers for the sections this user can see
    const a = access(req.user);
    const visible = {
      ...(a.opd && { appointmentsToday: s.appointmentsToday, checkedInToday: s.checkedInToday, upcomingAppointments: s.upcomingAppointments }),
      ...(a.referrals && { referralsOpen: s.referralsOpen, referralsEmergency: s.referralsEmergency }),
      ...(a.records && { recordsPending: s.recordsPending, recordsReady: s.recordsReady, pickupsToday: s.pickupsToday, idsToCheck: s.idsToCheck }),
    };
    res.json({ today, ...visible, smsFailed: s.smsFailed, smsProvider: config.sms.provider });
  });

  // ---------- Records ----------

  router.get('/records', requireAccess('records'), async (req, res) => {
    const conds = [];
    if (req.query.status) conds.push(['r.status = ?', String(req.query.status)]);
    if (req.query.pickup_date) conds.push(['r.pickup_date = ?', String(req.query.pickup_date)]);
    if (req.query.type) conds.push(['EXISTS (SELECT 1 FROM record_request_items i WHERE i.request_id = r.id AND i.record_type = ?)', String(req.query.type)]);
    if (req.query.copy_type) conds.push(['r.copy_type = ?', String(req.query.copy_type)]);
    if (req.query.id_status) conds.push(['r.id_status = ?', String(req.query.id_status)]);
    if (req.query.assigned === 'me') conds.push(['r.assigned_to = ?', req.user.username]);
    else if (req.query.assigned === 'none') conds.push(['r.assigned_to IS NULL']);
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      conds.push(['(r.ref_no ILIKE ? OR r.patient_last ILIKE ? OR r.patient_first ILIKE ? OR r.mobile ILIKE ? OR r.hospital_no ILIKE ?)', q, q, q, q, q]);
    }
    const { where, params } = whereClause(conds);
    const rows = await db.query(
      `SELECT r.*, COALESCE((SELECT json_agg(json_build_object('record_type', i.record_type, 'details', i.details, 'copies', i.copies) ORDER BY i.id)
         FROM record_request_items i WHERE i.request_id = r.id), '[]') AS items
       FROM record_requests r ${where} ORDER BY r.pickup_date, r.id LIMIT 500`,
      params,
    );
    res.json({
      rows: rows.map((r) => ({
        ...stamp(r),
        items: r.items.map((i) => ({ ...i, name: catalog.recordType(i.record_type)?.name || i.record_type })),
      })),
    });
  });

  router.get('/records/:id/authorization-letter', requireAccess('records'), async (req, res) => {
    const r = await db.one('SELECT * FROM record_requests WHERE id = $1', [Number(req.params.id)]);
    if (!r || !letter.needsLetter(r)) return res.status(404).json({ error: 'No authorization letter for this request.' });
    const items = await db.query('SELECT record_type, details, copies FROM record_request_items WHERE request_id = $1 ORDER BY id', [r.id]);
    await sendLetter(res, r, items);
  });

  // ----- Digital copies: ID check, assignment, sending by email -----

  // Staff who can be assigned records requests
  router.get('/records-staff', requireAccess('records'), async (req, res) => {
    const rows = await db.query("SELECT username, full_name FROM admins WHERE active AND (role = 'ADMIN' OR can_records) ORDER BY full_name, username");
    res.json({ rows });
  });

  router.get('/records/:id/id-photo/:kind', requireAccess('records'), async (req, res) => {
    const p = await db.one('SELECT image, mime FROM record_id_photos WHERE request_id = $1 AND kind = $2', [
      Number(req.params.id),
      String(req.params.kind).toUpperCase(),
    ]);
    if (!p) return res.status(404).json({ error: 'Photo not found (it may have been deleted after the retention period).' });
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(p.image));
  });

  // Staff re-read the stored ID photo with OCR in their browser; the server compares the text
  router.post('/records/:id/id-ocr', requireAccess('records'), async (req, res) => {
    const r = await db.one('SELECT * FROM record_requests WHERE id = $1', [Number(req.params.id)]);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (r.copy_type !== 'DIGITAL') throw new ValidationError('This request is for a hardcopy; there is no ID photo.');
    const text = String(req.body?.text || '').trim();
    if (!text) throw new ValidationError('No text was read from the ID photo.');
    res.json(stamp(await idphotos.saveOcr(db, r, text, req.user.username)));
  });

  // Approve or reject the requester's valid ID + selfie
  router.post('/records/:id/verify-id', requireAccess('records'), async (req, res) => {
    const decision = String(req.body?.decision || '').toUpperCase();
    const reason = String(req.body?.remarks || '').trim().slice(0, 300) || null;
    if (!['VERIFIED', 'REJECTED'].includes(decision)) throw new ValidationError('Choose Approve or Reject.');
    if (decision === 'REJECTED' && !reason) throw new ValidationError('Please give the reason, so the requester knows what to fix (e.g. "ID photo is blurry").');
    const r = await db.one('SELECT * FROM record_requests WHERE id = $1', [Number(req.params.id)]);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (r.copy_type !== 'DIGITAL') throw new ValidationError('This request is for a hardcopy; there is no ID to verify online.');
    if (['RELEASED', 'REJECTED', 'CANCELLED'].includes(r.status)) throw new ValidationError('This request is already closed.');
    const after = await db.one(
      `UPDATE record_requests SET id_status = $1, id_remarks = $2, id_checked_by = $3, id_checked_at = now(),
         status = CASE WHEN $1 = 'VERIFIED' AND status = 'PENDING' THEN 'PROCESSING' ELSE status END,
         assigned_to = COALESCE(assigned_to, $3), updated_at = now(), updated_by = $3
       WHERE id = $4 RETURNING *`,
      [decision, decision === 'REJECTED' ? reason : null, req.user.username, r.id],
    );
    const message = decision === 'VERIFIED' ? msg.recordIdVerified(after) : msg.recordIdRejected(after);
    await sendSms(db, { to: after.mobile, message, kind: decision === 'VERIFIED' ? 'RECORD_ID_VERIFIED' : 'RECORD_ID_REJECTED', refNo: after.ref_no });
    res.json(stamp(after));
  });

  // The assigned staff member sends the documents from the hospital's email, then marks the request as sent
  router.post('/records/:id/emailed', requireAccess('records'), async (req, res) => {
    const r = await db.one('SELECT * FROM record_requests WHERE id = $1', [Number(req.params.id)]);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (r.copy_type !== 'DIGITAL') throw new ValidationError('This request is for a hardcopy.');
    if (r.id_status !== 'VERIFIED') throw new ValidationError("Verify the requester's ID before sending the documents.");
    if (['REJECTED', 'CANCELLED'].includes(r.status)) throw new ValidationError('This request was rejected or cancelled.');
    const after = await db.one(
      `UPDATE record_requests SET status = 'RELEASED', emailed_at = now(), emailed_by = $1, updated_at = now(), updated_by = $1
       WHERE id = $2 RETURNING *`,
      [req.user.username, r.id],
    );
    if (req.body?.notify !== false) {
      await sendSms(db, { to: after.mobile, message: msg.recordEmailed(after), kind: 'RECORD_EMAILED', refNo: after.ref_no });
    }
    res.json(stamp(after));
  });

  router.patch('/records/:id', requireAccess('records'), async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const before = await db.one('SELECT * FROM record_requests WHERE id = $1', [id]);
    if (!before) return res.status(404).json({ error: 'Not found.' });

    const status = b.status ?? before.status;
    if (!catalog.RECORD_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
    // Digital copies: documents are prepared only after the ID is verified, and released by "Mark as sent"
    if (before.copy_type === 'DIGITAL' && status !== before.status) {
      if (['READY', 'RELEASED'].includes(status) && before.id_status !== 'VERIFIED') {
        throw new ValidationError("Verify the requester's ID first (Verify ID).");
      }
      if (status === 'RELEASED' && !before.emailed_at) throw new ValidationError('Use "Send by email" to release a digital copy.');
    }
    let assigned = before.assigned_to;
    if (b.assigned_to !== undefined) {
      assigned = String(b.assigned_to || '').trim() || null;
      const ok = assigned && (await db.one("SELECT 1 FROM admins WHERE username = $1 AND active AND (role = 'ADMIN' OR can_records)", [assigned]));
      if (assigned && !ok) throw new ValidationError('That staff member cannot be assigned records requests.');
    }
    const remarks = b.remarks !== undefined ? String(b.remarks).trim().slice(0, 500) || null : before.remarks;
    const pickup = b.pickup_date ?? before.pickup_date;
    if (!u.parseDate(pickup)) throw new ValidationError('Invalid pickup date.');
    if (status === 'REJECTED' && !remarks) throw new ValidationError('Please give a reason (remarks) when rejecting a request.');

    const after = await db.one(
      `UPDATE record_requests SET status = $1, remarks = $2, pickup_date = $3, assigned_to = $6,
        reminded_pickup = CASE WHEN $3 <> pickup_date THEN FALSE ELSE reminded_pickup END,
        updated_at = now(), updated_by = $5 WHERE id = $4 RETURNING *`,
      [status, remarks, pickup, id, req.user.username, assigned],
    );

    // Notify on meaningful changes
    if (b.notify !== false) {
      // "Ready for pickup" only applies to hardcopies; digital copies get a text when emailed
      if (status !== before.status && status === 'READY' && after.copy_type === 'HARDCOPY') {
        await sendSms(db, { to: after.mobile, message: msg.recordReady(after), kind: 'RECORD_READY', refNo: after.ref_no });
      } else if (status !== before.status && status === 'REJECTED') {
        await sendSms(db, { to: after.mobile, message: msg.recordRejected(after), kind: 'RECORD_REJECTED', refNo: after.ref_no });
      } else if (pickup !== before.pickup_date) {
        await sendSms(db, { to: after.mobile, message: msg.recordRescheduled(after), kind: 'RECORD_RESCHEDULED', refNo: after.ref_no });
      }
    }
    res.json(stamp(after));
  });

  // ---------- Appointments ----------

  router.get('/appointments', requireAccess('opd'), async (req, res) => {
    const conds = [];
    if (req.query.date) conds.push(['appt_date = ?', String(req.query.date)]);
    if (req.query.department) conds.push(['department = ?', String(req.query.department)]);
    if (req.query.status) conds.push(['status = ?', String(req.query.status)]);
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      conds.push(['(ref_no ILIKE ? OR patient_last ILIKE ? OR patient_first ILIKE ? OR mobile ILIKE ? OR hospital_no ILIKE ?)', q, q, q, q, q]);
    }
    const { where, params } = whereClause(conds);
    const rows = await db.query(`SELECT * FROM appointments ${where} ORDER BY appt_date, appt_time, id LIMIT 500`, params);
    const names = await clinics.clinicNames(db);
    res.json({ rows: rows.map((a) => ({ ...stamp(a), department_name: names.get(a.department) || a.department })) });
  });

  router.patch('/appointments/:id', requireAccess('opd'), async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const before = await db.one('SELECT * FROM appointments WHERE id = $1', [id]);
    if (!before) return res.status(404).json({ error: 'Not found.' });

    const status = b.status ?? before.status;
    if (!catalog.APPOINTMENT_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
    const remarks = b.remarks !== undefined ? String(b.remarks).trim().slice(0, 500) || null : before.remarks;
    const date = b.appt_date ?? before.appt_date;
    const time = b.appt_time ?? before.appt_time;
    const rescheduled = date !== before.appt_date || time !== before.appt_time;

    const after = await db.tx(async (t) => {
      if (rescheduled) {
        await lock(t, `opd:${before.department}:${date}`);
        const err = await sched.checkOpdSlot(t, before.department, date, time);
        if (err) throw new ValidationError(err);
      }
      return t.one(
        `UPDATE appointments SET status = $1, remarks = $2, appt_date = $3, appt_time = $4,
          reminded_day_before = CASE WHEN $5 THEN FALSE ELSE reminded_day_before END,
          reminded_hours_before = CASE WHEN $5 THEN FALSE ELSE reminded_hours_before END,
          updated_at = now(), updated_by = $7 WHERE id = $6 RETURNING *`,
        [status, remarks, date, time, rescheduled, id, req.user.username],
      );
    });

    if (b.notify !== false) {
      const named = await clinics.withClinicName(db, after);
      if (status === 'CANCELLED' && before.status !== 'CANCELLED') {
        await sendSms(db, { to: after.mobile, message: msg.apptCancelled(named), kind: 'APPT_CANCELLED', refNo: after.ref_no });
      } else if (rescheduled) {
        await sendSms(db, { to: after.mobile, message: msg.apptRescheduled(named), kind: 'APPT_RESCHEDULED', refNo: after.ref_no });
      }
    }
    res.json(stamp(after));
  });

  // ---------- OPD clinics & monthly schedules (Administrators and staff with OPD access) ----------

  router.get('/opd/schedules', requireAccess('opd'), async (req, res) => {
    const month = String(req.query.month || clinics.monthOf(u.todayStr()));
    if (!clinics.validMonth(month)) throw new ValidationError('Invalid month.');
    const [list, scheds, holidays] = await Promise.all([
      clinics.listClinics(db, { activeOnly: false }),
      clinics.schedulesForMonth(db, month),
      db.query("SELECT date, reason FROM closed_dates WHERE date LIKE $1 || '-%' ORDER BY date", [month]),
    ]);
    res.json({
      month,
      holidays,
      clinics: list.map((c) => {
        const s = scheds.get(c.code);
        return { ...c, schedule: s ? { ...s, updated_at: u.toStamp(s.updated_at), summary: clinics.describe(s) } : null };
      }),
    });
  });

  // Save one clinic's schedule for a month
  router.put('/opd/schedules/:code/:month', requireAccess('opd'), async (req, res) => {
    const { code, month } = req.params;
    if (!clinics.validMonth(month)) throw new ValidationError('Invalid month.');
    if (!(await clinics.getClinic(db, code, { activeOnly: false }))) return res.status(404).json({ error: 'Clinic not found.' });
    let v;
    try {
      v = clinics.cleanSchedule(req.body || {});
    } catch (err) {
      throw new ValidationError(err.message);
    }
    const b = req.body || {};
    await db.query(
      `INSERT INTO opd_schedules (clinic_code, month, days, start_time, end_time, slot_minutes, per_slot, closed_dates, extra_dates, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (clinic_code, month) DO UPDATE SET days = excluded.days, start_time = excluded.start_time, end_time = excluded.end_time,
         slot_minutes = excluded.slot_minutes, per_slot = excluded.per_slot, closed_dates = excluded.closed_dates,
         extra_dates = excluded.extra_dates, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
      [code, month, v.days.join(','), v.start, v.end, v.slot, v.perSlot, v.dates(b.closed_dates, month).join(','),
        v.dates(b.extra_dates, month).join(','), v.note || null, req.user.username],
    );
    res.json(await clinics.scheduleFor(db, code, month));
  });

  // Fill a month for every clinic that hasn't been set yet, copying each clinic's latest earlier schedule
  router.post('/opd/schedules/:month/copy-previous', requireAccess('opd'), async (req, res) => {
    const { month } = req.params;
    if (!clinics.validMonth(month)) throw new ValidationError('Invalid month.');
    const rows = await db.query(
      `INSERT INTO opd_schedules (clinic_code, month, days, start_time, end_time, slot_minutes, per_slot, updated_by)
       SELECT DISTINCT ON (s.clinic_code) s.clinic_code, $1, s.days, s.start_time, s.end_time, s.slot_minutes, s.per_slot, $2
       FROM opd_schedules s
       WHERE s.month < $1 AND NOT EXISTS (SELECT 1 FROM opd_schedules x WHERE x.clinic_code = s.clinic_code AND x.month = $1)
       ORDER BY s.clinic_code, s.month DESC
       RETURNING clinic_code`,
      [month, req.user.username],
    );
    res.json({ copied: rows.length });
  });

  // Remove a month's own schedule (the clinic goes back to the previous month's schedule)
  router.delete('/opd/schedules/:code/:month', requireAccess('opd'), async (req, res) => {
    await db.query('DELETE FROM opd_schedules WHERE clinic_code = $1 AND month = $2', [req.params.code, req.params.month]);
    res.json({ ok: true });
  });

  router.post('/opd/clinics', requireAccess('opd'), async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!name) throw new ValidationError('Please enter the clinic name.');
    // Short code from the name, e.g. "Cardiology Clinic" → CARDIOLOGYCLI; made unique if needed
    const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'CLINIC';
    let code = base;
    for (let i = 2; await db.one('SELECT 1 FROM opd_clinics WHERE code = $1', [code]); i++) code = `${base}${i}`;
    const sort = (await db.one('SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM opd_clinics')).n;
    const row = await db.one('INSERT INTO opd_clinics (code, name, sort_order) VALUES ($1, $2, $3) RETURNING *', [code, name, sort]);
    res.status(201).json(row);
  });

  router.patch('/opd/clinics/:code', requireAccess('opd'), async (req, res) => {
    const before = await clinics.getClinic(db, req.params.code, { activeOnly: false });
    if (!before) return res.status(404).json({ error: 'Clinic not found.' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 100) : before.name;
    if (!name) throw new ValidationError('Please enter the clinic name.');
    const active = req.body?.active ?? before.active;
    const sort = req.body?.sort_order !== undefined ? parseInt(req.body.sort_order, 10) : before.sort_order;
    if (Number.isNaN(sort)) throw new ValidationError('Order must be a number.');
    res.json(await db.one('UPDATE opd_clinics SET name = $1, active = $2, sort_order = $3 WHERE code = $4 RETURNING *', [name, !!active, sort, before.code]));
  });

  // ---------- Fees & online payment (administrators only) ----------

  router.get('/payment-settings', adminOnly, async (req, res) => {
    const [fees, info] = await Promise.all([payments.getFees(db), payments.paymentInfo(db)]);
    res.json({
      fees: catalog.RECORD_TYPES.map((t) => ({ code: t.code, name: t.name, fee: fees.get(t.code) ?? 0 })),
      ...info,
      default_note: payments.DEFAULT_NOTE,
      custom_qr: !info.qr_url.startsWith('/img/'),
    });
  });

  router.put('/fees', adminOnly, async (req, res) => {
    const fees = req.body?.fees || {};
    for (const t of catalog.RECORD_TYPES) {
      if (fees[t.code] === undefined) continue;
      const fee = Number(fees[t.code]);
      if (!(fee >= 0 && fee <= 100000)) throw new ValidationError(`${t.name}: enter a fee from 0 to 100,000.`);
      await db.query('UPDATE document_fees SET fee = $1 WHERE record_type = $2', [Math.round(fee * 100) / 100, t.code]);
    }
    res.json({ ok: true });
  });

  router.put('/payment-note', adminOnly, async (req, res) => {
    const value = String(req.body?.note || '').trim().slice(0, 600);
    await db.query("INSERT INTO site_info (key, value) VALUES ('payment_note', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [value]);
    res.json({ ok: true });
  });

  // Replace the payment QR code (e.g. with the hospital's official account); DELETE restores the default
  router.post('/payment-qr', adminOnly, bigJson, async (req, res) => {
    const { buf, mime } = decodeImage(req.body?.image);
    await db.query(
      `INSERT INTO site_images (key, image, mime) VALUES ('payment_qr', $1, $2)
       ON CONFLICT (key) DO UPDATE SET image = excluded.image, mime = excluded.mime, updated_at = now()`,
      [buf, mime],
    );
    res.json(await payments.paymentInfo(db));
  });
  router.delete('/payment-qr', adminOnly, async (req, res) => {
    await db.query("DELETE FROM site_images WHERE key = 'payment_qr'");
    res.json(await payments.paymentInfo(db));
  });

  router.get('/opd/slots', requireAccess('opd'), async (req, res) => {
    res.json({ slots: await sched.opdSlots(db, String(req.query.department || ''), String(req.query.date || '')) });
  });

  // ---------- SMS ----------

  // SMS messages belong to a section by their kind (RECORD_… / APPT_…); test messages are admin-only
  function smsKindsFor(user) {
    if (user.role === 'ADMIN') return null; // everything
    const a = access(user);
    return [a.records && 'RECORD_%', a.opd && 'APPT_%'].filter(Boolean);
  }
  const canSeeSms = (user, kind) => {
    const kinds = smsKindsFor(user);
    return !kinds || kinds.some((k) => kind.startsWith(k.slice(0, -1)));
  };

  router.get('/sms', async (req, res) => {
    const kinds = smsKindsFor(req.user);
    const rows = kinds
      ? await db.query('SELECT * FROM sms_log WHERE kind LIKE ANY($1::text[]) ORDER BY id DESC LIMIT 300', [kinds])
      : await db.query('SELECT * FROM sms_log ORDER BY id DESC LIMIT 300');
    res.json({ rows: rows.map(stamp), provider: config.sms.provider });
  });

  router.post('/sms/:id/resend', async (req, res) => {
    const row = await db.one('SELECT * FROM sms_log WHERE id = $1', [Number(req.params.id)]);
    if (!row || !canSeeSms(req.user, row.kind)) return res.status(404).json({ error: 'Not found.' });
    const ok = await sendSms(db, { to: row.recipient, message: row.message, kind: row.kind, refNo: row.ref_no });
    res.json({ ok });
  });

  router.post('/sms/:id/check', async (req, res) => {
    const row = await db.one('SELECT * FROM sms_log WHERE id = $1', [Number(req.params.id)]);
    if (!row || !canSeeSms(req.user, row.kind)) return res.status(404).json({ error: 'Not found.' });
    try {
      res.json(stamp(await checkDelivery(db, row)));
    } catch (err) {
      throw new ValidationError(err.message);
    }
  });

  router.post('/sms/test', adminOnly, async (req, res) => {
    const to = u.normalizeMobile(req.body?.to);
    if (!to) throw new ValidationError('Invalid mobile number.');
    const message = String(req.body?.message || `${config.hospitalName}: test message from the scheduling system.`).slice(0, 480);
    const ok = await sendSms(db, { to, message, kind: 'TEST' });
    res.json({ ok });
  });

  // ---------- FAQ assistant (administrators only) ----------

  function cleanFaq(b, before = {}) {
    const pick = (k) => (b[k] !== undefined ? b[k] : before[k]);
    const question = String(pick('question') || '').trim().slice(0, 200);
    const answer = String(pick('answer') || '').trim().slice(0, 3000);
    const keywords = String(pick('keywords') || '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
      .join(', ')
      .slice(0, 2000);
    const linkUrl = String(pick('link_url') || '').trim();
    const linkLabel = String(pick('link_label') || '').trim().slice(0, 60);
    const sortOrder = parseInt(pick('sort_order') ?? 100, 10);
    const active = pick('active') ?? true;
    if (!question) throw new ValidationError('Please enter the question.');
    if (!answer) throw new ValidationError('Please enter the answer.');
    // Only site pages or secure web addresses, so a link can't run scripts
    if (linkUrl && !/^\/[^/\\]/.test(linkUrl) && linkUrl !== '/' && !/^https:\/\/[^\s]+$/i.test(linkUrl)) {
      throw new ValidationError('The link must be a page on this site (starting with /) or an https:// address.');
    }
    if (Number.isNaN(sortOrder)) throw new ValidationError('Order must be a number.');
    return [question, answer, keywords, linkUrl || null, linkUrl ? linkLabel || null : null, sortOrder, !!active];
  }

  router.get('/faqs', adminOnly, async (req, res) => {
    const rows = await db.query('SELECT * FROM faqs ORDER BY sort_order, id');
    res.json({ rows: rows.map(stamp), placeholders: faq.placeholders(await clinics.faqValues(db)) });
  });

  router.post('/faqs', adminOnly, async (req, res) => {
    const row = await db.one(
      `INSERT INTO faqs (question, answer, keywords, link_url, link_label, sort_order, active, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [...cleanFaq(req.body || {}), req.user.username],
    );
    res.status(201).json(stamp(row));
  });

  router.patch('/faqs/:id', adminOnly, async (req, res) => {
    const before = await db.one('SELECT * FROM faqs WHERE id = $1', [Number(req.params.id)]);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const row = await db.one(
      `UPDATE faqs SET question = $1, answer = $2, keywords = $3, link_url = $4, link_label = $5, sort_order = $6,
         active = $7, updated_by = $8, updated_at = now() WHERE id = $9 RETURNING *`,
      [...cleanFaq(req.body || {}, before), req.user.username, before.id],
    );
    res.json(stamp(row));
  });

  router.delete('/faqs/:id', adminOnly, async (req, res) => {
    await db.query('DELETE FROM faqs WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  router.get('/faq-unanswered', adminOnly, async (req, res) => {
    res.json({ rows: (await db.query('SELECT * FROM faq_unanswered ORDER BY id DESC LIMIT 200')).map(stamp) });
  });

  router.delete('/faq-unanswered/:id', adminOnly, async (req, res) => {
    await db.query('DELETE FROM faq_unanswered WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  router.delete('/faq-unanswered', adminOnly, async (req, res) => {
    await db.query('DELETE FROM faq_unanswered');
    res.json({ ok: true });
  });

  // ---------- Hospital Directory (administrators only) ----------

  const text = (v, max) => {
    const s = String(v ?? '').trim().slice(0, max);
    return s || null;
  };
  const order = (v) => {
    const n = parseInt(v ?? 100, 10);
    if (Number.isNaN(n)) throw new ValidationError('Order must be a number.');
    return n;
  };
  const checkLink = (url) => {
    if (!directory.safeLink(url)) throw new ValidationError('Links must be a page on this site (starting with /) or an https:// address.');
  };

  async function cleanEntry(b, before = {}) {
    const v = (k) => (b[k] !== undefined ? b[k] : before[k]);
    const name = text(v('name'), 120);
    if (!name) throw new ValidationError('Please enter the name.');
    const category = String(v('category') || 'Department');
    if (!directory.CATEGORIES.includes(category)) throw new ValidationError('Invalid category.');
    const email = text(v('email'), 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Please enter a valid email address.');
    const opdCode = text(v('opd_code'), 20);
    if (opdCode && !(await clinics.getClinic(db, opdCode, { activeOnly: false }))) throw new ValidationError('Unknown OPD clinic.');
    const mapId = v('map_id') ? Number(v('map_id')) : null;
    if (mapId && !(await db.one('SELECT 1 FROM maps WHERE id = $1', [mapId]))) throw new ValidationError('That map no longer exists.');
    const pin = (k) => {
      const raw = v(k);
      if (!mapId || raw === null || raw === undefined || raw === '') return null;
      const n = Number(raw);
      if (!(n >= 0 && n <= 100)) throw new ValidationError('Map pin position is invalid.');
      return n;
    };
    const keywords = String(v('keywords') || '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
      .join(', ')
      .slice(0, 1000);
    return [
      name, category, text(v('description'), 1000), text(v('location'), 200), text(v('hours'), 300), text(v('phone'), 80), email,
      text(v('services'), 3000), keywords, opdCode, mapId, pin('pin_x'), pin('pin_y'), order(v('sort_order')), v('active') ?? true,
    ];
  }

  function cleanGuide(b, before = {}) {
    const v = (k) => (b[k] !== undefined ? b[k] : before[k]);
    const title = text(v('title'), 150);
    if (!title) throw new ValidationError('Please enter the title.');
    const linkUrl = text(v('link_url'), 300);
    checkLink(linkUrl);
    const officeId = v('office_id') ? Number(v('office_id')) : null;
    return [
      title, text(v('summary'), 500), text(v('steps'), 3000), text(v('requirements'), 3000), officeId,
      linkUrl, linkUrl ? text(v('link_label'), 60) : null, order(v('sort_order')), v('active') ?? true,
    ];
  }

  // Map images arrive as a data URL (resized in the browser); max 3 MB after decoding
  function decodeImage(dataUrl) {
    const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new ValidationError('Please choose a PNG, JPG or WebP image.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 3 * 1024 * 1024) throw new ValidationError('The image is too large (max 3 MB). Please use a smaller image.');
    const mime = directory.imageType(buf);
    if (!mime) throw new ValidationError('Please choose a PNG, JPG or WebP image.');
    return { buf, mime };
  }

  const mapMeta = (m) => ({ id: m.id, title: m.title, description: m.description, sort_order: m.sort_order, url: `/api/maps/${m.id}/image?v=${new Date(m.updated_at).getTime()}` });

  router.get('/directory', adminOnly, async (req, res) => {
    const [entries, guides, maps, info] = await Promise.all([
      db.query('SELECT * FROM directory_entries ORDER BY sort_order, name'),
      db.query('SELECT * FROM guides ORDER BY sort_order, title'),
      db.query('SELECT id, title, description, sort_order, updated_at FROM maps ORDER BY sort_order, title'),
      db.query('SELECT key, value FROM site_info'),
    ]);
    const values = Object.fromEntries(info.map((r) => [r.key, r.value]));
    res.json({
      entries: entries.map(stamp),
      guides: guides.map(stamp),
      maps: maps.map(mapMeta),
      contact: directory.SITE_FIELDS.map((f) => ({ ...f, value: values[f.key] || '' })),
      categories: directory.CATEGORIES,
      clinics: (await clinics.listClinics(db, { activeOnly: false })).map(({ code, name }) => ({ code, name })),
    });
  });

  const ENTRY_COLS = 'name, category, description, location, hours, phone, email, services, keywords, opd_code, map_id, pin_x, pin_y, sort_order, active';
  router.post('/directory/entries', adminOnly, async (req, res) => {
    const row = await db.one(
      `INSERT INTO directory_entries (${ENTRY_COLS}, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [...(await cleanEntry(req.body || {})), req.user.username],
    );
    res.status(201).json(stamp(row));
  });
  router.patch('/directory/entries/:id', adminOnly, async (req, res) => {
    const before = await db.one('SELECT * FROM directory_entries WHERE id = $1', [Number(req.params.id)]);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const row = await db.one(
      `UPDATE directory_entries SET (${ENTRY_COLS}, updated_by, updated_at) = ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       WHERE id = $17 RETURNING *`,
      [...(await cleanEntry(req.body || {}, before)), req.user.username, before.id],
    );
    res.json(stamp(row));
  });
  router.delete('/directory/entries/:id', adminOnly, async (req, res) => {
    await db.query('DELETE FROM directory_entries WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  const GUIDE_COLS = 'title, summary, steps, requirements, office_id, link_url, link_label, sort_order, active';
  router.post('/directory/guides', adminOnly, async (req, res) => {
    const row = await db.one(`INSERT INTO guides (${GUIDE_COLS}, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [
      ...cleanGuide(req.body || {}),
      req.user.username,
    ]);
    res.status(201).json(stamp(row));
  });
  router.patch('/directory/guides/:id', adminOnly, async (req, res) => {
    const before = await db.one('SELECT * FROM guides WHERE id = $1', [Number(req.params.id)]);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const row = await db.one(
      `UPDATE guides SET (${GUIDE_COLS}, updated_by, updated_at) = ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) WHERE id = $11 RETURNING *`,
      [...cleanGuide(req.body || {}, before), req.user.username, before.id],
    );
    res.json(stamp(row));
  });
  router.delete('/directory/guides/:id', adminOnly, async (req, res) => {
    await db.query('DELETE FROM guides WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  router.put('/directory/contact', adminOnly, async (req, res) => {
    const b = req.body || {};
    for (const f of directory.SITE_FIELDS) {
      if (b[f.key] === undefined) continue;
      const value = String(b[f.key] ?? '').trim().slice(0, 500);
      if ((f.key === 'facebook' || f.key === 'website') && value && !/^https:\/\/\S+$/i.test(value)) {
        throw new ValidationError(`${f.label}: please enter a full https:// address.`);
      }
      await db.query('INSERT INTO site_info (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [f.key, value]);
    }
    res.json({ ok: true });
  });

  router.post('/maps', adminOnly, bigJson, async (req, res) => {
    const b = req.body || {};
    const title = text(b.title, 120);
    if (!title) throw new ValidationError('Please enter the map title.');
    const { buf, mime } = decodeImage(b.image);
    const row = await db.one(
      'INSERT INTO maps (title, description, image, mime, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, description, sort_order, updated_at',
      [title, text(b.description, 500), buf, mime, order(b.sort_order)],
    );
    res.status(201).json(mapMeta(row));
  });
  router.patch('/maps/:id', adminOnly, bigJson, async (req, res) => {
    const b = req.body || {};
    const before = await db.one('SELECT id, title, description, sort_order FROM maps WHERE id = $1', [Number(req.params.id)]);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const title = text(b.title ?? before.title, 120);
    if (!title) throw new ValidationError('Please enter the map title.');
    const img = b.image ? decodeImage(b.image) : null;
    const row = await db.one(
      `UPDATE maps SET title = $1, description = $2, sort_order = $3,
         image = COALESCE($4, image), mime = COALESCE($5, mime), updated_at = now()
       WHERE id = $6 RETURNING id, title, description, sort_order, updated_at`,
      [title, b.description !== undefined ? text(b.description, 500) : before.description, order(b.sort_order ?? before.sort_order), img?.buf ?? null, img?.mime ?? null, before.id],
    );
    res.json(mapMeta(row));
  });
  // Wayfinding network of a map (points, paths, which directory places are where)
  router.get('/wayfinding/:mapId', adminOnly, async (req, res) => {
    const m = await db.one('SELECT id, title, width_m FROM maps WHERE id = $1', [Number(req.params.mapId) || 0]);
    if (!m) return res.status(404).json({ error: 'Map not found.' });
    res.json({ map: m, ...(await wayfinding.mapGraph(db, m.id)) });
  });

  router.put('/wayfinding/:mapId', adminOnly, async (req, res) => {
    const m = await db.one('SELECT id FROM maps WHERE id = $1', [Number(req.params.mapId) || 0]);
    if (!m) return res.status(404).json({ error: 'Map not found.' });
    const [g, err] = wayfinding.cleanGraph(req.body || {});
    if (err) throw new ValidationError(err);
    try {
      await db.tx((t) => wayfinding.saveGraph(t, m.id, g, req.user.username));
    } catch (e) {
      if (e.validation) throw new ValidationError(e.message);
      throw e;
    }
    res.json({ ok: true, ...(await wayfinding.mapGraph(db, m.id)) });
  });

  router.delete('/maps/:id', adminOnly, async (req, res) => {
    // Entries on this map keep their details but lose the pin
    await db.query('UPDATE directory_entries SET pin_x = NULL, pin_y = NULL WHERE map_id = $1', [Number(req.params.id)]);
    await db.query('DELETE FROM maps WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  // ---------- Closed dates (holidays) ----------

  router.get('/closed-dates', async (req, res) => {
    res.json({ rows: await db.query('SELECT * FROM closed_dates WHERE date >= $1 ORDER BY date', [u.addDays(u.todayStr(), -30)]) });
  });

  router.post('/closed-dates', adminOnly, async (req, res) => {
    const date = String(req.body?.date || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 120);
    if (!u.parseDate(date)) throw new ValidationError('Invalid date.');
    if (!reason) throw new ValidationError('Please give a reason (e.g. holiday name).');
    await db.query('INSERT INTO closed_dates (date, reason) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET reason = excluded.reason', [date, reason]);
    const affected = await db.one(
      `SELECT
        (SELECT COUNT(*)::int FROM appointments WHERE appt_date = $1 AND status = 'BOOKED') AS appointments,
        (SELECT COUNT(*)::int FROM record_requests WHERE pickup_date = $1 AND status NOT IN ('CANCELLED','REJECTED','RELEASED')) AS pickups`,
      [date],
    );
    res.json({ ok: true, affected });
  });

  router.delete('/closed-dates/:date', adminOnly, async (req, res) => {
    await db.query('DELETE FROM closed_dates WHERE date = $1', [req.params.date]);
    res.json({ ok: true });
  });

  // Referrals from RHUs, barangay health centers and other hospitals (routes/adminReferrals.js)
  registerReferralRoutes(router, { db, requireAccess, ValidationError, whereClause });
  registerFlagRoutes(router, { db, requireAccess, ValidationError, whereClause });

  return router;
};
