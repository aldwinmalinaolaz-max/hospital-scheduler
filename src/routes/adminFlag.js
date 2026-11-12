// Staff panel: Flag Ceremony Attendance. Registered on the admin router after sign-in (see
// routes/admin.js); needs the Flag Ceremony permission. Covers the venue and geofence, the weekly
// schedule and special or cancelled ceremonies, each ceremony's attendance, excuses and manual
// entries, the monthly summary, and the employee list with PINs.
const config = require('../config');
const auth = require('../auth');
const flag = require('../flag');
const u = require('../util');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MARKS = ['ON_TIME', 'LATE', 'EXCUSED', 'CLEAR'];

module.exports = function registerFlagRoutes(router, { db, requireAccess, ValidationError, whereClause }) {
  const can = requireAccess('attendance');
  const fail = (status, message) => {
    const err = new ValidationError(message);
    err.status = status;
    return err;
  };
  const idParam = (v) => (/^\d+$/.test(String(v)) ? Number(v) : 0);

  const presentEmployee = (e) => ({
    id: e.id,
    employee_no: e.employee_no,
    last_name: e.last_name,
    first_name: e.first_name,
    middle_name: e.middle_name,
    name: flag.fullName(e),
    position: e.position,
    division: e.department,
    unit: e.unit,
    flag_required: e.flag_required,
    active: e.active,
    locked: !!(e.locked_until && new Date(e.locked_until) > new Date()),
    updated_by: e.updated_by,
    updated_at: u.toStamp(e.updated_at),
  });

  // ---------- Options and settings ----------

  router.get('/flag/options', can, async (req, res) => {
    const [deps, units, settings, saved] = await Promise.all([
      db.query("SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department <> '' ORDER BY 1"),
      db.query("SELECT DISTINCT unit FROM employees WHERE unit IS NOT NULL AND unit <> '' ORDER BY 1"),
      flag.getSettings(db),
      db.one('SELECT updated_by, updated_at FROM flag_settings WHERE id = 1'),
    ]);
    res.json({
      divisions: deps.map((d) => d.department),
      units: units.map((d) => d.unit),
      today: u.todayStr(), // hospital date (the browser's clock or time zone may differ)
      settings,
      ready: flag.geofenceReady(settings),
      settings_updated: saved ? { by: saved.updated_by, at: u.toStamp(saved.updated_at) } : null,
      statuses: flag.STATUSES,
      weekdays: flag.WEEKDAYS,
      photo_retention_days: config.flag.photoRetentionDays,
      max_pin_attempts: config.flag.maxPinAttempts,
      import_columns: flag.IMPORT_COLUMNS,
    });
  });

  router.put('/flag/settings', can, async (req, res) => {
    const before = await flag.getSettings(db);
    const [s, err] = flag.cleanSettings(req.body || {}, before);
    if (err) throw new ValidationError(err);
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO flag_settings (id, data, updated_by, updated_at) VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`,
        [JSON.stringify(s), req.user.username],
      );
      if (JSON.stringify(s.schedule) !== JSON.stringify(before.schedule)) await flag.resetUpcoming(t);
    });
    res.json({ settings: s, ready: flag.geofenceReady(s) });
  });

  // ---------- Ceremonies ----------

  // Employees expected at every ceremony (others count only if they checked in)
  const expectedCount = async () => (await db.one('SELECT COUNT(*)::int AS n FROM employees WHERE active AND flag_required')).n;

  router.get('/flag/ceremonies', can, async (req, res) => {
    const month = String(req.query.month || u.todayStr().slice(0, 7));
    if (!MONTH_RE.test(month)) throw new ValidationError('Choose a month.');
    const first = `${month}-01`;
    const last = u.addDays(u.toDateStr(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 1)), -1);
    const settings = await flag.getSettings(db);
    const horizon = u.addDays(u.todayStr(), 62);
    if (first <= horizon) await flag.ensureCeremonies(db, settings, first, last < horizon ? last : horizon);
    const [rows, expected] = await Promise.all([
      db.query(
        `SELECT c.*,
           COUNT(k.id) FILTER (WHERE k.status = 'ON_TIME')::int AS on_time,
           COUNT(k.id) FILTER (WHERE k.status = 'LATE')::int AS late,
           COUNT(k.id) FILTER (WHERE k.status = 'EXCUSED')::int AS excused,
           COUNT(k.id) FILTER (WHERE k.status <> 'EXCUSED' AND e.active AND e.flag_required)::int AS present_expected,
           COUNT(k.id) FILTER (WHERE e.active AND e.flag_required)::int AS marked_expected
         FROM flag_ceremonies c LEFT JOIN flag_checkins k ON k.ceremony_id = c.id LEFT JOIN employees e ON e.id = k.employee_id
         WHERE c.ceremony_date BETWEEN $1 AND $2 GROUP BY c.id ORDER BY c.ceremony_date, c.starts_at`,
        [first, last],
      ),
      expectedCount(),
    ]);
    res.json({
      month,
      expected,
      ready: flag.geofenceReady(settings),
      rows: rows.map((c) => {
        const x = flag.presentCeremony(c);
        return {
          ...x,
          updated_by: c.updated_by,
          on_time: c.on_time,
          late: c.late,
          excused: c.excused,
          // Absent is only known once check-in has closed
          absent: x.phase === 'CLOSED' ? Math.max(0, expected - c.marked_expected) : null,
          not_yet: x.phase === 'OPEN' || x.phase === 'UPCOMING' ? Math.max(0, expected - c.marked_expected) : null,
        };
      }),
    });
  });

  function cleanCeremony(b) {
    if (!u.parseDate(b.date)) throw new ValidationError('Choose the date of the ceremony.');
    const x = { title: String(b.title || '').trim().toUpperCase().slice(0, 80) || 'FLAG CEREMONY', opens: b.opens, starts: b.starts, closes: b.closes };
    const err = flag.checkTimes(x, 'Times');
    if (err) throw new ValidationError(err);
    return { ...x, date: b.date };
  }

  // A special ceremony (e.g. flag lowering, Independence Day, a rescheduled flag raising)
  router.post('/flag/ceremonies', can, async (req, res) => {
    const x = cleanCeremony(req.body || {});
    if (x.date < u.todayStr()) throw new ValidationError('The date has passed.');
    const c = await db.one(
      `INSERT INTO flag_ceremonies (ceremony_date, slot, title, opens_at, starts_at, closes_at, source, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', $7) RETURNING *`,
      [x.date, `M-${flag.newToken().slice(0, 10)}`, x.title, x.opens, x.starts, x.closes, req.user.username],
    );
    res.status(201).json(flag.presentCeremony(c));
  });

  // Cancel or restore a ceremony (e.g. holiday, rain), or change its title and times
  router.patch('/flag/ceremonies/:id', can, async (req, res) => {
    const b = req.body || {};
    const c = await db.one('SELECT * FROM flag_ceremonies WHERE id = $1', [idParam(req.params.id)]);
    if (!c) throw fail(404, 'Ceremony not found.');
    let updated;
    const remarks = b.remarks === undefined ? undefined : String(b.remarks || '').trim().toUpperCase().slice(0, 300) || null;
    if (b.cancelled === false && c.moved_to_date) {
      throw new ValidationError(`This ceremony was moved to ${u.formatDateLong(c.moved_to_date)}. Cancel or move that one instead.`);
    }
    if (b.cancelled === undefined && b.opens === undefined && remarks !== undefined) {
      // Remarks only (e.g. bad weather), allowed before, during or after the ceremony
      updated = await db.one('UPDATE flag_ceremonies SET remarks = $1, updated_by = $2 WHERE id = $3 RETURNING *', [remarks, req.user.username, c.id]);
    } else if (b.cancelled !== undefined) {
      const reason = String(b.cancel_reason || '').trim().toUpperCase().slice(0, 200);
      if (b.cancelled && !reason) throw new ValidationError('Please give the reason, e.g. HOLIDAY, BAD WEATHER.');
      updated = await db.one('UPDATE flag_ceremonies SET cancelled = $1, cancel_reason = $2, updated_by = $3 WHERE id = $4 RETURNING *', [
        !!b.cancelled, b.cancelled ? reason : null, req.user.username, c.id,
      ]);
    } else {
      const x = cleanCeremony({ ...b, date: c.ceremony_date });
      // Edited weekly ceremonies are kept when the weekly schedule changes later
      updated = await db.one(
        `UPDATE flag_ceremonies SET title = $1, opens_at = $2, starts_at = $3, closes_at = $4, source = 'MANUAL', updated_by = $5,
           remarks = CASE WHEN $7 THEN $8 ELSE remarks END WHERE id = $6 RETURNING *`,
        [x.title, x.opens, x.starts, x.closes, req.user.username, c.id, remarks !== undefined, remarks ?? null],
      );
      // On-time / late is recomputed for phone check-ins when the start time moves
      const settings = await flag.getSettings(db);
      const late = new Date(u.localDateTime(updated.ceremony_date, updated.starts_at).getTime() + settings.grace_minutes * 60e3);
      await db.query(
        `UPDATE flag_checkins SET status = CASE WHEN checked_at > $2 THEN 'LATE' ELSE 'ON_TIME' END
         WHERE ceremony_id = $1 AND source = 'GPS' AND status IN ('ON_TIME', 'LATE')`,
        [c.id, late.toISOString()],
      );
    }
    res.json(flag.presentCeremony(updated));
  });

  // Move a ceremony to another date (e.g. the Monday is a holiday). The original date stays,
  // cancelled and marked as moved, so the weekly schedule does not create it again; excuses
  // already recorded move with it.
  router.post('/flag/ceremonies/:id/move', can, async (req, res) => {
    const b = req.body || {};
    const c = await db.one('SELECT * FROM flag_ceremonies WHERE id = $1', [idParam(req.params.id)]);
    if (!c) throw fail(404, 'Ceremony not found.');
    if (c.cancelled) throw new ValidationError('This ceremony is cancelled or was already moved.');
    if (flag.phase(c) !== 'UPCOMING') throw new ValidationError('Only ceremonies that have not started yet can be moved.');
    if (!u.parseDate(b.date)) throw new ValidationError('Choose the new date.');
    if (b.date === c.ceremony_date) throw new ValidationError('Choose a different date.');
    const reason = String(b.reason || '').trim().toUpperCase().slice(0, 200);
    if (!reason) throw new ValidationError('Please give the reason, e.g. HOLIDAY: BONIFACIO DAY.');
    const x = cleanCeremony({ date: b.date, title: c.title, opens: b.opens || c.opens_at, starts: b.starts || c.starts_at, closes: b.closes || c.closes_at });
    if (flag.phase({ ceremony_date: x.date, opens_at: x.opens, closes_at: x.closes }) === 'CLOSED') {
      throw new ValidationError('That date and time have already passed.');
    }
    await flag.ensureCeremonies(db, await flag.getSettings(db), x.date, x.date);
    if (await db.one('SELECT 1 FROM flag_ceremonies WHERE ceremony_date = $1 AND title = $2 AND NOT cancelled', [x.date, c.title])) {
      throw new ValidationError(`There is already a ${c.title} on ${u.formatDateLong(x.date)}.`);
    }
    const checkins = await db.query('SELECT status, source FROM flag_checkins WHERE ceremony_id = $1', [c.id]);
    if (checkins.some((k) => k.status !== 'EXCUSED')) throw new ValidationError('Employees have already checked in to this ceremony; it cannot be moved.');
    const moved = await db.tx(async (t) => {
      const n = await t.one(
        `INSERT INTO flag_ceremonies (ceremony_date, slot, title, opens_at, starts_at, closes_at, source, remarks, moved_from_date, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', $7, $8, $9) RETURNING *`,
        [x.date, `M-${flag.newToken().slice(0, 10)}`, c.title, x.opens, x.starts, x.closes, c.remarks, c.ceremony_date, req.user.username],
      );
      await t.query('UPDATE flag_ceremonies SET cancelled = TRUE, cancel_reason = $1, moved_to_date = $2, updated_by = $3 WHERE id = $4', [
        reason, x.date, req.user.username, c.id,
      ]);
      await t.query('UPDATE flag_checkins SET ceremony_id = $1 WHERE ceremony_id = $2', [n.id, c.id]);
      return n;
    });
    res.status(201).json(flag.presentCeremony(moved));
  });

  // Everyone expected at the ceremony, with their check-in, excuse or absence
  async function roster(id) {
    const c = await db.one('SELECT * FROM flag_ceremonies WHERE id = $1', [idParam(id)]);
    if (!c) throw fail(404, 'Ceremony not found.');
    const ceremony = flag.presentCeremony(c);
    const rows = await db.query(
      `SELECT e.*, k.id AS checkin_id, k.status, k.checked_at, k.source, k.accuracy_m, k.distance_m, k.remarks, k.created_by,
         EXISTS (SELECT 1 FROM flag_checkin_photos p WHERE p.checkin_id = k.id) AS has_photo
       FROM employees e LEFT JOIN flag_checkins k ON k.employee_id = e.id AND k.ceremony_id = $1
       WHERE (e.active AND e.flag_required) OR k.id IS NOT NULL
       ORDER BY e.department NULLS LAST, e.unit NULLS LAST, e.last_name, e.first_name`,
      [c.id],
    );
    const pending = ceremony.phase === 'CANCELLED' ? 'CANCELLED' : ceremony.phase === 'CLOSED' ? 'ABSENT' : 'NOT_YET';
    return {
      ceremony,
      rows: rows.map((r) => ({
        ...presentEmployee(r),
        checkin_id: r.checkin_id,
        status: r.status || pending,
        time: r.checked_at ? flag.hhmm(new Date(r.checked_at)) : null,
        source: r.source,
        accuracy_m: r.accuracy_m,
        distance_m: r.distance_m,
        remarks: r.remarks,
        marked_by: r.created_by,
        has_photo: !!r.has_photo,
      })),
    };
  }

  router.get('/flag/ceremonies/:id', can, async (req, res) => {
    const r = await roster(req.params.id);
    const settings = await flag.getSettings(db);
    res.json({ ...r, venue: settings.venue, hospital: config.hospitalName });
  });

  router.get('/flag/ceremonies/:id/export.csv', can, async (req, res) => {
    const { ceremony: c, rows } = await roster(req.params.id);
    const label = { ...flag.STATUSES, NOT_YET: 'Not yet', CANCELLED: 'Cancelled' };
    const csv = flag.toCsv([
      ['Date', 'Ceremony', 'Employee No.', 'Last Name', 'First Name', 'Middle Name', 'Position', 'Division', 'Unit', 'Status', 'Time', 'Recorded By', 'Distance (m)', 'Remarks'],
      ...rows.map((r) => [
        c.date, c.title, r.employee_no, r.last_name, r.first_name, r.middle_name || '', r.position || '', r.division || '', r.unit || '',
        label[r.status] || r.status, r.status === 'EXCUSED' ? '' : r.time || '', r.source === 'MANUAL' ? `STAFF (${r.marked_by})` : r.source === 'GPS' ? 'PHONE GPS' : '',
        r.distance_m ?? '', r.remarks || '',
      ]),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ZRMC-flag-ceremony-${c.date}.csv"`);
    res.end(csv);
  });

  // Staff mark an employee present, late or excused (e.g. on leave, on duty, GPS failed), or clear
  // a staff entry. Phone check-ins keep their GPS details when staff change the status.
  router.post('/flag/ceremonies/:id/mark', can, async (req, res) => {
    const b = req.body || {};
    const c = await db.one('SELECT * FROM flag_ceremonies WHERE id = $1', [idParam(req.params.id)]);
    if (!c) throw fail(404, 'Ceremony not found.');
    if (c.cancelled) throw new ValidationError('This ceremony was cancelled.');
    const status = MARKS.includes(b.status) ? b.status : null;
    if (!status) throw new ValidationError('Choose Present, Late, Excused or Clear.');
    const ph = flag.phase(c);
    if (ph === 'UPCOMING' && status !== 'EXCUSED') throw new ValidationError('Before the ceremony, employees can only be excused (e.g. approved leave).');
    const remarks = String(b.remarks || '').trim().toUpperCase().slice(0, 300);
    if (status !== 'CLEAR' && !remarks) throw new ValidationError('Please give the reason, e.g. ON APPROVED LEAVE, ON DUTY AT ER, GPS NOT WORKING.');
    const emp = await db.one('SELECT * FROM employees WHERE id = $1', [idParam(b.employee_id)]);
    if (!emp) throw fail(404, 'Employee not found.');
    const existing = await db.one('SELECT * FROM flag_checkins WHERE ceremony_id = $1 AND employee_id = $2', [c.id, emp.id]);
    if (status === 'CLEAR') {
      if (existing?.source === 'GPS') throw new ValidationError("A check-in from the employee's phone cannot be cleared; change its status instead.");
      if (existing) await db.query('DELETE FROM flag_checkins WHERE id = $1', [existing.id]);
      return res.json({ ok: true });
    }
    if (existing) {
      await db.query('UPDATE flag_checkins SET status = $1, remarks = $2, created_by = $3 WHERE id = $4', [status, remarks, req.user.username, existing.id]);
    } else {
      // Present/late entries by staff are timed at the ceremony start, not when staff typed them
      const at = status === 'EXCUSED' ? new Date() : u.localDateTime(c.ceremony_date, c.starts_at);
      await db.query(
        `INSERT INTO flag_checkins (ceremony_id, employee_id, status, checked_at, source, remarks, created_by) VALUES ($1, $2, $3, $4, 'MANUAL', $5, $6)`,
        [c.id, emp.id, status, at.toISOString(), remarks, req.user.username],
      );
    }
    res.json({ ok: true });
  });

  router.get('/flag/checkins/:id/photo', can, async (req, res) => {
    const p = await db.one('SELECT image, mime FROM flag_checkin_photos WHERE checkin_id = $1', [idParam(req.params.id)]);
    if (!p) return res.status(404).json({ error: 'No selfie (selfies are deleted after the retention period).' });
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(p.image);
  });

  // ---------- Summary (per employee, over a date range) ----------

  async function summary(q) {
    const today = u.todayStr();
    const from = u.parseDate(q.from) ? q.from : `${today.slice(0, 7)}-01`;
    const to = u.parseDate(q.to) ? q.to : today;
    if (from > to) throw new ValidationError('The start date is after the end date.');
    // Only ceremonies whose check-in has closed count
    const held = (await db.query('SELECT * FROM flag_ceremonies WHERE ceremony_date BETWEEN $1 AND $2 AND NOT cancelled ORDER BY ceremony_date, starts_at', [from, to]))
      .filter((c) => flag.phase(c) === 'CLOSED');
    const ids = held.map((c) => c.id);
    const conds = [['(e.active AND e.flag_required OR EXISTS (SELECT 1 FROM flag_checkins k WHERE k.employee_id = e.id AND k.ceremony_id = ANY(?::int[])))', ids]];
    if (q.division) conds.push(['e.department = ?', String(q.division)]);
    const { where, params } = whereClause(conds);
    const emps = await db.query(`SELECT e.* FROM employees e ${where} ORDER BY e.department NULLS LAST, e.unit NULLS LAST, e.last_name, e.first_name`, params);
    const checks = ids.length && emps.length
      ? await db.query('SELECT employee_id, ceremony_id, status FROM flag_checkins WHERE ceremony_id = ANY($1::int[]) AND employee_id = ANY($2::int[])', [ids, emps.map((e) => e.id)])
      : [];
    const byEmp = new Map();
    for (const k of checks) {
      if (!byEmp.has(k.employee_id)) byEmp.set(k.employee_id, new Map());
      byEmp.get(k.employee_id).set(k.ceremony_id, k.status);
    }
    const rows = emps.map((e) => {
      const mine = byEmp.get(e.id) || new Map();
      // Ceremonies held before the employee was added do not count against them
      const since = u.toDateStr(new Date(e.created_at));
      const expected = held.filter((c) => mine.has(c.id) || (e.active && e.flag_required && c.ceremony_date >= since));
      const t = { held: expected.length, on_time: 0, late: 0, excused: 0, absent: 0 };
      for (const c of expected) {
        const s = mine.get(c.id);
        if (s === 'ON_TIME') t.on_time++;
        else if (s === 'LATE') t.late++;
        else if (s === 'EXCUSED') t.excused++;
        else t.absent++;
      }
      const counted = t.held - t.excused;
      t.rate = counted ? Math.round(((t.on_time + t.late) / counted) * 100) : null;
      return { employee: presentEmployee(e), ...t };
    });
    return { from, to, ceremonies: held.length, rows };
  }

  router.get('/flag/summary', can, async (req, res) => res.json(await summary(req.query)));

  router.get('/flag/summary.csv', can, async (req, res) => {
    const { from, to, rows } = await summary(req.query);
    const csv = flag.toCsv([
      ['Employee No.', 'Last Name', 'First Name', 'Middle Name', 'Position', 'Division', 'Unit', 'Ceremonies', 'Present (on time)', 'Late', 'Excused', 'Absent', 'Attendance %'],
      ...rows.map(({ employee: e, ...t }) => [
        e.employee_no, e.last_name, e.first_name, e.middle_name || '', e.position || '', e.division || '', e.unit || '',
        t.held, t.on_time, t.late, t.excused, t.absent, t.rate ?? '',
      ]),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ZRMC-flag-ceremony-${from}-to-${to}.csv"`);
    res.end(csv);
  });

  // ---------- Employees ----------

  router.get('/flag/employees', can, async (req, res) => {
    const q = req.query;
    const conds = [];
    if (q.division) conds.push(['department = ?', String(q.division)]);
    if (q.active === '1') conds.push(['active']);
    if (q.active === '0') conds.push(['NOT active']);
    if (q.q) {
      const s = `%${String(q.q).trim()}%`;
      conds.push(['(employee_no ILIKE ? OR last_name ILIKE ? OR first_name ILIKE ? OR position ILIKE ? OR unit ILIKE ?)', s, s, s, s, s]);
    }
    const { where, params } = whereClause(conds);
    const rows = await db.query(`SELECT * FROM employees ${where} ORDER BY active DESC, last_name, first_name LIMIT 3000`, params);
    res.json({ rows: rows.map(presentEmployee) });
  });

  async function insertEmployee(t, v, pin, by) {
    if (await t.one('SELECT 1 FROM employees WHERE employee_no = $1', [v.employee_no])) {
      throw new ValidationError(`Employee no. ${v.employee_no} already exists.`);
    }
    return t.one(
      `INSERT INTO employees (employee_no, last_name, first_name, middle_name, position, department, unit, flag_required, pin_hash, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [v.employee_no, v.last_name, v.first_name, v.middle_name, v.position, v.department, v.unit, v.flag_required ?? true, auth.hashPassword(pin), by],
    );
  }

  router.post('/flag/employees', can, async (req, res) => {
    const b = req.body || {};
    const [v, err] = flag.cleanEmployee(b);
    if (err) throw new ValidationError(err);
    const pin = b.pin ? String(b.pin) : flag.randomPin();
    const bad = flag.checkPin(pin);
    if (bad) throw new ValidationError(bad);
    const e = await insertEmployee(db, v, pin, req.user.username);
    res.status(201).json({ ...presentEmployee(e), pin });
  });

  router.patch('/flag/employees/:id', can, async (req, res) => {
    const id = idParam(req.params.id);
    const before = await db.one('SELECT * FROM employees WHERE id = $1', [id]);
    if (!before) throw fail(404, 'Employee not found.');
    const [v, err] = flag.cleanEmployee(req.body || {}, { partial: true });
    if (err) throw new ValidationError(err);
    if (v.employee_no && v.employee_no !== before.employee_no && (await db.one('SELECT 1 FROM employees WHERE employee_no = $1', [v.employee_no]))) {
      throw new ValidationError(`Employee no. ${v.employee_no} already exists.`);
    }
    const next = { ...before, ...v };
    if (req.body?.active !== undefined) next.active = !!req.body.active;
    // Deactivating or changing the employee no. signs them out of their phone
    const revoke = next.active !== before.active || next.employee_no !== before.employee_no;
    const e = await db.one(
      `UPDATE employees SET employee_no = $1, last_name = $2, first_name = $3, middle_name = $4, position = $5, department = $6,
         flag_required = $7, active = $8, updated_by = $9, updated_at = now(),
         session_version = session_version + CASE WHEN $10 THEN 1 ELSE 0 END, unit = $12 WHERE id = $11 RETURNING *`,
      [next.employee_no, next.last_name, next.first_name, next.middle_name, next.position, next.department, next.flag_required, next.active, req.user.username, revoke, id, next.unit],
    );
    res.json(presentEmployee(e));
  });

  // Sets a new PIN (random if none given), unlocks the employee no. and signs them out of their phone
  router.post('/flag/employees/:id/pin', can, async (req, res) => {
    const pin = req.body?.pin ? String(req.body.pin) : flag.randomPin();
    const bad = flag.checkPin(pin);
    if (bad) throw new ValidationError(bad);
    const e = await db.one(
      `UPDATE employees SET pin_hash = $1, failed_pins = 0, locked_until = NULL, session_version = session_version + 1,
         updated_by = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [auth.hashPassword(pin), req.user.username, idParam(req.params.id)],
    );
    if (!e) throw fail(404, 'Employee not found.');
    res.json({ ...presentEmployee(e), pin });
  });

  // Adds many employees at once from a pasted list; each gets a random PIN shown once
  router.post('/flag/employees/import', can, async (req, res) => {
    const list = flag.parseCsv(req.body?.csv);
    if (!list.length) throw new ValidationError(`Paste at least one employee: ${flag.IMPORT_COLUMNS.join(', ')}.`);
    if (list.length > 2000) throw new ValidationError('Import at most 2,000 employees at a time.');
    const created = await db.tx(async (t) => {
      const out = [];
      for (const [i, row] of list.entries()) {
        const [v, err] = flag.cleanEmployee(row);
        if (err) throw new ValidationError(`Line ${i + 1} (${row.employee_no || 'no employee no.'}): ${err} Nothing was imported.`);
        const pin = flag.randomPin();
        try {
          out.push({ ...presentEmployee(await insertEmployee(t, v, pin, req.user.username)), pin });
        } catch (e) {
          if (e instanceof ValidationError) e.message = `Line ${i + 1}: ${e.message} Nothing was imported.`;
          throw e;
        }
      }
      return out;
    });
    res.status(201).json({ rows: created });
  });
};
