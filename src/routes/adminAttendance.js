// Staff panel: Attendance Monitoring. Registered on the admin router after sign-in (see
// routes/admin.js); needs the Attendance permission. Covers employees, the daily board, time logs
// with manual corrections, kiosk devices, the monthly DTR (CSC Form No. 48) and a summary export.
const config = require('../config');
const auth = require('../auth');
const att = require('../attendance');
const u = require('../util');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

module.exports = function registerAttendanceRoutes(router, { db, requireAccess, ValidationError, whereClause }) {
  const can = requireAccess('attendance');
  const notFound = (what) => {
    const err = new ValidationError(`${what} not found.`);
    err.status = 404;
    return err;
  };

  const presentEmployee = (e) => ({
    id: e.id,
    employee_no: e.employee_no,
    last_name: e.last_name,
    first_name: e.first_name,
    middle_name: e.middle_name,
    name: att.fullName(e),
    position: e.position,
    department: e.department,
    shift_start: e.shift_start,
    shift_end: e.shift_end,
    active: e.active,
    locked: !!(e.locked_until && new Date(e.locked_until) > new Date()),
    updated_by: e.updated_by,
    updated_at: u.toStamp(e.updated_at),
  });

  const presentLog = (l) => ({
    id: l.id,
    employee_id: l.employee_id,
    employee_no: l.employee_no,
    name: l.last_name ? att.fullName(l) : undefined,
    department: l.department,
    kind: l.kind,
    date: u.toDateStr(new Date(l.logged_at)),
    time: att.hhmm(new Date(l.logged_at)),
    source: l.source,
    kiosk: l.kiosk_name || null,
    reason: l.reason,
    created_by: l.created_by,
    has_photo: !!l.has_photo,
    voided: !!l.voided_at,
    voided_by: l.voided_by,
    void_reason: l.void_reason,
  });

  const monthParam = (v) => {
    const month = String(v || u.todayStr().slice(0, 7));
    if (!MONTH_RE.test(month)) throw new ValidationError('Choose a month.');
    return month;
  };

  // ---------- Options ----------

  router.get('/attendance/options', can, async (req, res) => {
    const deps = await db.query("SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department <> '' ORDER BY 1");
    res.json({
      departments: deps.map((d) => d.department),
      today: u.todayStr(), // hospital date (the browser's clock or time zone may differ)
      shift_start: config.attendance.shiftStart,
      shift_end: config.attendance.shiftEnd,
      grace_minutes: config.attendance.graceMinutes,
      photo_retention_days: config.attendance.photoRetentionDays,
      import_columns: att.IMPORT_COLUMNS,
    });
  });

  // ---------- Today ----------

  router.get('/attendance/today', can, async (req, res) => {
    const conds = [['e.active']];
    if (req.query.department) conds.push(['e.department = ?', String(req.query.department)]);
    const { where, params } = whereClause(conds);
    const emps = await db.query(`SELECT * FROM employees e ${where} ORDER BY e.last_name, e.first_name`, params);
    const since = new Date(Date.now() - att.MAX_SHIFT_HOURS * 3600e3);
    const logs = emps.length
      ? await db.query(
          `SELECT id, employee_id, kind, logged_at, source FROM attendance_logs
           WHERE employee_id = ANY($1::int[]) AND voided_at IS NULL AND logged_at >= $2 ORDER BY logged_at`,
          [emps.map((e) => e.id), since.toISOString()],
        )
      : [];
    const today = u.todayStr();
    const rows = emps.map((e) => {
      const mine = logs.filter((l) => l.employee_id === e.id);
      const last = mine[mine.length - 1];
      const day = att.dtrDay(e, today, att.pairSessions(mine).filter((s) => s.date === today));
      const firstInToday = mine.find((l) => l.kind === 'IN' && u.toDateStr(new Date(l.logged_at)) === today);
      return {
        ...presentEmployee(e),
        status: !last ? 'NONE' : last.kind === 'IN' ? 'IN' : 'OUT',
        last_time: last ? att.hhmm(new Date(last.logged_at)) : null,
        last_date: last ? u.toDateStr(new Date(last.logged_at)) : null,
        first_in: firstInToday ? att.hhmm(new Date(firstInToday.logged_at)) : null,
        late: day.late,
      };
    });
    res.json({
      date: today,
      rows,
      counts: {
        employees: rows.length,
        in: rows.filter((r) => r.status === 'IN').length,
        timed_in_today: rows.filter((r) => r.first_in).length,
        late: rows.filter((r) => r.late).length,
      },
    });
  });

  // ---------- Logs ----------

  const LOG_SELECT = `SELECT l.*, e.employee_no, e.last_name, e.first_name, e.middle_name, e.department, k.name AS kiosk_name,
      EXISTS (SELECT 1 FROM attendance_photos p WHERE p.log_id = l.id) AS has_photo
    FROM attendance_logs l JOIN employees e ON e.id = l.employee_id LEFT JOIN attendance_kiosks k ON k.id = l.kiosk_id`;

  router.get('/attendance/logs', can, async (req, res) => {
    const q = req.query;
    const from = u.parseDate(q.from) ? q.from : u.todayStr();
    const to = u.parseDate(q.to) ? q.to : from;
    const conds = [
      ['l.logged_at >= ?', u.localDateTime(from, '00:00').toISOString()],
      ['l.logged_at < ?', u.localDateTime(u.addDays(to, 1), '00:00').toISOString()],
    ];
    if (q.department) conds.push(['e.department = ?', String(q.department)]);
    if (q.employee_id) conds.push(['l.employee_id = ?', Number(q.employee_id)]);
    if (q.source) conds.push(['l.source = ?', String(q.source)]);
    if (q.q) {
      const s = `%${String(q.q).trim()}%`;
      conds.push(['(e.employee_no ILIKE ? OR e.last_name ILIKE ? OR e.first_name ILIKE ?)', s, s, s]);
    }
    const { where, params } = whereClause(conds);
    const rows = await db.query(`${LOG_SELECT} ${where} ORDER BY l.logged_at DESC LIMIT 2000`, params);
    res.json({ rows: rows.map(presentLog), from, to });
  });

  // Staff add a missed time-in/out (e.g. kiosk down, official business), with the reason
  router.post('/attendance/logs', can, async (req, res) => {
    const b = req.body || {};
    const emp = await db.one('SELECT * FROM employees WHERE id = $1', [Number(b.employee_id) || 0]);
    if (!emp) throw new ValidationError('Choose an employee.');
    const kind = ['IN', 'OUT'].includes(b.kind) ? b.kind : null;
    if (!kind) throw new ValidationError('Choose Time In or Time Out.');
    if (!u.parseDate(b.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) throw new ValidationError('Enter the date and time.');
    const at = u.localDateTime(b.date, b.time);
    if (at > new Date()) throw new ValidationError('The time cannot be in the future.');
    const reason = String(b.reason || '').trim().toUpperCase().slice(0, 300);
    if (!reason) throw new ValidationError('Please give the reason for the manual entry (e.g. kiosk not working, official business).');
    const row = await db.one(
      "INSERT INTO attendance_logs (employee_id, kind, logged_at, source, reason, created_by) VALUES ($1, $2, $3, 'MANUAL', $4, $5) RETURNING id",
      [emp.id, kind, at.toISOString(), reason, req.user.username],
    );
    res.status(201).json(presentLog(await db.one(`${LOG_SELECT} WHERE l.id = $1`, [row.id])));
  });

  // Entries are never deleted; a wrong one is voided with the reason and kept for audit
  router.post('/attendance/logs/:id/void', can, async (req, res) => {
    const reason = String(req.body?.reason || '').trim().toUpperCase().slice(0, 300);
    if (!reason) throw new ValidationError('Please give the reason for voiding this entry.');
    const row = await db.one(
      'UPDATE attendance_logs SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3 AND voided_at IS NULL RETURNING id',
      [req.user.username, reason, /^\d+$/.test(req.params.id) ? Number(req.params.id) : 0],
    );
    if (!row) throw notFound('Entry');
    res.json(presentLog(await db.one(`${LOG_SELECT} WHERE l.id = $1`, [row.id])));
  });

  router.get('/attendance/logs/:id/photo', can, async (req, res) => {
    const p = /^\d+$/.test(req.params.id) && (await db.one('SELECT image, mime FROM attendance_photos WHERE log_id = $1', [Number(req.params.id)]));
    if (!p) return res.status(404).json({ error: 'No photo (photos are deleted after the retention period).' });
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(p.image);
  });

  // ---------- Employees ----------

  router.get('/attendance/employees', can, async (req, res) => {
    const q = req.query;
    const conds = [];
    if (q.department) conds.push(['department = ?', String(q.department)]);
    if (q.active === '1') conds.push(['active']);
    if (q.active === '0') conds.push(['NOT active']);
    if (q.q) {
      const s = `%${String(q.q).trim()}%`;
      conds.push(['(employee_no ILIKE ? OR last_name ILIKE ? OR first_name ILIKE ? OR position ILIKE ?)', s, s, s, s]);
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
      `INSERT INTO employees (employee_no, last_name, first_name, middle_name, position, department, shift_start, shift_end, pin_hash, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [v.employee_no, v.last_name, v.first_name, v.middle_name, v.position, v.department, v.shift_start, v.shift_end, auth.hashPassword(pin), by],
    );
  }

  router.post('/attendance/employees', can, async (req, res) => {
    const b = req.body || {};
    const [v, err] = att.cleanEmployee(b);
    if (err) throw new ValidationError(err);
    const pin = b.pin ? String(b.pin) : att.randomPin();
    const bad = att.checkPin(pin);
    if (bad) throw new ValidationError(bad);
    const e = await insertEmployee(db, v, pin, req.user.username);
    res.status(201).json({ ...presentEmployee(e), pin });
  });

  router.patch('/attendance/employees/:id', can, async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : 0;
    const before = await db.one('SELECT * FROM employees WHERE id = $1', [id]);
    if (!before) throw notFound('Employee');
    const [v, err] = att.cleanEmployee(req.body || {}, { partial: true });
    if (err) throw new ValidationError(err);
    if (v.employee_no && v.employee_no !== before.employee_no && (await db.one('SELECT 1 FROM employees WHERE employee_no = $1', [v.employee_no]))) {
      throw new ValidationError(`Employee no. ${v.employee_no} already exists.`);
    }
    const next = { ...before, ...v };
    if (req.body?.active !== undefined) next.active = !!req.body.active;
    const e = await db.one(
      `UPDATE employees SET employee_no = $1, last_name = $2, first_name = $3, middle_name = $4, position = $5, department = $6,
         shift_start = $7, shift_end = $8, active = $9, updated_by = $10, updated_at = now() WHERE id = $11 RETURNING *`,
      [next.employee_no, next.last_name, next.first_name, next.middle_name, next.position, next.department, next.shift_start, next.shift_end, next.active, req.user.username, id],
    );
    res.json(presentEmployee(e));
  });

  // Sets a new PIN (random if none given) and unlocks the employee number
  router.post('/attendance/employees/:id/pin', can, async (req, res) => {
    const pin = req.body?.pin ? String(req.body.pin) : att.randomPin();
    const bad = att.checkPin(pin);
    if (bad) throw new ValidationError(bad);
    const e = await db.one(
      'UPDATE employees SET pin_hash = $1, failed_pins = 0, locked_until = NULL, updated_by = $2, updated_at = now() WHERE id = $3 RETURNING *',
      [auth.hashPassword(pin), req.user.username, /^\d+$/.test(req.params.id) ? Number(req.params.id) : 0],
    );
    if (!e) throw notFound('Employee');
    res.json({ ...presentEmployee(e), pin });
  });

  // Adds many employees at once from a pasted list; each gets a random PIN shown once
  router.post('/attendance/employees/import', can, async (req, res) => {
    const list = att.parseCsv(req.body?.csv);
    if (!list.length) throw new ValidationError(`Paste at least one employee: ${att.IMPORT_COLUMNS.join(', ')}.`);
    if (list.length > 2000) throw new ValidationError('Import at most 2,000 employees at a time.');
    const shift = req.body?.shifting ? { shifting: true } : {};
    const created = await db.tx(async (t) => {
      const out = [];
      for (const [i, row] of list.entries()) {
        const [v, err] = att.cleanEmployee({ ...row, ...shift });
        if (err) throw new ValidationError(`Line ${i + 1} (${row.employee_no || 'no employee no.'}): ${err}`);
        const pin = att.randomPin();
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

  // ---------- Kiosks ----------

  router.get('/attendance/kiosks', can, async (req, res) => {
    const rows = await db.query('SELECT id, name, require_photo, active, created_by, created_at, last_seen_at FROM attendance_kiosks ORDER BY active DESC, name');
    res.json({ rows: rows.map((k) => ({ ...k, created_at: u.toStamp(k.created_at), last_seen_at: u.toStamp(k.last_seen_at) })) });
  });

  router.patch('/attendance/kiosks/:id', can, async (req, res) => {
    const b = req.body || {};
    const k = await db.one(
      `UPDATE attendance_kiosks SET active = COALESCE($1, active), require_photo = COALESCE($2, require_photo),
         name = COALESCE($3, name) WHERE id = $4 RETURNING id`,
      [
        b.active === undefined ? null : !!b.active,
        b.require_photo === undefined ? null : !!b.require_photo,
        b.name ? String(b.name).trim().toUpperCase().slice(0, 80) : null,
        /^\d+$/.test(req.params.id) ? Number(req.params.id) : 0,
      ],
    );
    if (!k) throw notFound('Kiosk');
    res.json({ ok: true });
  });

  // ---------- DTR and monthly summary ----------

  async function employeesFor(q) {
    if (q.employee_id) {
      const e = await db.one('SELECT * FROM employees WHERE id = $1', [Number(q.employee_id) || 0]);
      if (!e) throw notFound('Employee');
      return [e];
    }
    const conds = [['active']];
    if (q.department) conds.push(['department = ?', String(q.department)]);
    const { where, params } = whereClause(conds);
    return db.query(`SELECT * FROM employees ${where} ORDER BY department NULLS LAST, last_name, first_name`, params);
  }

  async function monthReport(q) {
    const month = monthParam(q.month);
    const emps = await employeesFor(q);
    const logs = await att.logsForMonth(db, emps.map((e) => e.id), month);
    return {
      month,
      rows: emps.map((e) => ({ employee: presentEmployee(e), ...att.dtrMonth(e, month, logs.get(e.id)) })),
    };
  }

  router.get('/attendance/dtr', can, async (req, res) => {
    const r = await monthReport(req.query);
    if (r.rows.length > 500) throw new ValidationError('Too many employees; choose a department.');
    res.json({ ...r, hospital: config.hospitalName });
  });

  router.get('/attendance/summary.csv', can, async (req, res) => {
    const { month, rows } = await monthReport(req.query);
    const csv = att.toCsv([
      ['Employee No.', 'Last Name', 'First Name', 'Middle Name', 'Position', 'Department', 'Official Hours', 'Days Present',
        'Times Late', 'Tardiness (min)', 'Undertime (min)', 'Missing Time-in/out', 'Hours Worked'],
      ...rows.map(({ employee: e, totals: t }) => [
        e.employee_no, e.last_name, e.first_name, e.middle_name || '', e.position || '', e.department || '',
        e.shift_start ? `${e.shift_start}-${e.shift_end}` : 'SHIFTING',
        t.days_present, t.late_count, t.late, t.undertime, t.missing, (t.worked / 60).toFixed(2),
      ]),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ZRMC-attendance-${month}.csv"`);
    res.end(csv);
  });
};
