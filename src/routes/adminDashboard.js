// Staff panel dashboard: one panel per module, only for the modules the signed-in user can access
// (see access() in routes/admin.js). Registered on the admin router after sign-in.
const config = require('../config');
const clinics = require('../clinics');
const flag = require('../flag');
const modules = require('../modules');
const referrals = require('../referrals');
const u = require('../util');

module.exports = function registerDashboard(router, { db, access }) {
  router.get('/dashboard', async (req, res) => {
    const a = access(req.user);
    const today = u.todayStr();
    const out = {
      today,
      user: { name: req.user.full_name || req.user.username, role: req.user.role },
      access: a,
    };
    const jobs = [];
    if (a.records) jobs.push(recordsPanel(req.user, today).then((x) => (out.records = x)));
    if (a.opd) jobs.push(opdPanel(today).then((x) => (out.opd = x)));
    if (a.referrals) jobs.push(referralsPanel(today).then((x) => (out.referrals = x)));
    if (a.attendance) jobs.push(flagPanel(today).then((x) => (out.flag = x)));
    if (a.records || a.opd) jobs.push(smsPanel(a, req.user).then((x) => (out.sms = x)));
    if (req.user.role === 'ADMIN') jobs.push(adminPanel().then((x) => (out.admin = x)));
    await Promise.all(jobs);
    res.json(out);
  });

  async function recordsPanel(user, today) {
    const [c, pickups] = await Promise.all([
      db.one(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
           COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
           COUNT(*) FILTER (WHERE status = 'READY')::int AS ready,
           COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS submitted_today,
           COUNT(*) FILTER (WHERE status = 'RELEASED' AND updated_at >= $1::timestamptz)::int AS released_today,
           COUNT(*) FILTER (WHERE status = 'READY' AND pickup_date < $2)::int AS not_claimed,
           COUNT(*) FILTER (WHERE copy_type = 'DIGITAL' AND id_status = 'PENDING' AND status NOT IN ('CANCELLED','REJECTED','RELEASED'))::int AS ids_to_check,
           COUNT(*) FILTER (WHERE copy_type = 'DIGITAL' AND id_status = 'VERIFIED' AND emailed_at IS NULL AND status NOT IN ('CANCELLED','REJECTED','RELEASED'))::int AS to_email,
           COUNT(*) FILTER (WHERE assigned_to = $3 AND status IN ('PENDING','PROCESSING','READY'))::int AS mine
         FROM record_requests`,
        [u.localDateTime(today, '00:00').toISOString(), today, user.username], // hospital-time midnight
      ),
      db.query(
        `SELECT r.ref_no, r.patient_last, r.patient_first, r.status, r.copy_type,
           COALESCE((SELECT string_agg(i.record_type, ',') FROM record_request_items i WHERE i.request_id = r.id), '') AS types
         FROM record_requests r WHERE r.pickup_date = $1 AND r.status NOT IN ('CANCELLED','REJECTED') ORDER BY r.status, r.patient_last LIMIT 30`,
        [today],
      ),
    ]);
    return { counts: c, pickups_today: pickups };
  }

  async function opdPanel(today) {
    const in7 = u.addDays(today, 7);
    const [t, byClinic, week, list, names] = await Promise.all([
      db.one(
        `SELECT COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS total,
           COUNT(*) FILTER (WHERE status = 'BOOKED')::int AS booked,
           COUNT(*) FILTER (WHERE status = 'CHECKED_IN')::int AS checked_in,
           COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show
         FROM appointments WHERE appt_date = $1`,
        [today],
      ),
      db.query(
        `SELECT department, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('CHECKED_IN','COMPLETED'))::int AS seen
         FROM appointments WHERE appt_date = $1 AND status <> 'CANCELLED' GROUP BY department ORDER BY total DESC`,
        [today],
      ),
      db.query(
        `SELECT appt_date AS date, COUNT(*)::int AS total FROM appointments
         WHERE appt_date > $1 AND appt_date <= $2 AND status = 'BOOKED' GROUP BY appt_date ORDER BY appt_date`,
        [today, in7],
      ),
      db.query(
        `SELECT ref_no, appt_time, patient_last, patient_first, department, status FROM appointments
         WHERE appt_date = $1 AND status <> 'CANCELLED' ORDER BY appt_time, patient_last LIMIT 40`,
        [today],
      ),
      clinics.clinicNames(db),
    ]);
    const name = (code) => names.get(code) || code;
    // Every day of the coming week, including days with no bookings
    const byDate = new Map(week.map((w) => [w.date, w.total]));
    const next7 = Array.from({ length: 7 }, (_, i) => u.addDays(today, i + 1)).map((d) => ({ date: d, total: byDate.get(d) || 0 }));
    return {
      today: t,
      by_clinic: byClinic.map((c) => ({ ...c, name: name(c.department) })),
      next7,
      list: list.map((x) => ({ ...x, department_name: name(x.department) })),
    };
  }

  async function referralsPanel(today) {
    const month = u.localDateTime(`${today.slice(0, 7)}-01`, '00:00').toISOString(); // hospital time
    const [c, waiting] = await Promise.all([
      db.one(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('SENT','RECEIVED') AND urgency = 'EMERGENCY')::int AS emergency,
           COUNT(*) FILTER (WHERE status IN ('SENT','RECEIVED') AND urgency = 'URGENT')::int AS urgent,
           COUNT(*) FILTER (WHERE status IN ('SENT','RECEIVED') AND urgency = 'ROUTINE')::int AS routine,
           COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int AS awaiting_arrival,
           COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS month_received,
           COUNT(*) FILTER (WHERE status = 'SEEN' AND seen_at >= $1::timestamptz)::int AS month_seen
         FROM referrals`,
        [month],
      ),
      db.query(
        `SELECT r.ref_no, r.urgency, r.status, r.department, r.patient_last, r.patient_first, r.created_at, f.name AS facility
         FROM referrals r JOIN facilities f ON f.id = r.facility_id
         WHERE r.status IN ('SENT','RECEIVED')
         ORDER BY CASE r.urgency WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, r.created_at LIMIT 8`,
      ),
    ]);
    return {
      counts: c,
      waiting: waiting.map((w) => ({ ...w, created_at: u.toStamp(w.created_at), urgency_label: referrals.URGENCY[w.urgency] || w.urgency })),
    };
  }

  async function flagPanel(today) {
    const settings = await flag.getSettings(db);
    await flag.ensureCeremonies(db, settings, today, u.addDays(today, 14));
    const [emp, todays, next, last] = await Promise.all([
      db.one('SELECT COUNT(*) FILTER (WHERE active AND flag_required)::int AS expected, COUNT(*) FILTER (WHERE active AND pin_must_change)::int AS default_pin FROM employees'),
      db.query('SELECT * FROM flag_ceremonies WHERE ceremony_date = $1 ORDER BY starts_at', [today]),
      db.one('SELECT * FROM flag_ceremonies WHERE ceremony_date > $1 AND NOT cancelled ORDER BY ceremony_date, starts_at LIMIT 1', [today]),
      db.query('SELECT * FROM flag_ceremonies WHERE ceremony_date <= $1 AND NOT cancelled ORDER BY ceremony_date DESC, starts_at DESC LIMIT 5', [today]),
    ]);
    const counts = async (id) =>
      db.one(
        `SELECT COUNT(*) FILTER (WHERE k.status = 'ON_TIME' AND e.active AND e.flag_required)::int AS present,
           COUNT(*) FILTER (WHERE k.status = 'EXCUSED' AND e.active AND e.flag_required)::int AS excused
         FROM flag_checkins k JOIN employees e ON e.id = k.employee_id WHERE k.ceremony_id = $1`,
        [id],
      );
    const withCounts = async (c) => {
      const n = await counts(c.id);
      const counted = emp.expected - n.excused;
      return { ...flag.presentCeremony(c), ...n, not_yet: Math.max(0, emp.expected - n.present - n.excused), rate: counted > 0 ? Math.round((n.present / counted) * 100) : null };
    };
    const closed = last.find((c) => flag.phase(c) === 'CLOSED');
    return {
      ready: flag.geofenceReady(settings),
      expected: emp.expected,
      default_pin: emp.default_pin,
      today: await Promise.all(todays.map(withCounts)),
      next: next ? flag.presentCeremony(next) : null,
      last: closed ? await withCounts(closed) : null,
    };
  }

  async function smsPanel(a, user) {
    const kinds = [a.records && 'RECORD_%', a.opd && 'APPT_%'].filter(Boolean);
    const r = await db.one(
      `SELECT COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, COUNT(*)::int AS sent
       FROM sms_log WHERE created_at >= now() - interval '7 days' AND kind LIKE ANY($1::text[])`,
      [kinds],
    );
    return { ...r, provider: config.sms.provider, test_mode: config.sms.provider === 'console', role: user.role };
  }

  async function adminPanel() {
    const [mods, users] = await Promise.all([
      modules.getSettings(db),
      db.one("SELECT COUNT(*) FILTER (WHERE active)::int AS active, COUNT(*) FILTER (WHERE active AND role = 'ADMIN')::int AS admins FROM admins"),
    ]);
    const all = modules.MODULES.flatMap((m) => [m, ...m.subs]);
    return {
      modules_off: all.filter((m) => !modules.isOn(mods, m.key)).map((m) => m.name),
      users,
    };
  }
};
