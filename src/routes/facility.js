// Facility portal API (/api/facility): RHUs, barangay health centers and other hospitals send
// referrals to ZRMC and follow their status. Facility accounts are separate from hospital staff
// accounts and can only see their own facility's referrals.
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const ref = require('../referrals');
const u = require('../util');
const { ValidationError, rateLimit } = require('./public');

const COOKIE = 'hs_facility';
// A different signing secret from staff sessions, so one kind of token can never pass as the other
const secret = () => `${config.sessionSecret}|facility`;

module.exports = function facilityRoutes(db) {
  const router = express.Router();
  const json = express.json({ limit: '6mb' }); // referrals can carry attachments

  const sessionCookie = (req, user) =>
    `${COOKIE}=${auth.createToken(user.username, user.session_version, secret())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
      auth.SESSION_HOURS * 3600
    }${req.secure ? '; Secure' : ''}`;

  router.post('/login', json, rateLimit({ windowMs: 10 * 60e3, max: config.loginRateLimit }), async (req, res) => {
    const { username, password } = req.body || {};
    const user = await db.one(
      `SELECT fu.*, f.active AS facility_active FROM facility_users fu JOIN facilities f ON f.id = fu.facility_id
       WHERE lower(fu.username) = lower($1)`,
      [String(username || '').trim()],
    );
    if (!user || !auth.verifyPassword(String(password || ''), user.password_hash)) {
      // A ZRMC staff account typed here by mistake: say where it belongs (only once the password is right)
      const staff = await db.one('SELECT password_hash FROM admins WHERE lower(username) = lower($1) AND active', [String(username || '').trim()]);
      if (staff && auth.verifyPassword(String(password || ''), staff.password_hash)) {
        return res.status(401).json({ error: 'This is a ZRMC staff account. Staff manage referrals in the Staff Portal (/admin → Referrals). This page is only for referring facilities.' });
      }
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.active || !user.facility_active) return res.status(403).json({ error: 'This account has been deactivated. Please contact ZRMC.' });
    await db.query('UPDATE facility_users SET last_login_at = now() WHERE id = $1', [user.id]);
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    res.json({ username: user.username });
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Everything below needs a signed-in, active facility user
  router.use(async (req, res, next) => {
    const token = auth.readToken(auth.parseCookies(req.headers.cookie)[COOKIE], secret());
    const user =
      token &&
      (await db.one(
        `SELECT fu.*, f.name AS facility_name, f.type AS facility_type, f.active AS facility_active
         FROM facility_users fu JOIN facilities f ON f.id = fu.facility_id WHERE fu.username = $1`,
        [token.username],
      ));
    if (!user || !user.active || !user.facility_active || user.session_version !== token.version) {
      return res.status(401).json({ error: 'Please log in.' });
    }
    req.fuser = user;
    next();
  });

  router.get('/me', async (req, res) => {
    const f = req.fuser;
    res.json({
      username: f.username,
      full_name: f.full_name,
      facility: { id: f.facility_id, name: f.facility_name, type: f.facility_type, type_label: ref.FACILITY_TYPES[f.facility_type] },
      departments: await ref.departments(db),
      urgency: ref.URGENCY,
      statuses: ref.STATUSES,
    });
  });

  router.post('/password', json, async (req, res) => {
    const { current, next: pw } = req.body || {};
    if (!auth.verifyPassword(String(current || ''), req.fuser.password_hash)) throw new ValidationError('Current password is incorrect.');
    if (String(pw || '').length < 8) throw new ValidationError('New password must be at least 8 characters.');
    const user = await db.one(
      'UPDATE facility_users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING *',
      [auth.hashPassword(pw), req.fuser.id],
    );
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    res.json({ ok: true });
  });

  router.get('/referrals', async (req, res) => {
    const rows = await db.query(`${ref.SELECT} WHERE r.facility_id = $1 ORDER BY r.created_at DESC LIMIT 300`, [req.fuser.facility_id]);
    res.json({ rows: await Promise.all(rows.map((r) => ref.present(db, r, { attachments: false }))) });
  });

  async function ownReferral(req) {
    const r = await db.one(`${ref.SELECT} WHERE r.id = $1 AND r.facility_id = $2`, [Number(req.params.id), req.fuser.facility_id]);
    if (!r) {
      const err = new ValidationError('Referral not found.');
      err.status = 404;
      throw err;
    }
    return r;
  }

  router.get('/referrals/:id', async (req, res) => {
    res.json(await ref.present(db, await ownReferral(req)));
  });

  router.get('/referrals/:id/attachments/:aid', async (req, res) => {
    const r = await ownReferral(req);
    const a = await db.one('SELECT filename, mime, data FROM referral_attachments WHERE id = $1 AND referral_id = $2', [Number(req.params.aid), r.id]);
    if (!a) return res.status(404).json({ error: 'Attachment not found.' });
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', `inline; filename="${a.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(a.data));
  });

  router.post('/referrals', json, async (req, res) => {
    let v;
    let files;
    try {
      v = await ref.cleanReferral(db, req.body || {});
      files = ref.decodeAttachments(req.body?.attachments);
    } catch (err) {
      if (err instanceof ref.ReferralError) throw new ValidationError(err.message);
      throw err;
    }
    const row = await db.tx(async (t) => {
      let refNo;
      do refNo = u.makeRef('F');
      while (await t.one('SELECT 1 FROM referrals WHERE ref_no = $1', [refNo]));
      const cols = Object.keys(v);
      const inserted = await t.one(
        `INSERT INTO referrals (ref_no, facility_id, created_by, ${cols.join(', ')})
         VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
        [refNo, req.fuser.facility_id, req.fuser.username, ...cols.map((k) => v[k])],
      );
      for (const f of files) {
        await t.query('INSERT INTO referral_attachments (referral_id, filename, mime, data) VALUES ($1, $2, $3, $4)', [inserted.id, f.name, f.mime, f.buf]);
      }
      return t.one(`${ref.SELECT} WHERE r.id = $1`, [inserted.id]);
    });
    res.status(201).json(await ref.present(db, row));
  });

  // A facility can withdraw a referral that ZRMC has not acted on yet
  router.post('/referrals/:id/cancel', json, async (req, res) => {
    const r = await ownReferral(req);
    if (!['SENT', 'RECEIVED'].includes(r.status)) throw new ValidationError('This referral has already been acted on by ZRMC. Please call ZRMC to cancel it.');
    await db.query("UPDATE referrals SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [r.id]);
    res.json(await ref.present(db, await db.one(`${ref.SELECT} WHERE r.id = $1`, [r.id])));
  });

  return router;
};
