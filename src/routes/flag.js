// Flag Ceremony check-in API (/api/flag), used by employees on their own phones. An employee
// signs in once with their employee no. and PIN and stays signed in on that phone. A check-in
// counts only while check-in is open and when the phone's GPS puts them inside the geofence.
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const flag = require('../flag');
const u = require('../util');
const { ValidationError, rateLimit } = require('./public');

// Separate signing secret from staff and facility sessions
const secret = () => `${config.sessionSecret}|employee`;
const DEVICE_DAYS = 400;

module.exports = function flagRoutes(db) {
  const router = express.Router();
  const json = express.json({ limit: '1mb' }); // a check-in can carry a selfie
  // Many employees may share one hospital Wi-Fi address on ceremony mornings, so these limits are
  // generous; wrong PINs are limited per employee number instead.
  const loginLimit = rateLimit({ windowMs: 10 * 60e3, max: Math.max(100, config.loginRateLimit) });
  const checkinLimit = rateLimit({ windowMs: 60e3, max: Math.max(120, config.submitRateLimit) });

  const secure = (req) => (req.secure ? '; Secure' : '');
  const employeeCookie = (req, emp) =>
    `${flag.EMPLOYEE_COOKIE}=${auth.createToken(emp.employee_no, emp.session_version, secret(), config.flag.rememberDays * 24)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.flag.rememberDays * 86400}${secure(req)}`;
  // A random ID for this phone/browser, so one phone cannot check in several employees
  function deviceOf(req, res) {
    let token = auth.parseCookies(req.headers.cookie)[flag.DEVICE_COOKIE];
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) {
      token = flag.newToken();
      res.append('Set-Cookie', `${flag.DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DEVICE_DAYS * 86400}${secure(req)}`);
    }
    return flag.hashToken(token);
  }

  async function employeeOf(req) {
    const t = auth.readToken(auth.parseCookies(req.headers.cookie)[flag.EMPLOYEE_COOKIE], secret());
    if (!t) return null;
    const e = await db.one('SELECT * FROM employees WHERE employee_no = $1', [t.username]);
    return e && e.active && e.session_version === t.version ? e : null;
  }
  const requireEmployee = async (req, res, next) => {
    req.emp = await employeeOf(req);
    if (!req.emp) return res.status(401).json({ error: 'Please sign in with your employee no. and PIN.' });
    next();
  };

  const fail = (status, message) => {
    const err = new ValidationError(message);
    err.status = status;
    return err;
  };

  // Checks the employee number and PIN, locking the number after too many wrong PINs
  async function identify(employeeNo, pin) {
    const no = String(employeeNo || '').trim().toUpperCase();
    const emp = no && (await db.one('SELECT * FROM employees WHERE employee_no = $1', [no]));
    const wrong = fail(401, 'Employee no. or PIN is incorrect.');
    if (!emp) throw wrong;
    if (emp.locked_until && new Date(emp.locked_until) > new Date()) {
      throw fail(423, `Too many wrong PINs. Try again after ${u.formatTime12(flag.hhmm(new Date(emp.locked_until)))}, or ask HR to reset your PIN.`);
    }
    if (!auth.verifyPassword(String(pin || ''), emp.pin_hash)) {
      const { failed_pins: n } = await db.one(
        `UPDATE employees SET failed_pins = failed_pins + 1,
           locked_until = CASE WHEN failed_pins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1 RETURNING failed_pins`,
        [emp.id, config.flag.maxPinAttempts, String(config.flag.lockMinutes)],
      );
      if (n >= config.flag.maxPinAttempts) await db.query('UPDATE employees SET failed_pins = 0 WHERE id = $1', [emp.id]);
      throw wrong;
    }
    if (!emp.active) throw fail(403, 'Your employee record is inactive. Please see HR.');
    if (emp.failed_pins) await db.query('UPDATE employees SET failed_pins = 0 WHERE id = $1', [emp.id]);
    return emp;
  }

  const myCheckin = (k) =>
    k && {
      status: k.status,
      label: flag.STATUSES[k.status],
      time: flag.hhmm(new Date(k.checked_at)),
      source: k.source,
      distance_m: k.distance_m,
      remarks: k.remarks,
    };

  router.get('/me', async (req, res) => {
    const settings = await flag.getSettings(db);
    const ready = flag.geofenceReady(settings);
    const emp = await employeeOf(req);
    const base = {
      now: new Date().toISOString(),
      today: u.todayStr(),
      venue: settings.venue,
      ready,
      require_selfie: settings.require_selfie,
      radius_m: settings.radius_m,
      max_accuracy_m: settings.max_accuracy_m,
      // The venue is shown on the employee's phone so they can see how far they are
      center: ready ? { lat: settings.lat, lng: settings.lng } : null,
    };
    if (!emp) return res.json({ ...base, employee: null });

    const today = u.todayStr();
    await flag.ensureCeremonies(db, settings, today, u.addDays(today, 14));
    const [upcoming, history] = await Promise.all([
      db.query(
        `SELECT c.*, k.status, k.checked_at, k.source AS k_source, k.distance_m, k.remarks AS k_remarks FROM flag_ceremonies c
         LEFT JOIN flag_checkins k ON k.ceremony_id = c.id AND k.employee_id = $1
         WHERE c.ceremony_date >= $2 ORDER BY c.ceremony_date, c.starts_at LIMIT 10`,
        [emp.id, today],
      ),
      db.query(
        `SELECT c.*, k.status, k.checked_at, k.source AS k_source, k.distance_m, k.remarks AS k_remarks FROM flag_ceremonies c
         LEFT JOIN flag_checkins k ON k.ceremony_id = c.id AND k.employee_id = $1
         WHERE c.ceremony_date < $2 AND c.ceremony_date >= $3 AND NOT c.cancelled ORDER BY c.ceremony_date DESC, c.starts_at DESC LIMIT 12`,
        [emp.id, today, u.toDateStr(new Date(emp.created_at))],
      ),
    ]);
    const withMine = (c) => ({ ...flag.presentCeremony(c), mine: c.status ? myCheckin({ ...c, source: c.k_source, remarks: c.k_remarks }) : null });
    const todays = upcoming.filter((c) => c.ceremony_date === today && flag.phase(c) !== 'CLOSED').map(withMine);
    // Today's ceremonies that already closed go to the history
    const closedToday = upcoming.filter((c) => c.ceremony_date === today && flag.phase(c) === 'CLOSED' && !c.cancelled);
    res.json({
      ...base,
      employee: { employee_no: emp.employee_no, name: flag.fullName(emp), department: emp.department, flag_required: emp.flag_required },
      today_ceremonies: todays,
      next: upcoming.filter((c) => c.ceremony_date > today && !c.cancelled).slice(0, 3).map(withMine),
      history: [...closedToday.reverse(), ...history].map((c) => {
        const x = withMine(c);
        if (!x.mine) x.mine = { status: 'ABSENT', label: flag.STATUSES.ABSENT };
        return x;
      }),
    });
  });

  router.post('/login', json, loginLimit, async (req, res) => {
    const b = req.body || {};
    const emp = await identify(b.employee_no, b.pin);
    deviceOf(req, res);
    res.append('Set-Cookie', employeeCookie(req, emp));
    res.json({ name: flag.fullName(emp) });
  });

  router.post('/logout', (req, res) => {
    res.append('Set-Cookie', `${flag.EMPLOYEE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.post('/checkin', json, checkinLimit, requireEmployee, async (req, res) => {
    const b = req.body || {};
    const emp = req.emp;
    const settings = await flag.getSettings(db);
    if (!flag.geofenceReady(settings)) throw fail(409, 'Flag ceremony check-in has not been set up yet. Please inform HR.');
    const c = /^\d+$/.test(String(b.ceremony_id)) && (await db.one('SELECT * FROM flag_ceremonies WHERE id = $1', [Number(b.ceremony_id)]));
    if (!c) throw fail(404, 'Ceremony not found.');
    if (c.cancelled) {
      throw fail(409, c.moved_to_date
        ? `This ceremony was moved to ${u.formatDateLong(c.moved_to_date)}${c.cancel_reason ? ` (${c.cancel_reason})` : ''}.`
        : `This ceremony was cancelled${c.cancel_reason ? `: ${c.cancel_reason}` : ''}.`);
    }

    // Already recorded (double tap, or staff marked them): show what is on file
    const existing = await db.one('SELECT * FROM flag_checkins WHERE ceremony_id = $1 AND employee_id = $2', [c.id, emp.id]);
    if (existing) return res.json({ already: true, ceremony: flag.presentCeremony(c), mine: myCheckin(existing) });

    const now = new Date();
    const ph = flag.phase(c, now);
    if (ph === 'UPCOMING') {
      throw fail(409, `Check-in opens at ${u.formatTime12(c.opens_at)}${c.ceremony_date !== u.todayStr(now) ? ` on ${u.formatDateLong(c.ceremony_date)}` : ''}.`);
    }
    if (ph === 'CLOSED') throw fail(409, `Check-in closed at ${u.formatTime12(c.closes_at)}. If you attended, please inform HR.`);

    const loc = flag.checkLocation(settings, b);
    if (!loc.ok) {
      const err = fail(422, loc.error);
      throw err;
    }
    const photo = b.photo ? flag.decodePhoto(b.photo) : null;
    if (b.photo && !photo) throw new ValidationError('That selfie could not be used. Please take it again.');
    if (settings.require_selfie && !photo) throw new ValidationError('Please take a selfie at the venue to check in.');

    const device = deviceOf(req, res);
    const other = await db.one(
      `SELECT e.employee_no FROM flag_checkins k JOIN employees e ON e.id = k.employee_id WHERE k.ceremony_id = $1 AND k.device_hash = $2`,
      [c.id, device],
    );
    if (other) {
      throw fail(409, `This phone was already used to check in employee no. ${other.employee_no} for this ceremony. Each employee must check in on their own phone.`);
    }

    const status = flag.arrivalStatus(c, now, settings);
    let row;
    try {
      row = await db.tx(async (t) => {
        const k = await t.one(
          `INSERT INTO flag_checkins (ceremony_id, employee_id, status, checked_at, source, lat, lng, accuracy_m, distance_m, device_hash, user_agent)
           VALUES ($1, $2, $3, $4, 'GPS', $5, $6, $7, $8, $9, $10) RETURNING *`,
          [c.id, emp.id, status, now.toISOString(), loc.lat, loc.lng, loc.accuracy, loc.distance, device, String(req.headers['user-agent'] || '').slice(0, 300)],
        );
        if (photo) await t.query('INSERT INTO flag_checkin_photos (checkin_id, image, mime) VALUES ($1, $2, $3)', [k.id, photo.buf, photo.mime]);
        return k;
      });
    } catch (err) {
      // Two taps at once, or two employees racing on one phone
      if (err.code !== '23505') throw err;
      const again = await db.one('SELECT * FROM flag_checkins WHERE ceremony_id = $1 AND employee_id = $2', [c.id, emp.id]);
      if (again) return res.json({ already: true, ceremony: flag.presentCeremony(c), mine: myCheckin(again) });
      throw fail(409, 'This phone was already used to check in another employee for this ceremony. Each employee must check in on their own phone.');
    }
    res.status(201).json({ ceremony: flag.presentCeremony(c), mine: myCheckin(row) });
  });

  router.post('/pin', json, loginLimit, requireEmployee, async (req, res) => {
    const b = req.body || {};
    const emp = await identify(req.emp.employee_no, b.pin);
    const bad = flag.checkPin(b.new_pin);
    if (bad) throw new ValidationError(bad);
    // Signs the employee out of every other phone; this one gets a fresh sign-in
    const updated = await db.one(
      'UPDATE employees SET pin_hash = $1, session_version = session_version + 1, updated_at = now() WHERE id = $2 RETURNING *',
      [auth.hashPassword(String(b.new_pin)), emp.id],
    );
    res.append('Set-Cookie', employeeCookie(req, updated));
    res.json({ ok: true });
  });

  return router;
};
