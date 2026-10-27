const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const sched = require('../scheduling');
const msg = require('../messages');
const auth = require('../auth');
const { sendSms } = require('../sms');
const { tx } = require('../db');
const u = require('../util');
const { ValidationError } = require('./public');

const COOKIE = 'hs_admin';

module.exports = function adminRoutes(db) {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
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

  router.post('/password', (req, res) => {
    const { current, next: newPassword } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(req.admin);
    if (!auth.verifyPassword(String(current || ''), admin.password_hash)) throw new ValidationError('Current password is incorrect.');
    if (String(newPassword || '').length < 8) throw new ValidationError('New password must be at least 8 characters.');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(auth.hashPassword(newPassword), admin.id);
    res.json({ ok: true });
  });

  router.get('/stats', (req, res) => {
    const today = u.todayStr();
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    res.json({
      today,
      appointmentsToday: one("SELECT COUNT(*) n FROM appointments WHERE appt_date = ? AND status != 'CANCELLED'", today),
      checkedInToday: one("SELECT COUNT(*) n FROM appointments WHERE appt_date = ? AND status IN ('CHECKED_IN','COMPLETED')", today),
      upcomingAppointments: one("SELECT COUNT(*) n FROM appointments WHERE appt_date > ? AND status = 'BOOKED'", today),
      recordsPending: one("SELECT COUNT(*) n FROM record_requests WHERE status IN ('PENDING','PROCESSING')"),
      recordsReady: one("SELECT COUNT(*) n FROM record_requests WHERE status = 'READY'"),
      pickupsToday: one("SELECT COUNT(*) n FROM record_requests WHERE pickup_date = ? AND status NOT IN ('CANCELLED','REJECTED')", today),
      smsFailed: one("SELECT COUNT(*) n FROM sms_log WHERE status = 'FAILED' AND created_at >= datetime('now','localtime','-7 days')"),
      smsProvider: config.sms.provider,
    });
  });

  // ---------- Records ----------

  router.get('/records', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) (where.push('r.status = ?'), params.push(String(req.query.status)));
    if (req.query.pickup_date) (where.push('r.pickup_date = ?'), params.push(String(req.query.pickup_date)));
    if (req.query.type) (where.push('EXISTS (SELECT 1 FROM record_request_items i WHERE i.request_id = r.id AND i.record_type = ?)'), params.push(String(req.query.type)));
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where.push('(r.ref_no LIKE ? OR r.patient_last LIKE ? OR r.patient_first LIKE ? OR r.mobile LIKE ? OR r.hospital_no LIKE ?)');
      params.push(q, q, q, q, q);
    }
    const rows = db
      .prepare(`SELECT r.* FROM record_requests r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.pickup_date, r.id LIMIT 500`)
      .all(...params);
    const itemStmt = db.prepare('SELECT record_type, details, copies FROM record_request_items WHERE request_id = ?');
    res.json({
      rows: rows.map((r) => ({
        ...r,
        items: itemStmt.all(r.id).map((i) => ({ ...i, name: catalog.recordType(i.record_type)?.name || i.record_type })),
      })),
    });
  });

  router.patch('/records/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const before = db.prepare('SELECT * FROM record_requests WHERE id = ?').get(id);
    if (!before) return res.status(404).json({ error: 'Not found.' });

    const status = b.status ?? before.status;
    if (!catalog.RECORD_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
    const remarks = b.remarks !== undefined ? String(b.remarks).trim().slice(0, 500) || null : before.remarks;
    const pickup = b.pickup_date ?? before.pickup_date;
    if (!u.parseDate(pickup)) throw new ValidationError('Invalid pickup date.');
    if (status === 'REJECTED' && !remarks) throw new ValidationError('Please give a reason (remarks) when rejecting a request.');

    db.prepare(
      `UPDATE record_requests SET status = ?, remarks = ?, pickup_date = ?,
        reminded_pickup = CASE WHEN ? != pickup_date THEN 0 ELSE reminded_pickup END,
        updated_at = datetime('now','localtime') WHERE id = ?`,
    ).run(status, remarks, pickup, pickup, id);
    const after = db.prepare('SELECT * FROM record_requests WHERE id = ?').get(id);

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
    res.json(after);
  });

  // ---------- Appointments ----------

  router.get('/appointments', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.date) (where.push('appt_date = ?'), params.push(String(req.query.date)));
    if (req.query.department) (where.push('department = ?'), params.push(String(req.query.department)));
    if (req.query.status) (where.push('status = ?'), params.push(String(req.query.status)));
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where.push('(ref_no LIKE ? OR patient_last LIKE ? OR patient_first LIKE ? OR mobile LIKE ? OR hospital_no LIKE ?)');
      params.push(q, q, q, q, q);
    }
    const rows = db
      .prepare(`SELECT * FROM appointments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY appt_date, appt_time, id LIMIT 500`)
      .all(...params);
    res.json({ rows: rows.map((a) => ({ ...a, department_name: catalog.department(a.department)?.name || a.department })) });
  });

  router.patch('/appointments/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const before = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!before) return res.status(404).json({ error: 'Not found.' });

    const status = b.status ?? before.status;
    if (!catalog.APPOINTMENT_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
    const remarks = b.remarks !== undefined ? String(b.remarks).trim().slice(0, 500) || null : before.remarks;
    const date = b.appt_date ?? before.appt_date;
    const time = b.appt_time ?? before.appt_time;
    const rescheduled = date !== before.appt_date || time !== before.appt_time;

    const after = tx(db, () => {
      if (rescheduled) {
        const err = sched.checkOpdSlot(db, before.department, date, time);
        if (err) throw new ValidationError(err);
      }
      db.prepare(
        `UPDATE appointments SET status = ?, remarks = ?, appt_date = ?, appt_time = ?,
          reminded_day_before = CASE WHEN ? THEN 0 ELSE reminded_day_before END,
          reminded_hours_before = CASE WHEN ? THEN 0 ELSE reminded_hours_before END,
          updated_at = datetime('now','localtime') WHERE id = ?`,
      ).run(status, remarks, date, time, rescheduled ? 1 : 0, rescheduled ? 1 : 0, id);
      return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    });

    if (b.notify !== false) {
      if (status === 'CANCELLED' && before.status !== 'CANCELLED') {
        await sendSms(db, { to: after.mobile, message: msg.apptCancelled(after), kind: 'APPT_CANCELLED', refNo: after.ref_no });
      } else if (rescheduled) {
        await sendSms(db, { to: after.mobile, message: msg.apptRescheduled(after), kind: 'APPT_RESCHEDULED', refNo: after.ref_no });
      }
    }
    res.json(after);
  });

  router.get('/opd/slots', (req, res) => {
    res.json({ slots: sched.opdSlots(db, String(req.query.department || ''), String(req.query.date || '')) });
  });

  // ---------- SMS ----------

  router.get('/sms', (req, res) => {
    const rows = db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT 300').all();
    res.json({ rows, provider: config.sms.provider });
  });

  router.post('/sms/:id/resend', async (req, res) => {
    const row = db.prepare('SELECT * FROM sms_log WHERE id = ?').get(Number(req.params.id));
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

  router.get('/closed-dates', (req, res) => {
    res.json({ rows: db.prepare('SELECT * FROM closed_dates WHERE date >= ? ORDER BY date').all(u.addDays(u.todayStr(), -30)) });
  });

  router.post('/closed-dates', (req, res) => {
    const date = String(req.body?.date || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 120);
    if (!u.parseDate(date)) throw new ValidationError('Invalid date.');
    if (!reason) throw new ValidationError('Please give a reason (e.g. holiday name).');
    db.prepare('INSERT INTO closed_dates (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason').run(date, reason);
    const affected = {
      appointments: db.prepare("SELECT COUNT(*) n FROM appointments WHERE appt_date = ? AND status = 'BOOKED'").get(date).n,
      pickups: db.prepare("SELECT COUNT(*) n FROM record_requests WHERE pickup_date = ? AND status NOT IN ('CANCELLED','REJECTED','RELEASED')").get(date).n,
    };
    res.json({ ok: true, affected });
  });

  router.delete('/closed-dates/:date', (req, res) => {
    db.prepare('DELETE FROM closed_dates WHERE date = ?').run(req.params.date);
    res.json({ ok: true });
  });

  return router;
};
