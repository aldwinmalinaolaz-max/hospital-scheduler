// Attendance kiosk API (/api/attendance). Employees time in and out with their employee number
// and PIN, only on devices that an authorised staff member has set up as kiosks, so nobody can
// clock in from home. The time recorded is always the server's.
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const att = require('../attendance');
const u = require('../util');
const { ValidationError, rateLimit } = require('./public');

const KIOSK_DAYS = 400;

module.exports = function attendanceRoutes(db) {
  const router = express.Router();
  const json = express.json({ limit: '1mb' }); // a punch can carry a small photo
  const loginLimit = rateLimit({ windowMs: 10 * 60e3, max: config.loginRateLimit });
  // Kiosks are shared by many employees from one address, so this limit is generous;
  // wrong PINs are limited per employee number instead.
  const punchLimit = rateLimit({ windowMs: 60e3, max: Math.max(60, config.submitRateLimit) });

  async function kioskOf(req) {
    const token = auth.parseCookies(req.headers.cookie)[att.KIOSK_COOKIE];
    if (!token) return null;
    const k = await db.one('SELECT * FROM attendance_kiosks WHERE token_hash = $1 AND active', [att.hashToken(token)]);
    if (k) await db.query('UPDATE attendance_kiosks SET last_seen_at = now() WHERE id = $1', [k.id]);
    return k;
  }
  const requireKiosk = async (req, res, next) => {
    req.kiosk = await kioskOf(req);
    if (!req.kiosk) return res.status(401).json({ error: 'This device is not set up as an attendance kiosk.', setup: true });
    next();
  };

  router.get('/kiosk', async (req, res) => {
    const k = await kioskOf(req);
    res.json({ kiosk: k ? { name: k.name, require_photo: k.require_photo } : null, now: new Date().toISOString() });
  });

  // An Administrator or a staff member with Attendance access turns this browser into a kiosk
  router.post('/kiosk', json, loginLimit, async (req, res) => {
    const b = req.body || {};
    const user = await db.one('SELECT * FROM admins WHERE lower(username) = lower($1)', [String(b.username || '').trim()]);
    if (!user || !auth.verifyPassword(String(b.password || ''), user.password_hash) || !user.active) {
      return res.status(401).json({ error: 'Invalid staff username or password.' });
    }
    if (user.role !== 'ADMIN' && !user.can_attendance) {
      return res.status(403).json({ error: 'Only administrators or staff with Attendance access can set up a kiosk.' });
    }
    const name = String(b.name || '').trim().toUpperCase().slice(0, 80);
    if (!name) throw new ValidationError('Please name this kiosk, e.g. MAIN LOBBY or ER ENTRANCE.');
    const token = att.newToken();
    await db.query('INSERT INTO attendance_kiosks (name, token_hash, require_photo, created_by) VALUES ($1, $2, $3, $4)', [
      name, att.hashToken(token), b.require_photo !== false, user.username,
    ]);
    res.setHeader(
      'Set-Cookie',
      `${att.KIOSK_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${KIOSK_DAYS * 86400}${req.secure ? '; Secure' : ''}`,
    );
    res.status(201).json({ name });
  });

  // Checks the employee number and PIN, locking the number after too many wrong PINs
  async function identify(employeeNo, pin) {
    const no = String(employeeNo || '').trim().toUpperCase();
    const emp = no && (await db.one('SELECT * FROM employees WHERE employee_no = $1', [no]));
    const wrong = new ValidationError('Employee no. or PIN is incorrect.');
    wrong.status = 401;
    if (!emp) throw wrong;
    if (emp.locked_until && new Date(emp.locked_until) > new Date()) {
      const err = new ValidationError(
        `Too many wrong PINs. Try again after ${u.formatTime12(att.hhmm(new Date(emp.locked_until)))}, or ask HR to reset your PIN.`,
      );
      err.status = 423;
      throw err;
    }
    if (!auth.verifyPassword(String(pin || ''), emp.pin_hash)) {
      const { failed_pins: n } = await db.one(
        `UPDATE employees SET failed_pins = failed_pins + 1,
           locked_until = CASE WHEN failed_pins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1 RETURNING failed_pins`,
        [emp.id, config.attendance.maxPinAttempts, String(config.attendance.lockMinutes)],
      );
      if (n >= config.attendance.maxPinAttempts) await db.query('UPDATE employees SET failed_pins = 0 WHERE id = $1', [emp.id]);
      throw wrong;
    }
    if (!emp.active) {
      const err = new ValidationError('This employee record is inactive. Please see HR.');
      err.status = 403;
      throw err;
    }
    if (emp.failed_pins) await db.query('UPDATE employees SET failed_pins = 0 WHERE id = $1', [emp.id]);
    return emp;
  }

  router.post('/punch', json, punchLimit, requireKiosk, async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'OUT' ? 'OUT' : b.kind === 'IN' ? 'IN' : null;
    if (!kind) throw new ValidationError('Choose Time In or Time Out.');
    const emp = await identify(b.employee_no, b.pin);
    const photo = b.photo ? att.decodePhoto(b.photo) : null;
    if (req.kiosk.require_photo && !photo) throw new ValidationError('Please look at the camera — a photo is needed to record your attendance.');

    const recent = await db.query(
      `SELECT * FROM attendance_logs WHERE employee_id = $1 AND voided_at IS NULL AND logged_at > now() - interval '${att.MAX_SHIFT_HOURS} hours'
       ORDER BY logged_at DESC`,
      [emp.id],
    );
    const last = recent[0];
    let log;
    let duplicate = false;
    if (last && last.kind === kind && Date.now() - new Date(last.logged_at) < att.DUPLICATE_MINUTES * 60e3) {
      log = last; // double tap: keep the first one
      duplicate = true;
    } else {
      log = await db.tx(async (t) => {
        const row = await t.one('INSERT INTO attendance_logs (employee_id, kind, kiosk_id) VALUES ($1, $2, $3) RETURNING *', [emp.id, kind, req.kiosk.id]);
        if (photo) await t.query('INSERT INTO attendance_photos (log_id, image, mime) VALUES ($1, $2, $3)', [row.id, photo.buf, photo.mime]);
        return row;
      });
    }
    const at = new Date(log.logged_at);
    const warnings = [];
    if (!duplicate) {
      if (kind === 'OUT' && last?.kind !== 'IN') warnings.push('No time-in was found for this time-out. Please inform your supervisor or HR.');
      if (kind === 'IN' && last?.kind === 'IN') warnings.push('Your previous time-in has no time-out. Please inform your supervisor or HR.');
    }
    let late = 0;
    const shift = att.shiftOn(emp, u.toDateStr(at));
    if (kind === 'IN' && shift) {
      const m = Math.round((at - shift.start) / 60000);
      if (m > config.attendance.graceMinutes && m < 8 * 60) late = m;
    }
    res.status(duplicate ? 200 : 201).json({
      name: `${emp.first_name} ${emp.last_name}`,
      employee_no: emp.employee_no,
      kind,
      time: u.formatTime12(att.hhmm(at)),
      date: u.formatDateLong(u.toDateStr(at)),
      duplicate,
      late,
      warnings,
    });
  });

  router.post('/pin', json, punchLimit, requireKiosk, async (req, res) => {
    const b = req.body || {};
    const emp = await identify(b.employee_no, b.pin);
    const bad = att.checkPin(b.new_pin);
    if (bad) throw new ValidationError(bad);
    await db.query('UPDATE employees SET pin_hash = $1, updated_at = now() WHERE id = $2', [auth.hashPassword(String(b.new_pin)), emp.id]);
    res.json({ ok: true });
  });

  return router;
};
