const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const sched = require('../scheduling');
const msg = require('../messages');
const auth = require('../auth');
const { sendSms } = require('../sms');
const { lock } = require('../db');
const u = require('../util');
const { ValidationError } = require('./public');

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

const stamp = (row) => ({ ...row, created_at: u.toStamp(row.created_at), updated_at: u.toStamp(row.updated_at) });

module.exports = function adminRoutes(db) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    const admin = await db.one('SELECT * FROM admins WHERE username = $1', [String(username || '')]);
    if (!admin || !auth.verifyPassword(String(password || ''), admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const secure = req.secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${auth.createToken(admin.username, config.sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_HOURS * 3600}${secure}`,
    );
    res.json({ username: admin.username });
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Everything below requires a session
  router.use((req, res, next) => {
    const user = auth.readToken(auth.parseCookies(req.headers.cookie)[COOKIE], config.sessionSecret);
    if (!user) return res.status(401).json({ error: 'Please log in.' });
    req.admin = user;
    next();
  });

  router.get('/me', (req, res) => res.json({ username: req.admin }));

  router.post('/password', async (req, res) => {
    const { current, next: newPassword } = req.body || {};
    const admin = await db.one('SELECT * FROM admins WHERE username = $1', [req.admin]);
    if (!auth.verifyPassword(String(current || ''), admin.password_hash)) throw new ValidationError('Current password is incorrect.');
    if (String(newPassword || '').length < 8) throw new ValidationError('New password must be at least 8 characters.');
    await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [auth.hashPassword(newPassword), admin.id]);
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
        (SELECT COUNT(*)::int FROM record_requests WHERE pickup_date = $1 AND status NOT IN ('CANCELLED','REJECTED')) AS "pickupsToday",
        (SELECT COUNT(*)::int FROM sms_log WHERE status = 'FAILED' AND created_at >= now() - interval '7 days') AS "smsFailed"`,
      [today],
    );
    res.json({ today, ...s, smsProvider: config.sms.provider });
  });

  // ---------- Records ----------

  router.get('/records', async (req, res) => {
    const conds = [];
    if (req.query.status) conds.push(['r.status = ?', String(req.query.status)]);
    if (req.query.pickup_date) conds.push(['r.pickup_date = ?', String(req.query.pickup_date)]);
    if (req.query.type) conds.push(['EXISTS (SELECT 1 FROM record_request_items i WHERE i.request_id = r.id AND i.record_type = ?)', String(req.query.type)]);
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

  router.patch('/records/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const before = await db.one('SELECT * FROM record_requests WHERE id = $1', [id]);
    if (!before) return res.status(404).json({ error: 'Not found.' });

    const status = b.status ?? before.status;
    if (!catalog.RECORD_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
    const remarks = b.remarks !== undefined ? String(b.remarks).trim().slice(0, 500) || null : before.remarks;
    const pickup = b.pickup_date ?? before.pickup_date;
    if (!u.parseDate(pickup)) throw new ValidationError('Invalid pickup date.');
    if (status === 'REJECTED' && !remarks) throw new ValidationError('Please give a reason (remarks) when rejecting a request.');

    const after = await db.one(
      `UPDATE record_requests SET status = $1, remarks = $2, pickup_date = $3,
        reminded_pickup = CASE WHEN $3 <> pickup_date THEN FALSE ELSE reminded_pickup END,
        updated_at = now() WHERE id = $4 RETURNING *`,
      [status, remarks, pickup, id],
    );

    // Notify on meaningful changes
    if (b.notify !== false) {
      if (status !== before.status && status === 'READY') {
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

  router.get('/appointments', async (req, res) => {
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
    res.json({ rows: rows.map((a) => ({ ...stamp(a), department_name: catalog.department(a.department)?.name || a.department })) });
  });

  router.patch('/appointments/:id', async (req, res) => {
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
          updated_at = now() WHERE id = $6 RETURNING *`,
        [status, remarks, date, time, rescheduled, id],
      );
    });

    if (b.notify !== false) {
      if (status === 'CANCELLED' && before.status !== 'CANCELLED') {
        await sendSms(db, { to: after.mobile, message: msg.apptCancelled(after), kind: 'APPT_CANCELLED', refNo: after.ref_no });
      } else if (rescheduled) {
        await sendSms(db, { to: after.mobile, message: msg.apptRescheduled(after), kind: 'APPT_RESCHEDULED', refNo: after.ref_no });
      }
    }
    res.json(stamp(after));
  });

  router.get('/opd/slots', async (req, res) => {
    res.json({ slots: await sched.opdSlots(db, String(req.query.department || ''), String(req.query.date || '')) });
  });

  // ---------- SMS ----------

  router.get('/sms', async (req, res) => {
    const rows = await db.query('SELECT * FROM sms_log ORDER BY id DESC LIMIT 300');
    res.json({ rows: rows.map(stamp), provider: config.sms.provider });
  });

  router.post('/sms/:id/resend', async (req, res) => {
    const row = await db.one('SELECT * FROM sms_log WHERE id = $1', [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const ok = await sendSms(db, { to: row.recipient, message: row.message, kind: row.kind, refNo: row.ref_no });
    res.json({ ok });
  });

  router.post('/sms/test', async (req, res) => {
    const to = u.normalizeMobile(req.body?.to);
    if (!to) throw new ValidationError('Invalid mobile number.');
    const message = String(req.body?.message || `${config.hospitalName}: test message from the scheduling system.`).slice(0, 480);
    const ok = await sendSms(db, { to, message, kind: 'TEST' });
    res.json({ ok });
  });

  // ---------- Closed dates (holidays) ----------

  router.get('/closed-dates', async (req, res) => {
    res.json({ rows: await db.query('SELECT * FROM closed_dates WHERE date >= $1 ORDER BY date', [u.addDays(u.todayStr(), -30)]) });
  });

  router.post('/closed-dates', async (req, res) => {
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

  router.delete('/closed-dates/:date', async (req, res) => {
    await db.query('DELETE FROM closed_dates WHERE date = $1', [req.params.date]);
    res.json({ ok: true });
  });

  return router;
};
